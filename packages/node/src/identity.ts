import type { webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  importPublicKeyRaw,
  type EcdhKeyPair,
} from '@loombox/crypto';

import { createOsKeyringBackend, type KeyringBackend } from './keyring';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

type JsonWebKey = webcrypto.JsonWebKey;

const ECDH_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const;
/**
 * This identity file's bare name under a node's state dir — exported so a
 * caller that needs to PRE-SEED a not-yet-running node's identity on a
 * remote host (`./ssh/provision-and-pair.ts`'s zero-touch pairing, issue
 * #408: the acting node writes this file to the freshly-provisioned
 * target's own state dir over SSH, before that node's systemd unit ever
 * starts) writes to the exact same bare name `NodeIdentityStore` itself
 * reads from on first load — never a hardcoded duplicate string.
 */
export const IDENTITY_FILE_NAME = 'identity.json';
const IDENTITY_SCHEMA_VERSION = 1;
/** The OS-native keyring's `service` this identity is stored under (issue #118); `account` is scoped per store below (`NodeIdentityStore`'s own `stateDir`), so two nodes sharing one OS keyring session never collide. */
const IDENTITY_KEYRING_SERVICE = 'loombox-node-identity';

/** This node's own stable E2E device identity (SPEC §5.1 "registers as an E2E device", §8). */
export interface NodeIdentity {
  readonly keyPair: EcdhKeyPair;
  /** Raw uncompressed EC point (0x04 || X || Y), the compact wire form. */
  readonly publicKeyRaw: Uint8Array;
  /** Base64 encoding of `publicKeyRaw` — the exact shape `NodeDaemonOptions.devicePublicKey` expects. */
  readonly publicKeyBase64: string;
}

export interface PersistedIdentityFileV1 {
  v: 1;
  /** JWK export of the ECDH P-256 private key (see this module's doc comment for the storage-backend decision). */
  privateKeyJwk: JsonWebKey;
  /** Base64 raw EC point for the matching public key, stored alongside rather than re-derived from the JWK on load. */
  publicKeyRaw: string;
}

/**
 * Serializes `keyPair`/`publicKeyRaw` into the exact JSON string
 * `NodeIdentityStore`'s own file-fallback `persist()` writes (and `load()`
 * reads back) — extracted so `./ssh/provision-and-pair.ts` can pre-seed a
 * not-yet-started remote node's identity file in the identical format
 * without duplicating this shape, rather than hand-rolling a second
 * "identity file" convention.
 */
export async function serializePersistedIdentityFile(
  keyPair: EcdhKeyPair,
  publicKeyRaw: Uint8Array,
): Promise<string> {
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const file: PersistedIdentityFileV1 = {
    v: IDENTITY_SCHEMA_VERSION,
    privateKeyJwk,
    publicKeyRaw: Buffer.from(publicKeyRaw).toString('base64'),
  };
  return JSON.stringify(file);
}

