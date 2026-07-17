import type { webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  importPublicKeyRaw,
  type EcdhKeyPair,
} from '@loombox/crypto';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

type JsonWebKey = webcrypto.JsonWebKey;

const ECDH_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const;
const IDENTITY_FILE_NAME = 'identity.json';
const IDENTITY_SCHEMA_VERSION = 1;

/** This node's own stable E2E device identity (SPEC §5.1 "registers as an E2E device", §8). */
export interface NodeIdentity {
  readonly keyPair: EcdhKeyPair;
  /** Raw uncompressed EC point (0x04 || X || Y), the compact wire form. */
  readonly publicKeyRaw: Uint8Array;
  /** Base64 encoding of `publicKeyRaw` — the exact shape `NodeDaemonOptions.devicePublicKey` expects. */
  readonly publicKeyBase64: string;
}

interface PersistedIdentityFileV1 {
  v: 1;
  /** JWK export of the ECDH P-256 private key (see this module's doc comment for the storage-backend decision). */
  privateKeyJwk: JsonWebKey;
  /** Base64 raw EC point for the matching public key, stored alongside rather than re-derived from the JWK on load. */
  publicKeyRaw: string;
}

export interface NodeIdentityStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()` (this package's existing `~/.loombox/node` convention, shared with `SshTargetStore`). */
  stateDir?: string;
}

/**
 * Persists this node's own stable ECDH P-256 identity keypair across
 * restarts (SPEC §5.1 "Connects outbound to the relay and registers as an
 * E2E device", §8, §16; issue #64).
 *
 * **Storage backend.** SPEC §16 asks for a headless-Node-safe OS-native
 * keyring binding (`@napi-rs/keyring`) as the primary path, "decide
 * fail-closed vs 0600-file fallback" for a box with no keyring session. This
 * PR's explicit no-new-deps scope means no `@napi-rs/keyring` dependency is
 * added here; wiring that in as the primary backend — falling back to this
 * class only when no keyring session exists — is tracked separately
 * (backlog: "Implement node-side secrets-at-rest via native OS keyring").
 * What ships here is the **fallback** half on its own: a single JSON file
 * under this node's state dir holding a JWK export of the private key,
 * written (and re-chmod'd on every write, so overwriting an existing file
 * can't leave it at a looser mode) at **0600** — owner read/write only,
 * mirroring the file-permission discipline SSH itself enforces on
 * `~/.ssh/id_rsa`, the closest real analog for a "permission-scoped secret"
 * SPEC §16's grounding note calls for. `NodeIdentity`/`NodeIdentityStore`
 * are kept as their own narrow, self-contained shape (no OS-keyring-specific
 * types leak into their API) precisely so a future keyring-backed
 * implementation can be swapped in behind them without callers changing.
 * Every time this fallback path actually creates a fresh keypair, it logs
 * (`console.warn`) rather than doing so silently.
 */
export class NodeIdentityStore {
  private readonly stateDir: string;
  private readonly filePath: string;

  constructor(options: NodeIdentityStoreOptions = {}) {
    this.stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(this.stateDir, IDENTITY_FILE_NAME);
  }

  /** `true` if a keypair is already persisted at this store's path. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** Reads and imports the persisted keypair, or `undefined` if none exists yet. */
  async load(): Promise<NodeIdentity | undefined> {
    if (!existsSync(this.filePath)) return undefined;

    const raw = readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedIdentityFileV1;

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

    console.warn(
      `NodeIdentityStore: no identity keypair found under ${this.stateDir}; generating a new one ` +
        "(headless-fallback storage — a 0600 file, not an OS keyring; see this module's doc comment).",
    );
    return this.create();
  }

  private async persist(keyPair: EcdhKeyPair, publicKeyRaw: Uint8Array): Promise<void> {
    mkdirSync(this.stateDir, { recursive: true });
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const file: PersistedIdentityFileV1 = {
      v: IDENTITY_SCHEMA_VERSION,
      privateKeyJwk,
      publicKeyRaw: Buffer.from(publicKeyRaw).toString('base64'),
    };
    writeFileSync(this.filePath, JSON.stringify(file), { mode: 0o600 });
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
