/* ---------------------------------------------------------------------
 * Jira OAuth 2.0 (3LO) connect (SPEC §7.26, issue #226): the upgrade path
 * over `./jira-connect.ts`'s API-token connect (#225), against Atlassian's
 * documented 3LO endpoints —
 *
 *   - Authorize:            GET  https://auth.atlassian.com/authorize
 *   - Token exchange/refresh: POST https://auth.atlassian.com/oauth/token
 *     (`developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/`,
 *     `developer.atlassian.com/cloud/oauth/getting-started/refresh-tokens/`)
 *   - Accessible resources:  GET  https://api.atlassian.com/oauth/token/
 *     accessible-resources
 *     (`developer.atlassian.com/cloud/oauth/getting-started/
 *     making-calls-to-api/`)
 *   - Identity:              GET  https://api.atlassian.com/me, `read:me`
 *     scope (`developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/`
 *     "User Identity API")
 *
 * **The multi-site problem this module exists to solve.** A 3LO access
 * token is not scoped to one Jira site — one consent can cover several
 * sites the granting user has access to, and `accessible-resources` is the
 * only way to learn which ones. Picking the wrong one (or silently
 * registering only the first) means reading/writing the wrong project, so
 * this is a two-step flow rather than one: {@link JiraOauthConnectService.
 * discoverSites} exchanges the redirect code and lists every accessible
 * site WITHOUT persisting anything, and {@link JiraOauthConnectService.
 * connectSites} takes the caller's chosen subset (the UI's site picker,
 * issue #230 — not built here) and persists one `ConnectedAccount` per
 * chosen site, `credentialSource: 'oauth_3lo'`, keyed like
 * `./jira-connect.ts` on `(host, accountId)` so two sites — or a second
 * grant on the same site — never collide.
 *
 * **One grant, one shared secret, many sites.** Every site an OAuth grant
 * covers shares the exact same `{accessToken, refreshToken}` pair — Jira's
 * per-site routing is a path segment (`/ex/jira/{cloudId}/...`), not a
 * separate credential. Atlassian's refresh tokens additionally ROTATE: the
 * one presented to `POST /oauth/token` is disabled the moment a new pair
 * is issued (`refresh-tokens/`'s own doc: "the refresh token you used for
 * the request is disabled"). If each site's `ConnectedAccount.secretRef`
 * stored its own copy of that pair, refreshing under one site would
 * silently disable the identical string stored under every sibling site,
 * breaking their next refresh with `invalid_grant` the moment any one of
 * them ran first. So the token pair is NOT duplicated per site: it lives
 * once, in a keyring entry keyed on the Atlassian `accountId`
 * ({@link jiraOauthGrantSecretRef}, deterministic — a later re-consent by
 * the same Atlassian account naturally supersedes it rather than leaking
 * a second copy) — every site's own `secretRef` stores only a small
 * pointer `{grantAccountId, cloudId, siteUrl}` and {@link
 * JiraOauthConnectService.getCredential} resolves through it. A refresh
 * performed while resolving ANY one site's credential rewrites that one
 * shared entry, so every sibling site observes the fresh token on its
 * very next call — proven by this module's own
 * "refreshing one site's credential also refreshes its sibling's" test.
 *
 * **Known, documented gap this module leaves behind on disconnect.**
 * `deleteCredential` removes only the disconnected site's pointer, never
 * the shared grant secret underneath it (there is no reference count, and
 * `KeyringBackend` exposes no way to enumerate keys to check for one) — a
 * grant with zero remaining sites becomes unreachable dead weight in the
 * keyring file rather than being reaped. That is a real, deliberate
 * simplification for this issue, not an oversight: reference-counting a
 * secret whose real-Atlassian rotation behaviour this module has not been
 * able to verify (see the PR description) would be complexity spent on an
 * unverified assumption.
 *
 * **Never verified against real Atlassian.** Every request/response shape
 * here is built from the citations above; every test in
 * `jira-oauth-connect.test.ts` stubs `fetchImpl` and never makes a real
 * network call (issue #226's acceptance) — see this module's own PR
 * description for exactly what a real 3LO app registration would need to
 * confirm.
 * --------------------------------------------------------------------- */

