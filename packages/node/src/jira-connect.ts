/* ---------------------------------------------------------------------
 * Orchestrates SPEC §7.26 / §7.10's Jira API-token connect path end to
 * end (issue #225): Basic auth (`base64(email:apiToken)`), keyed on the
 * stable `accountId` `GET /rest/api/3/myself` returns — never the mutable
 * `email` — the exact fix for emdash's `jira-connection-service.ts`
 * single-row limitation (`emdash/apps/emdash-desktop/src/main/core/jira/
 * jira-connection-service.ts:8,21,39-56`, keyed on `email`, one row
 * total): this service keys on `(siteUrl-host, accountId)` instead, the
 * same `composeConnectedAccountId` shape #222's `GithubConnectService`
 * already established for GitHub, so connecting a second Jira site never
 * overwrites the first — each gets its own `ConnectedAccount.id` and its
 * own keyring entry.
 *
 * The API token itself never appears in the `ConnectedAccount` this
 * returns. It lives in the node's OS keyring (`keyring.ts`'s
 * `NodeKeyring`, the same abstraction and file-fallback #222 uses)
 * alongside the `email` that authenticated it — Basic auth needs both on
 * every request, and `email` is deliberately NOT a `ConnectedAccount`
 * field (SPEC §7.26: mutable/SSO-reassignable), so it has to travel with
 * the token as one secret blob rather than living on the synced row.
 *
 * `getCredential` is the seam #214's `JiraTrackerBackend` consumes
 * (agreed over IRC while both issues were in flight): given a
 * `ConnectedAccount`, resolve the request base URL and a ready-to-set
 * `Authorization` header, mirroring #213's `ResolveGithubCredential` DI
 * pattern but as an async method here rather than a bare `{token}` —
 * Basic auth needs the paired `email`, which only this service's keyring
 * holds.
 * --------------------------------------------------------------------- */

import path from 'node:path';

import { deriveSharedSecretBits, importAesGcmKey } from '@loombox/crypto';
import {
  composeConnectedAccountId,
  connectedAccount,
  connectedAccountSecretRef,
  type ConnectedAccount,
} from '@loombox/protocol';

import { NodeIdentityStore } from './identity';
import { resolveJiraIdentity } from './jira-identity';
import { FileKeyringBackend, NodeKeyring, type KeyringBackend } from './keyring';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

const SECRETS_FILE_NAME = 'jira-connect-secrets.local.json';
/** Every connected Jira account's secret shares this one `NodeKeyring` service, same convention as `github-connect.ts`'s `SECRET_KEYRING_SERVICE` — `account` is the per-account `secretRef` computed by `@loombox/protocol`'s `connectedAccountSecretRef`. */
const SECRET_KEYRING_SERVICE = 'loombox-connected-account';

/**
 * SPEC §7.26's own example vocabulary for `ConnectedAccount.capabilities`
 * ("gates UI features (comments/transitions/boards/sprints/...)"). Unlike
 * GitHub's OAuth scopes (#222's `deriveGithubCapabilities`), a Jira API
 * token carries no introspectable scope — Basic auth grants exactly
 * whatever the authenticating user can already do on the site, which for
 * Jira Cloud always includes commenting, workflow transitions, and
 * agile boards/sprints — so this is a fixed list, not derived from a
 * response.
 */
const JIRA_API_TOKEN_CAPABILITIES = ['comments', 'transitions', 'boards', 'sprints'];

/** Raised for a malformed connect-form input (an unparseable `siteUrl`) or an unsupported `getCredential` call — never includes `apiToken` in its message. */
export class JiraConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraConnectError';
  }
}

/** The host `ConnectedAccount.id`/`.host` keys on, and the `https` base URL every REST call (identity resolution here, tracker requests via `getCredential`) is built from. */
export interface NormalizedJiraSite {
  readonly host: string;
  readonly baseUrl: string;
}

/**
 * Normalizes the connect form's `siteUrl` input into `{host, baseUrl}`.
 * Accepts either a bare host (`myteam.atlassian.net`) or a full URL
 * (`https://myteam.atlassian.net/`) — SPEC §7.26's `{siteUrl}` connect
 * input doesn't constrain which shape the user types — and always
 * resolves `baseUrl` to `https://`, since a real Atlassian Cloud site is
 * TLS-only. `host` may include a `:port` (Jira Data Center), the same
 * "one part of the composed id allowed to contain a colon" rule
 * `@loombox/protocol`'s `connectedAccount` schema documents for GHES.
 */
export function normalizeJiraSiteUrl(siteUrl: string): NormalizedJiraSite {
  const trimmed = siteUrl.trim();
  if (trimmed.length === 0) {
    throw new JiraConnectError('jira connect: siteUrl must not be empty');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new JiraConnectError(`jira connect: "${siteUrl}" is not a valid site URL`);
  }
  if (parsed.host.length === 0) {
    throw new JiraConnectError(`jira connect: "${siteUrl}" is not a valid site URL`);
  }
  return { host: parsed.host, baseUrl: `https://${parsed.host}` };
}

/** The keyring secret this service stores for an `api_token` connection. Basic auth needs both `email` and `apiToken` on every request (`base64(email:apiToken)`), and `email` is deliberately not a `ConnectedAccount` field, so the pair travels together as one blob rather than the token alone. */
interface JiraApiTokenSecret {
  readonly email: string;
  readonly apiToken: string;
}

/** What #214's `JiraTrackerBackend` needs to make a request: the resolved REST base URL and a complete, ready-to-set `Authorization` header value. */
export interface JiraCredential {
  readonly baseUrl: string;
  readonly authHeader: string;
}