export interface NodeIdentityStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()` (this package's existing `~/.loombox/node` convention, shared with `SshTargetStore`). */
  stateDir?: string;
  /**
   * Injectable for tests: overrides how the OS-native keyring backend is
   * probed/built (issue #118). Defaults to `keyring.ts`'s
   * `createOsKeyringBackend`. Pass `async () => undefined` to force the
   * 0600-file fallback deterministically, without depending on the test
   * host's actual keyring session (which `createOsKeyringBackend` itself
   * already returns `undefined` for on this devbox — see `keyring.test.ts`).
   */
  osKeyringBackendFactory?: () => Promise<KeyringBackend | undefined>;
}

/**
 * Persists this node's own stable ECDH P-256 identity keypair across
 * restarts (SPEC §5.1 "Connects outbound to the relay and registers as an
 * E2E device", §8, §16; issues #64, #118).
 *
 * **Storage backend.** SPEC §16 asks for a headless-Node-safe OS-native
 * keyring binding (`@napi-rs/keyring`) as the primary path, falling back to
 * permission-scoped storage for a box with no keyring session (issue #118).
 * This store tries the OS-native backend first (`./keyring.ts`'s
 * `createOsKeyringBackend`, tried lazily on first `load`/`create` call, not
 * in the constructor) and, the moment that fails, falls back to exactly the
 * behavior this class always had: a single JSON file under this node's
 * state dir holding a JWK export of the private key, written (and
 * re-chmod'd on every write, so overwriting an existing file can't leave it
 * at a looser mode) at **0600** — owner read/write only, mirroring the
 * file-permission discipline SSH itself enforces on `~/.ssh/id_rsa`, the
 * closest real analog for a "permission-scoped secret" SPEC §16's grounding
 * note calls for.
 *
 * That fallback file stays **unencrypted** (beyond its 0600 permissions),
 * deliberately: this node's own identity keypair is the bootstrap root every
 * *other* secret's fallback encryption key derives from (`./keyring.ts`'s
 * `FileKeyringBackend`, used by `mcp-secrets.ts`'s per-project secret
 * values) — there is nothing left for the identity itself to derive its own
 * wrapping key from. `NodeIdentity`/`NodeIdentityStore`'s public API is
 * unchanged by any of this (same `exists`/`load`/`create`/`loadOrCreate`
 * shape a caller already used before issue #118), so this is purely an
 * internal storage-backend swap. Every time the fallback path actually
 * creates a fresh keypair, it logs (`console.warn`) rather than doing so
 * silently; `NodeKeyring` (used indirectly, only once the OS probe result is
 * known) logs its own fallback choice too.
 */
export class NodeIdentityStore {
  private readonly stateDir: string;
  private readonly filePath: string;
  /** This store's OS-keyring `account` — scoped to its own `stateDir` so two `NodeIdentityStore`s (two node instances) sharing one OS keyring session never collide on the same entry. */
  private readonly keyringAccount: string;
  private readonly osKeyringBackendFactory: () => Promise<KeyringBackend | undefined>;
  private osBackend: KeyringBackend | undefined | typeof UNPROBED = UNPROBED;

  constructor(options: NodeIdentityStoreOptions = {}) {
    this.stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(this.stateDir, IDENTITY_FILE_NAME);
    this.keyringAccount = this.stateDir;
    this.osKeyringBackendFactory = options.osKeyringBackendFactory ?? createOsKeyringBackend;
  }

  private async getOsBackend(): Promise<KeyringBackend | undefined> {
    if (this.osBackend === UNPROBED) {
      this.osBackend = await this.osKeyringBackendFactory().catch(() => undefined);
    }
    return this.osBackend;
  }

  /** `true` if a keypair is already persisted for this store — via the OS keyring when available, else the 0600 file. */
  async exists(): Promise<boolean> {
    const osBackend = await this.getOsBackend();
    if (osBackend) {
      return (await osBackend.get(IDENTITY_KEYRING_SERVICE, this.keyringAccount)) !== undefined;
    }
    return existsSync(this.filePath);
  }

  /** Reads and imports the persisted keypair, or `undefined` if none exists yet. */
  async load(): Promise<NodeIdentity | undefined> {
    const osBackend = await this.getOsBackend();
    let raw: string | undefined;
    if (osBackend) {
      raw = await osBackend.get(IDENTITY_KEYRING_SERVICE, this.keyringAccount);
    } else if (existsSync(this.filePath)) {
      raw = readFileSync(this.filePath, 'utf8');
    }
    if (raw === undefined) return undefined;

    const parsed = JSON.parse(raw) as PersistedIdentityFileV1 | null;
    // Defensive: a corrupt/empty stored value (e.g. the literal "null", or a
    // shape from an older format) is treated as "no identity yet" rather than
    // crashing on a null-property read, so loadOrCreate regenerates cleanly.
    if (parsed === null || typeof parsed !== 'object' || !parsed.privateKeyJwk) {
      return undefined;
    }

    const privateKey = await crypto.subtle.importKey(
      'jwk',
      parsed.privateKeyJwk,
      ECDH_ALGORITHM,
      true,
      ['deriveBits', 'deriveKey'],
    );
    const publicKeyRaw = new Uint8Array(Buffer.from(parsed.publicKeyRaw, 'base64'));
    const publicKey = await importPublicKeyRaw(publicKeyRaw);

    return this.toNodeIdentity({ publicKey, privateKey }, publicKeyRaw);
  }

  /** Generates a fresh keypair and persists it, overwriting anything already at this path. */
  async create(): Promise<NodeIdentity> {
    const keyPair = await generateEcdhKeyPair();
    const publicKeyRaw = await exportPublicKeyRaw(keyPair.publicKey);
    await this.persist(keyPair, publicKeyRaw);
    return this.toNodeIdentity(keyPair, publicKeyRaw);
  }

  /**
   * Loads the persisted keypair if one exists, else generates and persists a
   * fresh one — the "on first run with no existing keypair, generate one;
   * restarting reloads the same keypair" behavior issue #64 asks for. This is
   * the entry point a node's bootstrap actually calls.
   */
  async loadOrCreate(): Promise<NodeIdentity> {
    const existing = await this.load();
    if (existing) return existing;

    const osBackend = await this.getOsBackend();
    console.warn(
      `NodeIdentityStore: no identity keypair found under ${this.stateDir}; generating a new one ` +
        (osBackend
          ? '(OS-native keyring storage — issue #118).'
          : "(headless-fallback storage — a 0600 file, not an OS keyring; see this module's doc comment)."),
    );
    return this.create();
  }

  private async persist(keyPair: EcdhKeyPair, publicKeyRaw: Uint8Array): Promise<void> {
    const raw = await serializePersistedIdentityFile(keyPair, publicKeyRaw);

    const osBackend = await this.getOsBackend();
    if (osBackend) {
      await osBackend.set(IDENTITY_KEYRING_SERVICE, this.keyringAccount, raw);
      return;
    }

    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.filePath, raw, { mode: 0o600 });
    // `writeFileSync`'s `mode` only applies when the file is newly created
    // (and is still subject to umask); explicitly chmod afterwards so this
    // file ends up exactly 0600 whether it's a fresh write or an overwrite.
    chmodSync(this.filePath, 0o600);
  }

  private toNodeIdentity(keyPair: EcdhKeyPair, publicKeyRaw: Uint8Array): NodeIdentity {
    return {
      keyPair,
      publicKeyRaw,
      publicKeyBase64: Buffer.from(publicKeyRaw).toString('base64'),
    };
  }
}

/** A distinct sentinel (rather than `undefined`) for "the OS backend probe hasn't run yet" — `undefined` itself is the valid "probed, and none available" result. */
const UNPROBED = Symbol('unprobed');