import {
  composeConnectedAccountId,
  connectedAccount,
  connectedAccountSecretRef,
  type ConnectedAccount,
} from '@loombox/protocol';

import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
  type ConnectedAccountKeyringOptions,
} from './connected-account-keyring';
import type { NodeKeyring } from './keyring';

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const IDENTITY_URL = 'https://api.atlassian.com/me';

/** Reads loombox's own registered Atlassian OAuth (3LO) app's client id — a real, ongoing maintenance dependency (SPEC §7.26, issue #226's own acceptance), never assumed free. Distinct from every other provider's connect client id (`GITHUB_CONNECT_CLIENT_ID_ENV_VAR`) — a separate Atlassian Developer Console app, registered and rotated independently. */
export const JIRA_OAUTH_CLIENT_ID_ENV_VAR = 'LOOMBOX_JIRA_OAUTH_CLIENT_ID';
/** Reads the confidential-client secret paired with {@link JIRA_OAUTH_CLIENT_ID_ENV_VAR}. Unlike GitHub's public device-flow client, a Jira 3LO app IS a confidential client (`oauth-2-3lo-apps/`'s token-exchange `client_secret` field) — this value never leaves the node process, never appears in a log line or error message, and is required for both the initial code exchange and every later refresh. */
export const JIRA_OAUTH_CLIENT_SECRET_ENV_VAR = 'LOOMBOX_JIRA_OAUTH_CLIENT_SECRET';

/** Reads {@link JIRA_OAUTH_CLIENT_ID_ENV_VAR} from `env` (defaults to `process.env`); `undefined` when unset or empty. */
export function resolveJiraOauthClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[JIRA_OAUTH_CLIENT_ID_ENV_VAR];
  return value && value.length > 0 ? value : undefined;
}

/** Reads {@link JIRA_OAUTH_CLIENT_SECRET_ENV_VAR} from `env` (defaults to `process.env`); `undefined` when unset or empty. */
export function resolveJiraOauthClientSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[JIRA_OAUTH_CLIENT_SECRET_ENV_VAR];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Requested on every authorize URL: `offline_access` (required to receive
 * a refresh token at all — `refresh-tokens/`'s "Obtaining a Refresh
 * Token"), `read:me` (required for `GET /me` identity resolution —
 * `oauth-2-3lo-apps/`'s "User Identity API"), the classic Jira-platform
 * pair covering comments/transitions/issue reads
 * (`read:jira-work`/`write:jira-work`/`read:jira-user`, the same scope
 * vocabulary `accessible-resources`' own example response shows granted),
 * and the granular Jira Software board/sprint scopes
 * (`scopes-for-oauth-2-3LO-and-forge-apps/`) so `deriveJiraOauthCapabilities`
 * below can light up `boards`/`sprints` the same way API-token connections
 * always do. Order is stable so a request/log is deterministic.
 */
export const JIRA_OAUTH_SCOPES = [
  'read:me',
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'read:board-scope:jira-software',
  'write:board-scope:jira-software',
  'read:sprint:jira-software',
  'write:sprint:jira-software',
  'offline_access',
] as const;

/** Raised for any 3LO failure — a malformed token/accessible-resources/identity response, an HTTP error from Atlassian, or an unselected/unknown cloudId. Never includes an access token, refresh token, or `clientSecret` in its message. */
export class JiraOauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraOauthError';
  }
}

