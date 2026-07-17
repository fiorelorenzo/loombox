import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSharedSecretBits, generateEcdhKeyPair } from '@loombox/crypto';

import { NodeIdentityStore } from './identity';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-identity-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('NodeIdentityStore', () => {
  it('has no identity yet against a fresh state dir', async () => {
    const store = new NodeIdentityStore({ stateDir });
    expect(store.exists()).toBe(false);
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('create() generates a fresh keypair and persists it, exposing a base64 public key', async () => {
    const store = new NodeIdentityStore({ stateDir });
    const identity = await store.create();

    expect(identity.publicKeyRaw).toBeInstanceOf(Uint8Array);
    // Uncompressed EC point for P-256: 0x04 || 32-byte X || 32-byte Y = 65 bytes.
    expect(identity.publicKeyRaw.length).toBe(65);
    expect(identity.publicKeyRaw[0]).toBe(0x04);
    expect(identity.publicKeyBase64).toBe(Buffer.from(identity.publicKeyRaw).toString('base64'));
    expect(store.exists()).toBe(true);
  });

  it('persists the identity file at 0600 (owner read/write only)', async () => {
    const store = new NodeIdentityStore({ stateDir });
    await store.create();

    const info = await stat(path.join(stateDir, 'identity.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('reloading returns the exact same keypair (same public key, and the private key derives the same shared secret)', async () => {
    const store = new NodeIdentityStore({ stateDir });
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
    const first = new NodeIdentityStore({ stateDir });
    const identityA = await first.loadOrCreate();

    const second = new NodeIdentityStore({ stateDir }); // simulates a restart: fresh instance, same on-disk state
    const identityB = await second.loadOrCreate();

    expect(identityB.publicKeyBase64).toBe(identityA.publicKeyBase64);
  });

  it('loadOrCreate() logs (not silently) when it falls back to generating a fresh keypair', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new NodeIdentityStore({ stateDir });

    await store.loadOrCreate();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NodeIdentityStore'));
    warnSpy.mockRestore();
  });

  it('two different stores (two different node instances) generate different keypairs', async () => {
    const stateDirB = await mkdtemp(path.join(tmpdir(), 'loombox-node-identity-test-b-'));
    try {
      const storeA = new NodeIdentityStore({ stateDir });
      const storeB = new NodeIdentityStore({ stateDir: stateDirB });

      const identityA = await storeA.create();
      const identityB = await storeB.create();

      expect(identityA.publicKeyBase64).not.toBe(identityB.publicKeyBase64);
    } finally {
      await rm(stateDirB, { recursive: true, force: true });
    }
  });

  it('create() overwrites any existing identity at the same path with a fresh one', async () => {
    const store = new NodeIdentityStore({ stateDir });
    const first = await store.create();
    const second = await store.create();

    expect(second.publicKeyBase64).not.toBe(first.publicKeyBase64);
    const reloaded = await store.load();
    expect(reloaded!.publicKeyBase64).toBe(second.publicKeyBase64);
  });
});
