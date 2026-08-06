import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSharedSecretBits, generateEcdhKeyPair, importAesGcmKey } from '@loombox/crypto';

import {
  createOsKeyringBackend,
  FileKeyringBackend,
  NodeKeyring,
  probeOsKeyringDurability,
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
  it('returns undefined when the OS keyring is disabled (LOOMBOX_KEYRING_DISABLE_OS=1, set for the whole node suite) — the 0600-file fallback path is what runs in tests', async () => {
    // The test suite forces the file fallback (vitest.setup.ts) so it never
    // depends on the ambient OS keyring, which is present in CI but not on the
    // headless devbox. This asserts that escape hatch actually short-circuits.
    expect(process.env.LOOMBOX_KEYRING_DISABLE_OS).toBe('1');
    const backend = await createOsKeyringBackend();
    expect(backend).toBeUndefined();
  });

  it('probes the real OS keyring when not disabled (best-effort; returns a backend or undefined depending on the host)', async () => {
    const prev = process.env.LOOMBOX_KEYRING_DISABLE_OS;
    delete process.env.LOOMBOX_KEYRING_DISABLE_OS;
    try {
      const backend = await createOsKeyringBackend();
      // Host-dependent (CI runner has a secret-service, the devbox does not),
      // so assert only the contract: either no backend, or a usable one.
      if (backend !== undefined) {
        expect(typeof backend.get).toBe('function');
      }
    } finally {
      if (prev !== undefined) process.env.LOOMBOX_KEYRING_DISABLE_OS = prev;
    }
  });

  it('issue #815: gates a successfully round-tripped backend on probeDurability, treating "not durable" as no backend at all', async () => {
    const prev = process.env.LOOMBOX_KEYRING_DISABLE_OS;
    delete process.env.LOOMBOX_KEYRING_DISABLE_OS;
    try {
      const rejected = await createOsKeyringBackend({ probeDurability: async () => false });
      expect(rejected).toBeUndefined();

      // When the real round-trip itself fails (no OS keyring session on this
      // host at all), there is nothing left to gate — same host-dependent
      // contract as the test above. Only exercise the accepted branch when a
      // genuine backend was actually reachable.
      const accepted = await createOsKeyringBackend({ probeDurability: async () => true });
      if (accepted !== undefined) {
        const service = 'loombox-keyring-durability-gate-test';
        const account = `probe-${Date.now()}`;
        await accepted.set(service, account, 'value');
        await expect(accepted.get(service, account)).resolves.toBe('value');
        await accepted.delete(service, account);
      }
    } finally {
      if (prev !== undefined) process.env.LOOMBOX_KEYRING_DISABLE_OS = prev;
    }
  });
});

describe('probeOsKeyringDurability (issue #815)', () => {
  it('treats macOS and Windows as always durable — Keychain and Credential Manager are disk-backed', async () => {
    await expect(
      probeOsKeyringDurability({ platform: 'darwin', runningProcessNames: async () => new Set() }),
    ).resolves.toBe(true);
    await expect(
      probeOsKeyringDurability({ platform: 'win32', runningProcessNames: async () => new Set() }),
    ).resolves.toBe(true);
  });

  it('on Linux, treats a running Secret Service daemon (gnome-keyring or either KDE Wallet backend) as durable', async () => {
    await expect(
      probeOsKeyringDurability({
        platform: 'linux',
        runningProcessNames: async () => new Set(['gnome-keyring-daemon']),
      }),
    ).resolves.toBe(true);
    await expect(
      probeOsKeyringDurability({
        platform: 'linux',
        runningProcessNames: async () => new Set(['kwalletd6']),
      }),
    ).resolves.toBe(true);
  });

  it('on Linux with no Secret Service session running, treats the backend as volatile — the exact condition measured on this devbox', async () => {
    await expect(
      probeOsKeyringDurability({
        platform: 'linux',
        runningProcessNames: async () => new Set(['bash', 'node', 'sshd']),
      }),
    ).resolves.toBe(false);
  });

  it('defaults to the real host platform and process list when called with no io override', async () => {
    // Host-dependent (this devbox has no Secret Service session; a CI runner
    // might) — assert only the contract: a boolean, never a thrown error.
    await expect(probeOsKeyringDurability()).resolves.toEqual(expect.any(Boolean));
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