/** Builds `https://auth.atlassian.com/authorize?...` (`oauth-2-3lo-apps/` step 1) — a caller opens this URL in a browser; `state` is the caller's own CSRF-bound value (unrelated to any wire `requestId`), round-tripped by Atlassian onto the callback unchanged. */
export function buildJiraOauthAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('scope', (options.scopes ?? JIRA_OAUTH_SCOPES).join(' '));
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/** One `{accessToken, refreshToken}` pair as either the code exchange or a refresh hands it back — `expiresAt` is already converted from the response's relative `expires_in` seconds into an absolute epoch-ms deadline, so nothing downstream re-derives it from a captured-at-the-wrong-instant `Date.now()`. */
export interface JiraOauthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  /** The token endpoint's own `scope` field, split on spaces — what Atlassian actually granted, which may be narrower than requested (an org policy), never assumed equal to {@link JIRA_OAUTH_SCOPES}. */
  readonly grantedScopes: readonly string[];
}

interface JiraOauthTokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

async function parseTokenResponse(response: Response, now: () => number): Promise<JiraOauthTokens> {
  if (!response.ok) {
    throw new JiraOauthError(`jira oauth: token endpoint responded with HTTP ${response.status}`);
  }
  const body = (await response.json()) as JiraOauthTokenResponseBody;
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new JiraOauthError('jira oauth: token endpoint response has no "access_token" field');
  }
  if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
    throw new JiraOauthError(
      'jira oauth: token endpoint response has no "refresh_token" field (was "offline_access" requested?)',
    );
  }
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)) {
    throw new JiraOauthError('jira oauth: token endpoint response has no "expires_in" field');
  }
  const grantedScopes =
    typeof body.scope === 'string' && body.scope.length > 0 ? body.scope.split(' ') : [];
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: now() + body.expires_in * 1000,
    grantedScopes,
  };
}

export interface ExchangeJiraOauthCodeOptions {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for tests; defaults to the global `fetch`. Must never be pointed at a real Atlassian endpoint from a test. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests (`expiresAt` determinism); defaults to `Date.now`. */
  now?: () => number;
}

/** Step 2 of `oauth-2-3lo-apps/`: exchanges the callback's `code` for `{access_token, refresh_token, expires_in, scope}` via `POST https://auth.atlassian.com/oauth/token` (`grant_type: "authorization_code"`). */
export async function exchangeJiraOauthCode(
  options: ExchangeJiraOauthCodeOptions,
): Promise<JiraOauthTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
    }),
  });
  return parseTokenResponse(response, now);
}

export interface RefreshJiraOauthTokenOptions {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** `refresh-tokens/`'s rotating-refresh-token flow: `POST https://auth.atlassian.com/oauth/token` with `grant_type: "refresh_token"`. Atlassian disables the presented `refreshToken` the instant this succeeds and returns a new one — the caller MUST persist the returned pair and never reuse the one passed in. */
export async function refreshJiraOauthToken(
  options: RefreshJiraOauthTokenOptions,
): Promise<JiraOauthTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
    }),
  });
  return parseTokenResponse(response, now);
}

/** One `accessible-resources` entry (`making-calls-to-api/`'s own example response), the unit the site picker (#230) renders and {@link JiraOauthConnectService.connectSites} selects from. `cloudId` is that response's `id` field, renamed here since `id` is ambiguous with `ConnectedAccount.id` everywhere else in this codebase. */
export interface JiraAccessibleSite {
  readonly cloudId: string;
  readonly url: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly avatarUrl?: string;
}