export interface JiraConnectServiceOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
  /**
   * Injectable for tests: overrides how the OS-native keyring backend is
   * probed for this service's secret storage. Defaults to `keyring.ts`'s
   * `createOsKeyringBackend`. Pass `async () => undefined` to force the
   * 0600-file fallback deterministically (see `keyring.test.ts`).
   */
  osKeyringBackendFactory?: () => Promise<KeyringBackend | undefined>;
  /**
   * Where the file-fallback's AES-GCM encryption key comes from: a
   * self-ECDH derivation over this node's own identity keypair, exactly
   * like `github-connect.ts`'s `GithubConnectService`. Defaults to a
   * fresh `NodeIdentityStore({ stateDir })`; injectable so a caller that
   * already holds one doesn't force a second independent load.
   */
  identityStore?: NodeIdentityStore;
}

export interface ConnectJiraAccountOptions {
  /** A bare host or full URL for the target Jira Cloud/Data Center site — see {@link normalizeJiraSiteUrl}. */
  siteUrl: string;
  email: string;
  apiToken: string;
  /** Injectable for tests; defaults to the global `fetch`. Must never be pointed at a real Jira site from a test. */
  fetchImpl?: typeof fetch;
}

/**
 * Runs SPEC §7.26's Jira API-token connect path (issue #225): resolves
 * identity via `GET /rest/api/3/myself`, writes `{email, apiToken}` to
 * this service's keyring, and returns the metadata-only `ConnectedAccount`
 * (issue #221) a caller announces through the existing
 * `connected_account_announce` wire path — the token never appears in
 * that returned value, in a log line, or in any error message.
 */
export class JiraConnectService {
  private readonly keyring: NodeKeyring;

  constructor(options: JiraConnectServiceOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    const identityStore = options.identityStore ?? new NodeIdentityStore({ stateDir });
    this.keyring = new NodeKeyring({
      osBackendFactory: options.osKeyringBackendFactory,
      fileBackend: new FileKeyringBackend({
        filePath: path.join(stateDir, SECRETS_FILE_NAME),
        encryptionKey: async () => {
          const identity = await identityStore.loadOrCreate();
          const bits = await deriveSharedSecretBits(
            identity.keyPair.privateKey,
            identity.keyPair.publicKey,
          );
          return importAesGcmKey(bits);
        },
      }),
    });
  }

  /**
   * Connects one Jira site under `{siteUrl, email, apiToken}`. Two
   * connects for different sites (or different accounts on the same
   * site) each get their own `ConnectedAccount.id` and their own keyring
   * entry — neither overwrites the other, unlike emdash's single-row
   * behaviour this issue fixes.
   */
  async connect(options: ConnectJiraAccountOptions): Promise<ConnectedAccount> {
    const { host, baseUrl } = normalizeJiraSiteUrl(options.siteUrl);
    const identity = await resolveJiraIdentity(baseUrl, options.email, options.apiToken, {
      fetchImpl: options.fetchImpl,
    });

    const id = composeConnectedAccountId({
      provider: 'jira',
      host,
      providerAccountId: identity.accountId,
    });
    const secretRef = connectedAccountSecretRef(id);

    // `email` and `apiToken` touch this one keyring write and nothing
    // else — neither is ever assigned to any field of the
    // ConnectedAccount built below.
    const secret: JiraApiTokenSecret = { email: options.email, apiToken: options.apiToken };
    await this.keyring.set(SECRET_KEYRING_SERVICE, secretRef, JSON.stringify(secret));

    const now = Date.now();

    // `connectedAccount.parse` re-enforces `@loombox/protocol`'s
    // providerAccountId shape rules — a malformed upstream identity fails
    // loudly here rather than silently syncing a bad row.
    return connectedAccount.parse({
      id,
      provider: 'jira',
      host,
      providerAccountId: identity.accountId,
      label: identity.displayName,
      avatarUrl: identity.avatarUrl,
      credentialSource: 'api_token',
      scopes: null,
      capabilities: JIRA_API_TOKEN_CAPABILITIES,
      connectedAt: now,
      updatedAt: now,
      secretRef,
    });
  }

  /**
   * Resolves `account` into the base URL and `Authorization` header
   * #214's `JiraTrackerBackend` needs to call the Jira REST API on its
   * behalf. Returns `undefined` when this node holds no local secret for
   * `account` (never connected here, or since disconnected) — never the
   * relay's concern, purely a local read. Throws {@link JiraConnectError}
   * for any `credentialSource` other than `'api_token'`: OAuth 3LO
   * (#226) resolves differently (a Bearer token plus `cloudId`-routed
   * base URL, no Basic-auth header) and has no resolver here yet.
   */
  async getCredential(
    account: Pick<ConnectedAccount, 'host' | 'secretRef' | 'credentialSource'>,
  ): Promise<JiraCredential | undefined> {
    if (account.credentialSource !== 'api_token') {
      throw new JiraConnectError(
        `JiraConnectService.getCredential: credentialSource "${account.credentialSource}" has no resolver yet (only 'api_token' is implemented — OAuth 3LO ships in #226)`,
      );
    }

    const raw = await this.keyring.get(SECRET_KEYRING_SERVICE, account.secretRef);
    if (raw === undefined) return undefined;
    const secret = JSON.parse(raw) as JiraApiTokenSecret;

    return {
      baseUrl: `https://${account.host}`,
      authHeader: `Basic ${Buffer.from(`${secret.email}:${secret.apiToken}`).toString('base64')}`,
    };
  }

  /** Deletes a connected account's stored secret — the local half of disconnecting it (the metadata row itself is the caller's/relay's concern, not this service's). */
  async deleteCredential(account: Pick<ConnectedAccount, 'secretRef'>): Promise<void> {
    await this.keyring.delete(SECRET_KEYRING_SERVICE, account.secretRef);
  }
}
