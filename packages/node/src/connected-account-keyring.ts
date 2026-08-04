/* ---------------------------------------------------------------------
 * The single, shared keyring binding every connected-account credential —
 * GitHub's device-flow/CLI-import/PAT token (`github-connect.ts`, issue
 * #222), Jira's API-token pair (`jira-connect.ts`, issue #225), and any
 * future provider — reads and writes through (SPEC §7.26).
 *
 * One `NodeKeyring` service name, {@link CONNECTED_ACCOUNT_KEYRING_SERVICE},
 * addressed per-account by `@loombox/protocol`'s
 * `connectedAccountSecretRef(id)`. `createConnectedAccountKeyring` is the
 * one place that binding is constructed — `github-connect.ts` and
 * `jira-connect.ts` both call it instead of each building their own
 * `NodeKeyring`, and this package's node-presence check (`account-presence
 * .ts`, issue #228 — "does this node hold the pinned account's secret right
 * now") calls it too. That sharing is load-bearing, not cosmetic: the
 * OS-native backend is already one global namespace keyed by (service,
 * account), but the 0600-file fallback (this devbox, headless, no keyring
 * session — see `keyring.ts`'s own doc comment) is per-instance-file, so a
 * presence check built from a *second*, independently-constructed
 * `NodeKeyring` would silently probe an empty file and report every real
 * account absent. One shared file name
 * (`connected-account-secrets.local.json`) is what keeps every caller
 * looking at the same store.
 * --------------------------------------------------------------------- */

import path from 'node:path';

import { deriveSharedSecretBits, importAesGcmKey } from '@loombox/crypto';

import { NodeIdentityStore } from './identity';
import { FileKeyringBackend, NodeKeyring, type KeyringBackend } from './keyring';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

/** Every connected account's credential — any provider — shares this one `NodeKeyring` service; the per-account key is `@loombox/protocol`'s `connectedAccountSecretRef(id)`. */
export const CONNECTED_ACCOUNT_KEYRING_SERVICE = 'loombox-connected-account';

const SECRETS_FILE_NAME = 'connected-account-secrets.local.json';

export interface ConnectedAccountKeyringOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
  /**
   * Injectable for tests: overrides how the OS-native keyring backend is
   * probed. Defaults to `keyring.ts`'s `createOsKeyringBackend`. Pass
   * `async () => undefined` to force the 0600-file fallback
   * deterministically (see `keyring.test.ts`).
   */
  osKeyringBackendFactory?: () => Promise<KeyringBackend | undefined>;
  /**
   * Where the file-fallback's AES-GCM encryption key comes from: a
   * self-ECDH derivation over this node's own identity keypair. Defaults
   * to a fresh `NodeIdentityStore({ stateDir })`; injectable so a caller
   * that already holds one doesn't force a second independent load.
   */
  identityStore?: NodeIdentityStore;
}

/**
 * Builds the one `NodeKeyring` every connected-account credential (any
 * provider) reads and writes through. Two calls with the same `stateDir`
 * (and, on the file-fallback path, the same identity — i.e. the same
 * node) resolve to backends that see each other's writes, since both
 * point at the same OS-native namespace or the same file — that is the
 * entire point of centralizing this rather than letting each caller build
 * its own.
 */
export function createConnectedAccountKeyring(
  options: ConnectedAccountKeyringOptions = {},
): NodeKeyring {
  const stateDir = options.stateDir ?? defaultNodeStateDir();
  const identityStore = options.identityStore ?? new NodeIdentityStore({ stateDir });
  return new NodeKeyring({
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