/** `GET https://api.atlassian.com/oauth/token/accessible-resources` (`making-calls-to-api/`) — every site (Jira, Jira Service Management, Confluence, ...) this grant's token can reach. Callers filter to Jira sites themselves if needed; this module does not assume every entry is a Jira site (a JSM site's own `scopes` still look Jira-shaped per the docs' own example, so there is no reliable structural filter here). */
export async function listJiraAccessibleResources(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraAccessibleSite[]> {
  const response = await fetchImpl(ACCESSIBLE_RESOURCES_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new JiraOauthError(
      `jira oauth: GET accessible-resources responded with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new JiraOauthError('jira oauth: accessible-resources response is not an array');
  }
  return body.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const cloudId = record.id;
    const url = record.url;
    const name = record.name;
    if (typeof cloudId !== 'string' || cloudId.length === 0) {
      throw new JiraOauthError(`jira oauth: accessible-resources[${index}] has no "id" field`);
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new JiraOauthError(`jira oauth: accessible-resources[${index}] has no "url" field`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new JiraOauthError(`jira oauth: accessible-resources[${index}] has no "name" field`);
    }
    const scopesField = record.scopes;
    const scopes = Array.isArray(scopesField)
      ? scopesField.filter((value): value is string => typeof value === 'string')
      : [];
    const avatarUrl =
      typeof record.avatarUrl === 'string' && record.avatarUrl.length > 0
        ? record.avatarUrl
        : undefined;
    return { cloudId, url, name, scopes, avatarUrl };
  });
}

/** `GET https://api.atlassian.com/me` (`read:me` scope; `oauth-2-3lo-apps/`'s "User Identity API"), keyed on the stable `account_id` — never `email`, same rule as `./jira-identity.ts`'s API-token identity resolution, just a different endpoint entirely (there is no site-scoped Basic auth in a 3LO request). */
export interface JiraOauthIdentity {
  readonly accountId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

export async function resolveJiraOauthIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraOauthIdentity> {
  const response = await fetchImpl(IDENTITY_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new JiraOauthError(`jira oauth: GET /me responded with HTTP ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const accountId = body.account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new JiraOauthError('jira oauth: GET /me response has no "account_id" field');
  }
  const displayName = body.name;
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw new JiraOauthError('jira oauth: GET /me response has no "name" field');
  }
  const avatarUrl =
    typeof body.picture === 'string' && body.picture.length > 0 ? body.picture : undefined;
  return { accountId, displayName, avatarUrl };
}

/** Maps this grant's actually-granted scopes onto SPEC §7.26's fixed capability vocabulary (`./jira-connect.ts`'s `JIRA_API_TOKEN_CAPABILITIES` is the same list, unconditional there since Basic auth has no introspectable scope at all) — `write:jira-work` covers both commenting and workflow transitions on Jira's classic platform API, and the granular `*-scope:jira-software`/`*:sprint:jira-software` families gate boards/sprints independently, exactly like API-token connections always report both `true`. If Atlassian grants fewer scopes than {@link JIRA_OAUTH_SCOPES} requested (an org policy), the missing capability is correctly absent, since this reads the granted list. */
function deriveJiraOauthCapabilities(grantedScopes: readonly string[]): string[] {
  const capabilities: string[] = [];
  if (grantedScopes.includes('write:jira-work')) capabilities.push('comments', 'transitions');
  if (grantedScopes.some((scope) => scope.startsWith('read:board-scope'))) {
    capabilities.push('boards');
  }
  if (grantedScopes.some((scope) => scope.startsWith('read:sprint'))) {
    capabilities.push('sprints');
  }
  return capabilities;
}

/** The shared, per-Atlassian-account token pair this module's top comment describes — deterministic key, so a later re-consent by the same account supersedes rather than duplicates. */
function jiraOauthGrantSecretRef(accountId: string): string {
  return `jira-oauth-grant:${accountId}`;
}

/** What lives at {@link jiraOauthGrantSecretRef}. No `clientId`/`clientSecret` here — those are this node's own deployment-wide app credentials ({@link JiraOauthConnectService}'s own fields), never duplicated per grant. */
interface JiraOauthGrantSecret {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

/** What lives at one site `ConnectedAccount`'s own `secretRef` — a pointer to its shared grant plus the two things `getCredential` needs that the grant itself doesn't carry: which site, and which cloudId to route through. */
interface JiraOauthSiteSecret {
  readonly grantAccountId: string;
  readonly cloudId: string;
  readonly siteUrl: string;
}

/** What `./jira-tracker-backend.ts`'s `ResolveJiraCredential` (and `./jira-connect.ts`'s identically-shaped, independently-declared interface — see `tracker-backend-composition.ts`'s doc comment for why the two are deliberately not unified) needs: the cloudId-routed REST root and a ready-to-set `Authorization` header. */
export interface JiraCredential {
  readonly baseUrl: string;
  readonly authHeader: string;
}

/** {@link JiraOauthConnectService.discoverSites}'s result — nothing is persisted yet; this is exactly what a site-picker UI (#230) renders, plus everything {@link JiraOauthConnectService.connectSites} needs to finish the flow once the user picks. */
export interface JiraOauthDiscovery {
  readonly identity: JiraOauthIdentity;
  readonly sites: readonly JiraAccessibleSite[];
  readonly tokens: JiraOauthTokens;
}

export interface JiraOauthConnectServiceOptions extends ConnectedAccountKeyringOptions {
  /** loombox's own registered Atlassian OAuth app client id. Defaults to {@link resolveJiraOauthClientId}(). */
  clientId?: string;
  /** The paired confidential-client secret. Defaults to {@link resolveJiraOauthClientSecret}(). */
  clientSecret?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests (deterministic `expiresAt`/refresh-due checks); defaults to `Date.now`. */
  now?: () => number;
  /** How long before `expiresAt` {@link JiraOauthConnectService.getCredential} proactively refreshes rather than risking a request racing token expiry mid-flight. Default 60_000ms. */
  refreshSkewMs?: number;
  /** Same hook as `./jira-connect.ts`/`./github-connect.ts`'s own `onCredentialChanged` — called with whichever secretRef (a site pointer OR the shared grant) this service just wrote or deleted, so `./account-presence.ts` never serves a stale answer. */
  onCredentialChanged?: (secretRef: string) => void;
}

export interface DiscoverJiraOauthSitesOptions {
  /** The callback's `code` query parameter. */
  code: string;
  /** MUST equal the `redirect_uri` used to build the authorize URL — Atlassian's token endpoint rejects a mismatch. */
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export interface ConnectJiraOauthSitesOptions {
  /** A prior {@link JiraOauthConnectService.discoverSites} result — never re-fetched or re-exchanged here. */
  discovery: JiraOauthDiscovery;
  /** The user's site choice: every `cloudId` from `discovery.sites` to register as its own `ConnectedAccount`. MUST be non-empty and MUST each name a site `discovery.sites` actually contains — this is the enforcement point for "let the user pick", not a free-form site url. */
  cloudIds: readonly string[];
}

/**
 * Runs SPEC §7.26's Jira OAuth 2.0 (3LO) connect path (issue #226): the
 * two-step `discoverSites` / `connectSites` split this module's top
 * comment explains, plus `getCredential`/`deleteCredential` for the
 * connected accounts it produces — the same shape `./jira-connect.ts`'s
 * `JiraConnectService` exposes for the API-token path, but not the same
 * class: this issue's own scope is the 3LO service standing on its own,
 * proven against fixtures; wiring it into `./tracker-backend-composition.
 * ts`'s live-mode gate (which still hard-rejects `oauth_3lo` today) is
 * explicitly left to a follow-up — see this module's PR description.
 */
export class JiraOauthConnectService {
  private readonly keyring: NodeKeyring;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly onCredentialChanged: ((secretRef: string) => void) | undefined;

  constructor(options: JiraOauthConnectServiceOptions = {}) {
    this.keyring = createConnectedAccountKeyring(options);
    this.clientId = options.clientId ?? resolveJiraOauthClientId();
    this.clientSecret = options.clientSecret ?? resolveJiraOauthClientSecret();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    this.onCredentialChanged = options.onCredentialChanged;
  }

  private requireClientCredentials(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw new JiraOauthError(
        `jira oauth: no client id/secret configured (${JIRA_OAUTH_CLIENT_ID_ENV_VAR} / ${JIRA_OAUTH_CLIENT_SECRET_ENV_VAR})`,
      );
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  /** Builds this deployment's authorize URL — see {@link buildJiraOauthAuthorizeUrl}. Throws {@link JiraOauthError} if no client id is configured. */
  buildAuthorizeUrl(options: {
    redirectUri: string;
    state: string;
    scopes?: readonly string[];
  }): string {
    const { clientId } = this.requireClientCredentials();
    return buildJiraOauthAuthorizeUrl({ ...options, clientId });
  }

  /**
   * Step 1: exchanges the callback `code` for tokens, then calls
   * `accessible-resources` and `GET /me` — the full multi-site discovery,
   * with NOTHING written to the keyring and no `ConnectedAccount` produced
   * yet. Throws {@link JiraOauthError} if `accessible-resources` returns
   * zero sites (nothing for the caller to pick from) or if any step's
   * response is malformed.
   */
  async discoverSites(options: DiscoverJiraOauthSitesOptions): Promise<JiraOauthDiscovery> {
    const { clientId, clientSecret } = this.requireClientCredentials();
    const fetchImpl = options.fetchImpl ?? this.fetchImpl;

    const tokens = await exchangeJiraOauthCode({
      code: options.code,
      redirectUri: options.redirectUri,
      clientId,
      clientSecret,
      fetchImpl,
      now: this.now,
    });
    const sites = await listJiraAccessibleResources(tokens.accessToken, fetchImpl);
    if (sites.length === 0) {
      throw new JiraOauthError('jira oauth: accessible-resources returned no sites for this grant');
    }
    const identity = await resolveJiraOauthIdentity(tokens.accessToken, fetchImpl);

    return { identity, sites, tokens };
  }

  /**
   * Step 2: persists the caller's chosen subset of `discovery.sites` as
   * one `ConnectedAccount` each (`credentialSource: 'oauth_3lo'`) — the
   * "remember the choice per connected account" half of this issue. The
   * shared token pair is written once, to {@link jiraOauthGrantSecretRef};
   * each site gets its own small pointer secret at its own
   * `connectedAccountSecretRef(id)`, matching `./jira-connect.ts`/
   * `./github-connect.ts`'s own convention so disconnect/presence code
   * addresses it identically regardless of provider or credential source.
   */
  async connectSites(options: ConnectJiraOauthSitesOptions): Promise<ConnectedAccount[]> {
    const { discovery, cloudIds } = options;
    if (cloudIds.length === 0) {
      throw new JiraOauthError('jira oauth: connectSites requires at least one selected site');
    }
    const chosenSites = cloudIds.map((cloudId) => {
      const site = discovery.sites.find((candidate) => candidate.cloudId === cloudId);
      if (!site) {
        throw new JiraOauthError(
          `jira oauth: "${cloudId}" is not one of the sites this grant's accessible-resources covers`,
        );
      }
      return site;
    });

    const grantSecretRef = jiraOauthGrantSecretRef(discovery.identity.accountId);
    const grantSecret: JiraOauthGrantSecret = {
      accessToken: discovery.tokens.accessToken,
      refreshToken: discovery.tokens.refreshToken,
      expiresAt: discovery.tokens.expiresAt,
    };
    await this.keyring.set(
      CONNECTED_ACCOUNT_KEYRING_SERVICE,
      grantSecretRef,
      JSON.stringify(grantSecret),
    );
    this.onCredentialChanged?.(grantSecretRef);

    const now = this.now();
    const capabilities = deriveJiraOauthCapabilities(discovery.tokens.grantedScopes);
    const accounts: ConnectedAccount[] = [];
    for (const site of chosenSites) {
      const host = new URL(site.url).host;
      const id = composeConnectedAccountId({
        provider: 'jira',
        host,
        providerAccountId: discovery.identity.accountId,
      });
      const secretRef = connectedAccountSecretRef(id);
      const siteSecret: JiraOauthSiteSecret = {
        grantAccountId: discovery.identity.accountId,
        cloudId: site.cloudId,
        siteUrl: site.url,
      };
      await this.keyring.set(
        CONNECTED_ACCOUNT_KEYRING_SERVICE,
        secretRef,
        JSON.stringify(siteSecret),
      );
      this.onCredentialChanged?.(secretRef);

      accounts.push(
        connectedAccount.parse({
          id,
          provider: 'jira',
          host,
          providerAccountId: discovery.identity.accountId,
          label: discovery.identity.displayName,
          avatarUrl: discovery.identity.avatarUrl,
          credentialSource: 'oauth_3lo',
          scopes: [...discovery.tokens.grantedScopes],
          capabilities,
          connectedAt: now,
          updatedAt: now,
          secretRef,
        }),
      );
    }
    return accounts;
  }

  /**
   * Resolves `account` (an `oauth_3lo` connection this service produced)
   * into `{baseUrl, authHeader}` — `./jira-tracker-backend.ts`'s
   * `resolveCloudId` never runs for these: the cloudId is already known
   * from `connectSites`, not rediscovered. Refreshes through the SHARED
   * grant secret transparently when within {@link
   * JiraOauthConnectServiceOptions.refreshSkewMs} of `expiresAt` —
   * refreshed tokens are persisted back to that one shared entry, so
   * every sibling site sees them on its own very next call. Returns
   * `undefined` when this node holds no local secret for `account`
   * (never connected here, or since disconnected) — mirrors `./jira-
   * connect.ts`'s `getCredential`. Throws {@link JiraOauthError} for any
   * `credentialSource` other than `'oauth_3lo'`.
   */
  async getCredential(
    account: Pick<ConnectedAccount, 'host' | 'secretRef' | 'credentialSource'>,
  ): Promise<JiraCredential | undefined> {
    if (account.credentialSource !== 'oauth_3lo') {
      throw new JiraOauthError(
        `JiraOauthConnectService.getCredential: credentialSource "${account.credentialSource}" is not 'oauth_3lo'`,
      );
    }

    const rawSite = await this.keyring.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, account.secretRef);
    if (rawSite === undefined) return undefined;
    const site = JSON.parse(rawSite) as JiraOauthSiteSecret;

    const grantSecretRef = jiraOauthGrantSecretRef(site.grantAccountId);
    const rawGrant = await this.keyring.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, grantSecretRef);
    if (rawGrant === undefined) return undefined;
    let grant = JSON.parse(rawGrant) as JiraOauthGrantSecret;

    if (this.now() >= grant.expiresAt - this.refreshSkewMs) {
      const { clientId, clientSecret } = this.requireClientCredentials();
      const refreshed = await refreshJiraOauthToken({
        refreshToken: grant.refreshToken,
        clientId,
        clientSecret,
        fetchImpl: this.fetchImpl,
        now: this.now,
      });
      grant = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      await this.keyring.set(
        CONNECTED_ACCOUNT_KEYRING_SERVICE,
        grantSecretRef,
        JSON.stringify(grant),
      );
      this.onCredentialChanged?.(grantSecretRef);
    }

    return {
      baseUrl: `https://api.atlassian.com/ex/jira/${site.cloudId}`,
      authHeader: `Bearer ${grant.accessToken}`,
    };
  }

  /** Deletes one site's pointer secret — the local half of disconnecting THAT site's `ConnectedAccount`. Deliberately leaves the shared grant secret behind even when this was the last site referencing it — see this module's top comment for why. */
  async deleteCredential(account: Pick<ConnectedAccount, 'secretRef'>): Promise<void> {
    await this.keyring.delete(CONNECTED_ACCOUNT_KEYRING_SERVICE, account.secretRef);
    this.onCredentialChanged?.(account.secretRef);
  }
}
