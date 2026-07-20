import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSharedSecretBits, generateEcdhKeyPair } from '@loombox/crypto';

import { NodeIdentityStore, type NodeIdentityStoreOptions } from './identity';
import type { KeyringBackend } from './keyring';

let stateDir: string;

/** Forces the deterministic 0600-file fallback (issue #118), independent of whatever the real host's keyring session happens to be — the same real-world condition `keyring.test.ts` proves `createOsKeyringBackend()` itself already returns for this devbox. */
const noOsKeyring: NodeIdentityStoreOptions['osKeyringBackendFactory'] = async () => undefined;

/** An in-memory fake OS-native `KeyringBackend`, for tests that need to prove `NodeIdentityStore` actually prefers a working OS session over the file fallback. */
function fakeOsBackend(): KeyringBackend & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(service, account) {
      return data.get(`${service}\0${account}`);
    },
    async set(service, account, value) {
      data.set(`${service}\0${account}`, value);
    },
    async delete(service, account) {
      data.delete(`${service}\0${account}`);
    },
  };
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-identity-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('NodeIdentityStore', () => {
  it('has no identity yet against a fresh state dir', async () => {
    const store = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
    await expect(store.exists()).resolves.toBe(false);
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('create() generates a fresh keypair and persists it, exposing a base64 public key', async () => {
    const store = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
    const identity = await store.create();

    expect(identity.publicKeyRaw).toBeInstanceOf(Uint8Array);
    // Uncompressed EC point for P-256: 0x04 || 32-byte X || 32-byte Y = 65 bytes.
    expect(identity.publicKeyRaw.length).toBe(65);
    expect(identity.publicKeyRaw[0]).toBe(0x04);
    expect(identity.publicKeyBase64).toBe(Buffer.from(identity.publicKeyRaw).toString('base64'));
    await expect(store.exists()).resolves.toBe(true);
  });

  it('persists the identity file at 0600 (owner read/write only)', async () => {
    const store = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
    await store.create();

    const info = await stat(path.join(stateDir, 'identity.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('reloading returns the exact same keypair (same public key, and the private key derives the same shared secret)', async () => {
    const store = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
    const created = await store.create();

    const reloaded = await store.load();
    expect(reloaded).toBeDefined();
    expect(reloaded!.publicKeyBase64).toBe(created.publicKeyBase64);
    expect(Array.from(reloaded!.publicKeyRaw)).toEqual(Array.from(created.publicKeyRaw));

    // Prove the reloaded *private* key is functionally identical too (not
    // just that the public key round-tripped): both keypairs must derive the
    // same ECDH shared secret against a fixed peer.
    const peer = await generateEcdhKeyPair();
    const secretFromCreated = await deriveSharedSecretBits(
      created.keyPair.privateKey,
      peer.publicKey,
    );
    const secretFromReloaded = await deriveSharedSecretBits(
      reloaded!.keyPair.privateKey,
      peer.publicKey,
    );
    expect(Array.from(secretFromReloaded)).toEqual(Array.from(secretFromCreated));
  });

  it('loadOrCreate() creates on first run, then reloads the same identity on every subsequent call — including across a fresh NodeIdentityStore instance pointed at the same stateDir (a process restart)', async () => {
    const first = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
    const identityA = await first.loadOrCreate();

    // simulates a restart: fresh instance, same on-disk state
    const second = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
    const identityB = await second.loadOrCreate();

    expect(identityB.publicKeyBase64).toBe(identityA.publicKeyBase64);
  });

  it('loadOrCreate() logs (not silently) when it falls back to generating a fresh keypair', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });

    await store.loadOrCreate();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NodeIdentityStore'));
    warnSpy.mockRestore();
  });

  it('two different stores (two different node instances) generate different keypairs', async () => {
    const stateDirB = await mkdtemp(path.join(tmpdir(), 'loombox-node-identity-test-b-'));
    try {
      const storeA = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
      const storeB = new NodeIdentityStore({
        stateDir: stateDirB,
        osKeyringBackendFactory: noOsKeyring,
      });

      const identityA = await storeA.create();
      const identityB = await storeB.create();

      expect(identityA.publicKeyBase64).not.toBe(identityB.publicKeyBase64);
    } finally {
      await rm(stateDirB, { recursive: true, force: true });
    }
  });

  it('create() overwrites any existing identity at the same path with a fresh one', async () => {
    const store = new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring });
    const first = await store.create();
    const second = await store.create();

    expect(second.publicKeyBase64).not.toBe(first.publicKeyBase64);
    const reloaded = await store.load();
    expect(reloaded!.publicKeyBase64).toBe(second.publicKeyBase64);
  });

  describe('issue #118: OS-native keyring backend', () => {
    it('uses the OS backend when available, never touching the fallback file', async () => {
      const osBackend = fakeOsBackend();
      const store = new NodeIdentityStore({
        stateDir,
        osKeyringBackendFactory: async () => osBackend,
      });

      const created = await store.create();
      await expect(store.exists()).resolves.toBe(true);
      expect(osBackend.data.size).toBe(1);

      const { existsSync } = await import('node:fs');
      expect(existsSync(path.join(stateDir, 'identity.json'))).toBe(false);

      const reloaded = await store.load();
      expect(reloaded!.publicKeyBase64).toBe(created.publicKeyBase64);
    });

    it('two stores pointed at different stateDirs, sharing one OS backend, never collide on the same entry', async () => {
      const sharedOsBackend = fakeOsBackend();
      const stateDirB = await mkdtemp(path.join(tmpdir(), 'loombox-node-identity-test-b-'));
      try {
        const storeA = new NodeIdentityStore({
          stateDir,
          osKeyringBackendFactory: async () => sharedOsBackend,
        });
        const storeB = new NodeIdentityStore({
          stateDir: stateDirB,
          osKeyringBackendFactory: async () => sharedOsBackend,
        });

        const identityA = await storeA.create();
        const identityB = await storeB.create();

        expect(identityA.publicKeyBase64).not.toBe(identityB.publicKeyBase64);
        await expect(storeA.load().then((i) => i!.publicKeyBase64)).resolves.toBe(
          identityA.publicKeyBase64,
        );
        await expect(storeB.load().then((i) => i!.publicKeyBase64)).resolves.toBe(
          identityB.publicKeyBase64,
        );
      } finally {
        await rm(stateDirB, { recursive: true, force: true });
      }
    });

    it('falls back to the 0600 file when the OS backend factory throws rather than propagating', async () => {
      const store = new NodeIdentityStore({
        stateDir,
        osKeyringBackendFactory: async () => {
          throw new Error('no session');
        },
      });

      const created = await store.create();
      const info = await stat(path.join(stateDir, 'identity.json'));
      expect(info.mode & 0o777).toBe(0o600);

      const reloaded = await store.load();
      expect(reloaded!.publicKeyBase64).toBe(created.publicKeyBase64);
    });
  });
});
