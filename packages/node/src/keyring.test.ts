import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSharedSecretBits, generateEcdhKeyPair, importAesGcmKey } from '@loombox/crypto';

import {
  createOsKeyringBackend,
  FileKeyringBackend,
  NodeKeyring,
  type KeyringBackend,
} from './keyring';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-keyring-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** An in-memory fake `KeyringBackend`, standing in for a real OS session in tests that need to prove `NodeKeyring` actually prefers it over the file fallback. */
function fakeBackend(): KeyringBackend & { data: Map<string, string> } {
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

describe('createOsKeyringBackend', () => {
  it('returns undefined on this headless devbox (no keyring session) — verifies issue #118 fallback path is actually exercised, not just theorized', async () => {
    const backend = await createOsKeyringBackend();
    expect(backend).toBeUndefined();
  });
});

describe('FileKeyringBackend', () => {
  it('has no entry yet against a fresh file', async () => {
    const backend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    await expect(backend.get('svc', 'acct')).resolves.toBeUndefined();
  });

  it('round-trips a plaintext value (no encryptionKey configured)', async () => {
    const backend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    await backend.set('svc', 'acct', 'sekrit');
    await expect(backend.get('svc', 'acct')).resolves.toBe('sekrit');
  });

  it('persists the file at 0600', async () => {
    const filePath = path.join(stateDir, 'secrets.json');
    const backend = new FileKeyringBackend({ filePath });
    await backend.set('svc', 'acct', 'sekrit');

    const info = await stat(filePath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('delete() removes an entry, and is a no-op for one that was never set', async () => {
    const backend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    await backend.set('svc', 'acct', 'sekrit');
    await backend.delete('svc', 'acct');
    await expect(backend.get('svc', 'acct')).resolves.toBeUndefined();

    await expect(backend.delete('svc', 'never-set')).resolves.toBeUndefined();
  });

  it('keeps multiple entries independent, addressed by (service, account)', async () => {
    const backend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    await backend.set('svc-a', 'acct', 'value-a');
    await backend.set('svc-b', 'acct', 'value-b');
    await backend.set('svc-a', 'other-acct', 'value-c');

    await expect(backend.get('svc-a', 'acct')).resolves.toBe('value-a');
    await expect(backend.get('svc-b', 'acct')).resolves.toBe('value-b');
    await expect(backend.get('svc-a', 'other-acct')).resolves.toBe('value-c');
  });

  it('survives a fresh instance pointed at the same file (a process restart)', async () => {
    const filePath = path.join(stateDir, 'secrets.json');
    await new FileKeyringBackend({ filePath }).set('svc', 'acct', 'sekrit');

    const reloaded = new FileKeyringBackend({ filePath });
    await expect(reloaded.get('svc', 'acct')).resolves.toBe('sekrit');
  });

  describe('with an encryptionKey configured', () => {
    async function makeKey() {
      const pair = await generateEcdhKeyPair();
      const bits = await deriveSharedSecretBits(pair.privateKey, pair.publicKey);
      return importAesGcmKey(bits);
    }

    it('round-trips a value, and the on-disk file never contains it in the clear', async () => {
      const key = await makeKey();
      const filePath = path.join(stateDir, 'secrets.json');
      const backend = new FileKeyringBackend({ filePath, encryptionKey: async () => key });

      await backend.set('svc', 'acct', 'super-secret-value');
      await expect(backend.get('svc', 'acct')).resolves.toBe('super-secret-value');

      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(filePath, 'utf8');
      expect(raw).not.toContain('super-secret-value');
    });

    it('fails to decrypt under the wrong key (AAD binds each entry to its own service/account)', async () => {
      const filePath = path.join(stateDir, 'secrets.json');
      const keyA = await makeKey();
      const keyB = await makeKey();

      await new FileKeyringBackend({ filePath, encryptionKey: async () => keyA }).set(
        'svc',
        'acct',
        'value',
      );

      const wrongKeyBackend = new FileKeyringBackend({ filePath, encryptionKey: async () => keyB });
      await expect(wrongKeyBackend.get('svc', 'acct')).rejects.toThrow();
    });
  });
});

describe('NodeKeyring', () => {
  it('falls back to the file backend when no OS backend is available, and logs (not silently)', async () => {
    const fileBackend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    const keyring = new NodeKeyring({ fileBackend, osBackendFactory: async () => undefined });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await keyring.set('svc', 'acct', 'value');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NodeKeyring'));
    warnSpy.mockRestore();

    await expect(keyring.backendKind()).resolves.toBe('file');
    await expect(keyring.get('svc', 'acct')).resolves.toBe('value');
    // The fallback actually wrote to the injected file backend, not just an
    // in-memory illusion of one.
    await expect(fileBackend.get('svc', 'acct')).resolves.toBe('value');
  });

  it('falls back when the OS backend factory itself throws, rather than propagating', async () => {
    const fileBackend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    const keyring = new NodeKeyring({
      fileBackend,
      osBackendFactory: async () => {
        throw new Error('boom');
      },
    });

    await expect(keyring.backendKind()).resolves.toBe('file');
  });

  it('prefers a working OS backend over the file fallback, and never touches the file backend', async () => {
    const osBackend = fakeBackend();
    const fileBackend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    const keyring = new NodeKeyring({ fileBackend, osBackendFactory: async () => osBackend });

    await keyring.set('svc', 'acct', 'value');

    await expect(keyring.backendKind()).resolves.toBe('os');
    expect(osBackend.data.get('svc\0acct')).toBe('value');
    await expect(fileBackend.get('svc', 'acct')).resolves.toBeUndefined();
  });

  it('caches which backend it resolved to (probes only once)', async () => {
    const fileBackend = new FileKeyringBackend({ filePath: path.join(stateDir, 'secrets.json') });
    let probeCount = 0;
    const keyring = new NodeKeyring({
      fileBackend,
      osBackendFactory: async () => {
        probeCount += 1;
        return undefined;
      },
    });

    await keyring.set('svc', 'a', '1');
    await keyring.set('svc', 'b', '2');
    await keyring.get('svc', 'a');

    expect(probeCount).toBe(1);
  });
});
