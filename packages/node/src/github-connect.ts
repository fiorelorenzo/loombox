/* ---------------------------------------------------------------------
 * Orchestrates SPEC §7.26's GitHub device-flow connect path end to end
 * (issue #222): `./github-device-flow.ts`'s RFC 8628 grant against GitHub,
 * `./github-identity.ts`'s `GET /user` identity resolution keyed on the
 * numeric id, a write of the resulting token to this node's OS keyring
 * (`./connected-account-keyring.ts`'s shared binding — the same one
 * `./jira-connect.ts` and this package's node-presence check,
 * `./account-presence.ts`, both reuse rather than each inventing their
 * own), and the metadata-only `ConnectedAccount` that write's `secretRef`
 * names.
 *
 * **The token never leaves {@link GithubConnectService.connect}'s local
 * scope except into the keyring.** It is not a field of the returned
 * `ConnectedAccount` (that type structurally has no token-shaped field —
 * see `@loombox/protocol`'s `connected-accounts.ts` doc comment), and this
 * module never logs it. The returned value is exactly the shape
 * `connected_account_announce` (issue #221) carries, so a caller that owns
 * a live `RelayConnection` (`NodeDaemon`, mirroring `sendTargetAnnounce`)
 * sends it through that *existing* wire path — this module deliberately
 * holds no relay connection itself and invents no second one.
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
import {
  GITHUB_CONNECT_SCOPES,
  runGithubDeviceFlow,
  type GithubDeviceCodeInfo,
} from './github-device-flow';
import {
  githubApiBaseUrl,
  resolveGithubIdentity,
  resolveGithubPatReach,
  type GithubIdentity,
  type GithubPatReach,
} from './github-identity';
import type { NodeKeyring } from './keyring';

const GITHUB_HOST = 'github.com';

/**
 * The env var a deployment sets its public GitHub OAuth App client id
 * through (issue #222: "public by design... still has to be configurable
 * per deployment rather than hardcoded to one app"). A distinct app from
 * the relay's own login OAuth app (`GITHUB_CLIENT_ID` in
 * `packages/relay/src/main.ts`, SPEC §8) — connecting a GitHub account
 * (§7.26) is a deliberately separate, more-privileged credential from
 * logging into loombox itself, so the two apps (and their env vars) are
 * kept apart on purpose, never sharing one client id. This one OAuth App
 * needs no client secret (RFC 8628 device flow, public-client-safe), so
 * unlike `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` it ships as a single
 * value.
 */
export const GITHUB_CONNECT_CLIENT_ID_ENV_VAR = 'LOOMBOX_GITHUB_CONNECT_CLIENT_ID';

