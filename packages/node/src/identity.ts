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
 * E2E device", §8, §16; issues #64, #118, #815).
 *
 * **Storage backend — the 0600 file is the source of truth; the OS-native
 * keyring is a best-effort cache in front of it, never the only copy**
 * (issue #815, `docs/superpowers/specs/2026-08-06-node-lifecycle-decisions.md`
 * C1-2). Every `persist()` writes the file first — a single JSON file under
 * this node's state dir holding a JWK export of the private key, written
 * (and re-chmod'd on every write, so overwriting an existing file can't
 * leave it at a looser mode) at **0600**, owner read/write only, mirroring
 * the file-permission discipline SSH itself enforces on `~/.ssh/id_rsa` —
 * and only then best-effort warms `./keyring.ts`'s `createOsKeyringBackend`
 * cache, when one is available, tolerating a write failure there since the
 * file is what every future `load()` actually depends on.
 *
 * `load()` mirrors that priority: the file wins whenever it has a value.
 * An OS-keyring cache that comes back empty or stale next to a populated
 * file — the exact failure this issue fixes, most often a reboot wiping a
 * volatile Linux kernel keyring (`createOsKeyringBackend` already refuses
 * to hand back a backend it detects as volatile, but an *injected* test
 * backend, or a session that goes stale mid-process, hits this same path)
 * — is treated as a cold cache, not as "no identity": the file's keypair is
 * adopted and the cache is reseeded from it, logged once via
 * `console.warn`, never silently. The one case the file *doesn't* win is a
 * pre-#815 install (or any other caller that wrote straight to the OS
 * backend) where the cache holds a value and the file doesn't exist yet —
 * that value is adopted and the file is written from it, so the store is
 * self-healing into the new invariant either direction. Generation only
 * ever happens when both are empty.
 *
 * The file stays **unencrypted** (beyond its 0600 permissions), deliberately:
 * this node's own identity keypair is the bootstrap root every *other*
 * secret's fallback encryption key derives from (`./keyring.ts`'s
 * `FileKeyringBackend`, used by `mcp-secrets.ts`'s per-project secret
 * values) — there is nothing left for the identity itself to derive its own
 * wrapping key from. `NodeIdentity`/`NodeIdentityStore`'s public API is
 * unchanged by any of this (same `exists`/`load`/`create`/`loadOrCreate`
 * shape a caller already used before issue #118).
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

  /** `true` if a keypair is already persisted for this store — via the durable file, or (for a not-yet-migrated legacy install) the OS-native keyring cache alone. */
  async exists(): Promise<boolean> {
    if (existsSync(this.filePath)) return true;
    const osBackend = await this.getOsBackend();
    if (!osBackend) return false;
    return (await osBackend.get(IDENTITY_KEYRING_SERVICE, this.keyringAccount)) !== undefined;
  }

  /**
   * Reads and imports the persisted keypair, or `undefined` if none exists
   * yet. The durable file wins whenever it has a value (this class's own
   * doc comment); an empty/stale OS-keyring cache next to a populated file
   * is reseeded from it, not treated as "no identity" — issue #815.
   */
  async load(): Promise<NodeIdentity | undefined> {
    const fileRaw = existsSync(this.filePath) ? readFileSync(this.filePath, 'utf8') : undefined;
    const osBackend = await this.getOsBackend();
    const cacheRaw = osBackend
      ? await osBackend.get(IDENTITY_KEYRING_SERVICE, this.keyringAccount)
      : undefined;

    let raw: string | undefined;
    if (fileRaw !== undefined) {
      raw = fileRaw;
      if (osBackend && cacheRaw !== fileRaw) {
        console.warn(
          cacheRaw === undefined
            ? `NodeIdentityStore: adopted the existing identity from the durable file under ${this.stateDir} (the OS-native keyring cache was empty — issue #815); reseeded the cache.`
            : `NodeIdentityStore: the OS-native keyring cache under ${this.stateDir} disagreed with the durable file; repaired the cache from the file, the source of truth.`,
        );
        await osBackend
          .set(IDENTITY_KEYRING_SERVICE, this.keyringAccount, raw)
          // Best-effort: an unwritable cache doesn't block using the file,
          // which is what every future load actually relies on.
          .catch(() => {});
      }
    } else if (cacheRaw !== undefined) {
      // No durable file yet, but the OS-native cache has a value — a
      // pre-#815 install (or any caller that wrote straight to the OS
      // backend). Adopt it and start writing the file from now on so this
      // store self-heals into the new invariant.
      raw = cacheRaw;
      console.warn(
        `NodeIdentityStore: adopted an identity from the OS-native keyring cache under ${this.stateDir} with no durable file yet; wrote the file now.`,
      );
      this.writeFile(raw);
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
   * the entry point a node's bootstrap actually calls, so it also logs once,
   * unconditionally, which identity store is actually in use (issue #815) —
   * not only on the generate path, so an operator can tell from the log
   * alone whether a restart is expected to survive a reboot.
   */
  async loadOrCreate(): Promise<NodeIdentity> {
    const osBackend = await this.getOsBackend();
    console.log(
      `NodeIdentityStore: identity storage under ${this.stateDir} is the durable 0600 file` +
        (osBackend
          ? ', with an OS-native keyring cache in front of it (issue #815).'
          : ' (no durable OS-native keyring session available — see keyring.ts).'),
    );

    const existing = await this.load();
    if (existing) return existing;

    console.warn(
      `NodeIdentityStore: no identity keypair found under ${this.stateDir}; generating a new one.`,
    );
    return this.create();
  }

  /**
   * Writes the identity `raw` JSON to the durable file — always the
   * source-of-truth write, never the only one an OS-keyring caller relies
   * on. `persist()` (fresh writes) and `load()` (reseeding after adopting
   * a legacy OS-only value) both funnel through this.
   */
  private writeFile(raw: string): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.filePath, raw, { mode: 0o600 });
    // `writeFileSync`'s `mode` only applies when the file is newly created
    // (and is still subject to umask); explicitly chmod afterwards so this
    // file ends up exactly 0600 whether it's a fresh write or an overwrite.
    chmodSync(this.filePath, 0o600);
  }

  private async persist(keyPair: EcdhKeyPair, publicKeyRaw: Uint8Array): Promise<void> {
    const raw = await serializePersistedIdentityFile(keyPair, publicKeyRaw);
    this.writeFile(raw);

    const osBackend = await this.getOsBackend();
    if (osBackend) {
      // Best-effort cache warm: a failure here never blocks using the file
      // above, which is what `load()` actually depends on.
      await osBackend.set(IDENTITY_KEYRING_SERVICE, this.keyringAccount, raw).catch(() => {});
    }
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
