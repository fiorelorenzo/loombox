/* ---------------------------------------------------------------------
 * Orchestrates SPEC §7.26's GitHub device-flow connect path end to end
 * (issue #222): `./github-device-flow.ts`'s RFC 8628 grant against GitHub,
 * `./github-identity.ts`'s `GET /user` identity resolution keyed on the
 * numeric id, a write of the resulting token to this node's OS keyring
 * (`./keyring.ts`, same abstraction and file-fallback discipline
 * `./mcp-secrets.ts` already uses for per-project MCP secret values), and
 * the metadata-only `ConnectedAccount` that write's `secretRef` names.
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

import path from 'node:path';

import { deriveSharedSecretBits, importAesGcmKey } from '@loombox/crypto';
import {
  composeConnectedAccountId,
  connectedAccount,
  connectedAccountSecretRef,
  type ConnectedAccount,
} from '@loombox/protocol';

import {
  GITHUB_CONNECT_SCOPES,
  runGithubDeviceFlow,
  type GithubDeviceCodeInfo,
} from './github-device-flow';
import { resolveGithubIdentity } from './github-identity';
import { NodeIdentityStore } from './identity';
import { FileKeyringBackend, NodeKeyring, type KeyringBackend } from './keyring';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

const GITHUB_HOST = 'github.com';
const SECRETS_FILE_NAME = 'github-connect-secrets.local.json';
/** Every connected GitHub account's token shares this one `NodeKeyring` service; `account` is the per-account `secretRef` computed by `@loombox/protocol`'s `connectedAccountSecretRef`. */
const SECRET_KEYRING_SERVICE = 'loombox-connected-account';

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
 */
function deriveGithubCapabilities(grantedScopes: readonly string[]): string[] {
  const capabilities: string[] = [];
  if (grantedScopes.includes('repo')) capabilities.push('repo', 'issues');
  if (grantedScopes.includes('read:project')) capabilities.push('projects');
  return capabilities;
}

export interface GithubConnectServiceOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
  /**
   * Injectable for tests: overrides how the OS-native keyring backend is
   * probed for this service's token storage (issue #118). Defaults to
   * `keyring.ts`'s `createOsKeyringBackend`. Pass `async () => undefined`
   * to force the 0600-file fallback deterministically (see
   * `keyring.test.ts`).
   */
  osKeyringBackendFactory?: () => Promise<KeyringBackend | undefined>;
  /**
   * Where the file-fallback's AES-GCM encryption key comes from: a
   * self-ECDH derivation over this node's own identity keypair, exactly
   * like `./mcp-secrets.ts`'s `NodeMcpSecretManager`. Defaults to a fresh
   * `NodeIdentityStore({ stateDir })`; injectable so a caller that already
   * holds one doesn't force a second independent load.
   */
  identityStore?: NodeIdentityStore;
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

  constructor(options: GithubConnectServiceOptions = {}) {
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
    await this.keyring.set(SECRET_KEYRING_SERVICE, secretRef, flow.accessToken);

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

  /** This account's stored token, or `undefined` if never connected (or since disconnected). Never reaches the relay or a client — a purely local read for whichever node needs to actually call the GitHub API on this account's behalf. */
  async getAccessToken(account: Pick<ConnectedAccount, 'secretRef'>): Promise<string | undefined> {
    return this.keyring.get(SECRET_KEYRING_SERVICE, account.secretRef);
  }

  /** Deletes a connected account's stored token — the local half of disconnecting it (the metadata row itself is the caller's/relay's concern, not this service's). */
  async deleteAccessToken(account: Pick<ConnectedAccount, 'secretRef'>): Promise<void> {
    await this.keyring.delete(SECRET_KEYRING_SERVICE, account.secretRef);
  }
}