/** Reads {@link GITHUB_CONNECT_CLIENT_ID_ENV_VAR} from `env` (defaults to `process.env`); `undefined` when unset or empty, leaving the "no client id configured" decision to the caller (e.g. main.ts refusing to offer the connect flow at all) rather than throwing here. */
export function resolveGithubConnectClientId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[GITHUB_CONNECT_CLIENT_ID_ENV_VAR];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Maps the scopes GitHub actually granted to the SPEC §7.26 UI-feature
 * names `ConnectedAccount.capabilities` gates on. `repo` (full
 * read/write on private+public repos, which on GitHub already covers
 * issues/PRs/comments) unlocks `'repo'` and `'issues'`; `read:project`
 * (new for this issue, §7.10 Projects v2) unlocks `'projects'`.
 * `read:user`/`read:org` grant no tracker-write feature of their own — they
 * exist for identity resolution and future org-scoped repo listing, not to
 * gate a §7.10 UI surface — so neither adds a capability. If GitHub grants
 * fewer scopes than requested (an org restriction), the missing capability
 * is correctly absent too, since this reads the granted list, not the
 * requested one.
 *
 * Exported (not just this module's own concern) so #223's `gh` CLI import
 * derives capabilities from a gh-issued token's granted scopes the exact
 * same way the device flow does — one mapping, not two that could drift.
 */
export function deriveGithubCapabilities(grantedScopes: readonly string[]): string[] {
  const capabilities: string[] = [];
  if (grantedScopes.includes('repo')) capabilities.push('repo', 'issues');
  if (grantedScopes.includes('read:project')) capabilities.push('projects');
  return capabilities;
}

export interface GithubConnectServiceOptions extends ConnectedAccountKeyringOptions {
  /**
   * Called after a token write (`connect`) or delete
   * (`deleteAccessToken`) changes what this node's keyring holds for
   * `secretRef` — the hook `./account-presence.ts`'s `NodeAccountPresence`
   * (issue #228) binds to invalidate its cached presence answer for that
   * account, so a connect or disconnect on this node is never followed by
   * a stale "present"/"absent" read. Optional; omitted by tests and by
   * any caller that doesn't hold a presence cache.
   */
  onCredentialChanged?: (secretRef: string) => void;
}

export interface ConnectGithubAccountOptions {
  /** A public GitHub OAuth App client id — see {@link resolveGithubConnectClientId}. No client secret is ever sent (SPEC §7.26). */
  clientId: string;
  /** Injectable for tests; defaults to the global `fetch`. Issue #222's acceptance: tests must stub this, never hit real GitHub endpoints. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Makes the connect flow cancellable (issue #222's acceptance) — forwarded straight to `runGithubDeviceFlow`. */
  signal?: AbortSignal;
  /** Called once with the device/user code to show the operator — forwarded straight to `runGithubDeviceFlow`. */
  onUserCode?: (info: GithubDeviceCodeInfo) => void;
}

export type GithubPatConnectFailureReason = 'invalid_or_revoked' | 'insufficient_access' | 'error';

/** Raised by {@link GithubConnectService.connectWithToken} — never includes the pasted token in `message`. `reason` names which of issue #224's three failure modes this is: `'invalid_or_revoked'` (`GET /user` itself rejected the token — GitHub's API returns a bare 401 for an invalid, expired, or revoked fine-grained PAT with no further distinction to report, confirmed by GitHub's own community guidance on this exact question), `'insufficient_access'` (the token authenticates fine but `resolveGithubPatReach` found no repository it can reach — too narrow to be useful), or `'error'` for anything else (a network failure, a malformed GitHub response). */
export class GithubPatConnectError extends Error {
  constructor(
    readonly reason: GithubPatConnectFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'GithubPatConnectError';
  }
}

export interface ConnectGithubPatOptions {
  /** The pasted fine-grained PAT. Never logged, never included in any thrown error — the same contract `resolveGithubIdentity`'s own doc comment gives the device flow's token. */
  token: string;
  /** `github.com` by default; set for a GitHub Enterprise Server token — resolved through `githubApiBaseUrl`, the same per-host split `./github-cli-import.ts` (#223) already gives its own accounts. */
  host?: string;
  /** Injectable for tests; defaults to the global `fetch`. Never hits the real GitHub API from a test. */
  fetchImpl?: typeof fetch;
}

/** {@link GithubConnectService.connectWithToken}'s success shape — `account` plus the reach report `resolveGithubPatReach` produced, so a caller (the node-daemon wire handler) can pass both straight through `github_pat_connect_response` without a second call. */
export interface GithubPatConnectSuccess {
  account: ConnectedAccount;
  accessibleRepositories: string[];
  accessibleRepositoriesTruncated: boolean;
}

/**
 * Runs SPEC §7.26's GitHub device-flow connect path (issue #222) and holds
 * the OS-keyring-backed token storage it writes into. One instance is
 * reusable across multiple `connect()` calls (e.g. linking a second GitHub
 * account) — each call's token lands under its own `secretRef`, keyed by
 * that account's own `provider:host:providerAccountId`, so accounts never
 * collide or overwrite each other's secret.
 */
export class GithubConnectService {
  private readonly keyring: NodeKeyring;
  private readonly onCredentialChanged: ((secretRef: string) => void) | undefined;

  constructor(options: GithubConnectServiceOptions = {}) {
    this.keyring = createConnectedAccountKeyring(options);
    this.onCredentialChanged = options.onCredentialChanged;
  }

  /**
   * Runs the device flow, resolves identity, writes the token to this
   * service's keyring, and returns the metadata-only `ConnectedAccount` —
   * the caller announces it (issue #221's `connected_account_announce`).
   * Throws `GithubDeviceFlowError` (`expired_token` / `access_denied` /
   * `cancelled`) or `GithubIdentityError` on failure; neither this method
   * nor either of those ever include the token in a message.
   */
  async connect(options: ConnectGithubAccountOptions): Promise<ConnectedAccount> {
    const flow = await runGithubDeviceFlow({
      clientId: options.clientId,
      scopes: GITHUB_CONNECT_SCOPES,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      signal: options.signal,
      onUserCode: options.onUserCode,
    });

    const identity = await resolveGithubIdentity(flow.accessToken, {
      fetchImpl: options.fetchImpl,
    });

    const id = composeConnectedAccountId({
      provider: 'github',
      host: GITHUB_HOST,
      providerAccountId: String(identity.id),
    });
    const secretRef = connectedAccountSecretRef(id);

    // The token touches this one keyring write and nothing else — it is
    // never assigned to any field of the ConnectedAccount built below.
    await this.keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, flow.accessToken);
    this.onCredentialChanged?.(secretRef);

    const grantedScopes = flow.grantedScope.length > 0 ? flow.grantedScope.split(',') : [];
    const now = Date.now();

    // `connectedAccount.parse` re-enforces `@loombox/protocol`'s
    // numeric-providerAccountId / derived-id structural rules — a bug
    // upstream in identity resolution fails loudly here (issue #222's
    // acceptance) rather than silently syncing a malformed row.
    return connectedAccount.parse({
      id,
      provider: 'github',
      host: GITHUB_HOST,
      providerAccountId: String(identity.id),
      label: identity.login,
      avatarUrl: identity.avatarUrl,
      credentialSource: 'device_flow',
      scopes: grantedScopes,
      capabilities: deriveGithubCapabilities(grantedScopes),
      connectedAt: now,
      updatedAt: now,
      secretRef,
    });
  }

  /**
   * Runs SPEC §7.26's fine-grained PAT paste path (issue #224) — the
   * fallback for orgs whose OAuth App access restrictions block {@link
   * connect}'s device flow outright. Reuses every piece {@link connect}
   * already built rather than growing a second copy: the same
   * `resolveGithubIdentity` numeric-id identity resolution, the same
   * keyring write (`this.keyring`/`this.onCredentialChanged`), and the
   * same `connectedAccount.parse` structural guard. The only genuinely
   * new step is `resolveGithubPatReach`, since a fine-grained PAT has no
   * classic OAuth scope to report at all (see that function's own top
   * comment) — its result is what stands in for `connect()`'s own
   * `grantedScopes`/`deriveGithubCapabilities` pair here.
   *
   * Throws {@link GithubPatConnectError} for every named failure —
   * `'invalid_or_revoked'` when `GET /user` itself rejects the token,
   * `'insufficient_access'` when the token authenticates but reaches no
   * repository at all, `'error'` for anything else — never a bare
   * `GithubIdentityError`, so a caller (`node-daemon.ts`'s
   * `handleGithubPatConnectRequest`) always has a named reason to map onto
   * `github_pat_connect_response`.
   */
  async connectWithToken(options: ConnectGithubPatOptions): Promise<GithubPatConnectSuccess> {
    const token = options.token.trim();
    if (token.length === 0) {
      throw new GithubPatConnectError('invalid_or_revoked', 'Paste a personal access token first.');
    }
    const host = options.host?.trim() || GITHUB_HOST;
    const apiBaseUrl = githubApiBaseUrl(host);

    let identity: GithubIdentity;
    try {
      identity = await resolveGithubIdentity(token, { fetchImpl: options.fetchImpl, apiBaseUrl });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GithubPatConnectError(
        'invalid_or_revoked',
        `This token is invalid, expired, or has been revoked (${detail}) — GitHub's API does not ` +
          'distinguish those three cases any further than a bare 401, so generate a fresh ' +
          'fine-grained personal access token and paste it again.',
      );
    }

    let reach: GithubPatReach;
    try {
      reach = await resolveGithubPatReach(token, { fetchImpl: options.fetchImpl, apiBaseUrl });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GithubPatConnectError(
        'error',
        `Connected as ${identity.login}, but could not check which repositories this token ` +
          `can reach (${detail}). Try again.`,
      );
    }
    if (reach.repositories.length === 0) {
      throw new GithubPatConnectError(
        'insufficient_access',
        "This fine-grained PAT can't reach any repositories — grant it access to at least one " +
          'repository (Contents: Read-only is enough to browse) when creating the token on ' +
          'GitHub, then paste it again.',
      );
    }

    const id = composeConnectedAccountId({
      provider: 'github',
      host,
      providerAccountId: String(identity.id),
    });
    const secretRef = connectedAccountSecretRef(id);

    // The token touches this one keyring write and nothing else — it is
    // never assigned to any field of the ConnectedAccount built below,
    // exactly like `connect()` above.
    await this.keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, token);
    this.onCredentialChanged?.(secretRef);

    const now = Date.now();
    const account = connectedAccount.parse({
      id,
      provider: 'github',
      host,
      providerAccountId: String(identity.id),
      label: identity.login,
      avatarUrl: identity.avatarUrl,
      credentialSource: 'fine_grained_pat',
      // Always empty: `resolveGithubIdentity`'s own top comment — GitHub
      // never sends `X-OAuth-Scopes` for a fine-grained PAT, so this is
      // never a signal of anything actually missing (contrast the device
      // flow's `grantedScopes`, a real granted/requested comparison).
      scopes: identity.scopes,
      // 'repo' only, never 'issues'/'projects': `reach.repositories`
      // proves this token can reach at least one repository, but a
      // fine-grained PAT's Issues/Projects permissions are independent
      // grants this module has no way to probe (GitHub exposes no
      // introspection endpoint for either) — `deriveGithubCapabilities`
      // (OAuth-scope-driven) doesn't apply to this credential kind at all.
      capabilities: ['repo'],
      connectedAt: now,
      updatedAt: now,
      secretRef,
    });

    return {
      account,
      accessibleRepositories: reach.repositories,
      accessibleRepositoriesTruncated: reach.truncated,
    };
  }

  /** This account's stored token, or `undefined` if never connected (or since disconnected). Never reaches the relay or a client — a purely local read for whichever node needs to actually call the GitHub API on this account's behalf. */
  async getAccessToken(account: Pick<ConnectedAccount, 'secretRef'>): Promise<string | undefined> {
    return this.keyring.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, account.secretRef);
  }

  /** Deletes a connected account's stored token — the local half of disconnecting it (the metadata row itself is the caller's/relay's concern, not this service's). */
  async deleteAccessToken(account: Pick<ConnectedAccount, 'secretRef'>): Promise<void> {
    await this.keyring.delete(CONNECTED_ACCOUNT_KEYRING_SERVICE, account.secretRef);
    this.onCredentialChanged?.(account.secretRef);
  }
}
