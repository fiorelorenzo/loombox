import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectedAccountSecretRef, type ConnectedAccount } from '@loombox/protocol';

import { NodeAccountPresence } from './account-presence';
import { createConnectedAccountKeyring } from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import type { KeyringBackend } from './keyring';

/**
 * `NodeAccountPresence` (SPEC §7.26 "Node-locality", issue #228). Every
 * test below runs against the 0600-file keyring fallback
 * (`osKeyringBackendFactory: async () => undefined`), never a real OS
 * keyring session — this package's own established convention
 * (`github-connect.test.ts`, `jira-connect.test.ts`).
 */

const REAL_TOKEN = 'gho_this-is-the-actual-secret-never-leaked';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-account-presence-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function presence(): NodeAccountPresence {
  return new NodeAccountPresence({ stateDir, osKeyringBackendFactory: async () => undefined });
}

function accountFixture(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base = {
    id: 'github:github.com:1111',
    provider: 'github' as const,
    host: 'github.com',
    providerAccountId: '1111',
    label: 'octocat',
    credentialSource: 'device_flow' as const,
    scopes: ['repo'],
    capabilities: ['repo', 'issues'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef('github:github.com:1111'),
  };
  return { ...base, ...overrides };
}

describe('NodeAccountPresence.isPresent — laziness and correctness', () => {
  it('reports false for an account this node has never connected', async () => {
    const account = accountFixture();
    expect(await presence().isPresent(account)).toBe(false);
  });

  it("reports true once the keyring actually holds the account's secret", async () => {
    const keyring = createConnectedAccountKeyringForTest(stateDir);
    await keyring.set('loombox-connected-account', accountFixture().secretRef, REAL_TOKEN);

    expect(await presence().isPresent(accountFixture())).toBe(true);
  });

  it('constructing NodeAccountPresence does no I/O — an unrelated stateDir with no keyring file never throws just from instantiation', () => {
    expect(
      () => new NodeAccountPresence({ stateDir: path.join(stateDir, 'never-created') }),
    ).not.toThrow();
  });

  it('never probes the keyring for an account nobody asked about (lazy, not eager)', async () => {
    const getSpy = vi.fn(async () => undefined);
    const stubBackend: KeyringBackend = { get: getSpy, set: vi.fn(), delete: vi.fn() };
    const p = new NodeAccountPresence({
      stateDir,
      osKeyringBackendFactory: async () => stubBackend,
    });

    // No isPresent call yet — the stub must never have been touched.
    expect(getSpy).not.toHaveBeenCalled();

    await p.isPresent(accountFixture());
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});

describe('NodeAccountPresence — caching', () => {
  it('caches the answer: a second isPresent call for the same secretRef does not re-probe the keyring', async () => {
    const getSpy = vi.fn(async () => 'stored-value');
    const stubBackend: KeyringBackend = { get: getSpy, set: vi.fn(), delete: vi.fn() };
    const p = new NodeAccountPresence({
      stateDir,
      osKeyringBackendFactory: async () => stubBackend,
    });
    const account = accountFixture();

    expect(await p.isPresent(account)).toBe(true);
    expect(await p.isPresent(account)).toBe(true);
    expect(await p.isPresent(account)).toBe(true);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('concurrent isPresent calls for the same secretRef share one probe (no duplicate keyring reads)', async () => {
    const getSpy = vi.fn(async () => 'stored-value');
    const stubBackend: KeyringBackend = { get: getSpy, set: vi.fn(), delete: vi.fn() };
    const p = new NodeAccountPresence({
      stateDir,
      osKeyringBackendFactory: async () => stubBackend,
    });
    const account = accountFixture();

    const [a, b] = await Promise.all([p.isPresent(account), p.isPresent(account)]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidate(secretRef) forces the next isPresent call to re-probe, picking up a keyring change', async () => {
    const keyring = createConnectedAccountKeyringForTest(stateDir);
    const account = accountFixture();
    const p = presence();

    expect(await p.isPresent(account)).toBe(false);

    // A credential lands in the keyring after the cached "absent" answer —
    // without invalidate(), isPresent would keep answering false forever.
    await keyring.set('loombox-connected-account', account.secretRef, REAL_TOKEN);
    expect(await p.isPresent(account)).toBe(false); // still cached

    p.invalidate(account.secretRef);
    expect(await p.isPresent(account)).toBe(true);
  });

  it('invalidateAll() clears every cached secretRef, not just one', async () => {
    const keyring = createConnectedAccountKeyringForTest(stateDir);
    const a = accountFixture({
      id: 'github:github.com:1111',
      secretRef: connectedAccountSecretRef('github:github.com:1111'),
    });
    const b = accountFixture({
      id: 'github:github.com:2222',
      secretRef: connectedAccountSecretRef('github:github.com:2222'),
    });
    const p = presence();

    expect(await p.isPresent(a)).toBe(false);
    expect(await p.isPresent(b)).toBe(false);

    await keyring.set('loombox-connected-account', a.secretRef, REAL_TOKEN);
    await keyring.set('loombox-connected-account', b.secretRef, REAL_TOKEN);
    p.invalidateAll();

    expect(await p.isPresent(a)).toBe(true);
    expect(await p.isPresent(b)).toBe(true);
  });

  it('a keyring failure is never cached as "absent" — the next call retries instead of repeating the wrong answer', async () => {
    let shouldFail = true;
    const stubBackend: KeyringBackend = {
      get: vi.fn(async () => {
        if (shouldFail) throw new Error('keyring session dropped');
        return 'stored-value';
      }),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const p = new NodeAccountPresence({
      stateDir,
      osKeyringBackendFactory: async () => stubBackend,
    });
    const account = accountFixture();

    await expect(p.isPresent(account)).rejects.toThrow('keyring session dropped');

    shouldFail = false;
    expect(await p.isPresent(account)).toBe(true);
  });
});

describe('NodeAccountPresence — never leaks the credential', () => {
  it('isPresent returns a plain boolean, never the stored secret value, even when the keyring holds a real-looking token', async () => {
    const keyring = createConnectedAccountKeyringForTest(stateDir);
    const account = accountFixture();
    await keyring.set('loombox-connected-account', account.secretRef, REAL_TOKEN);

    const result = await presence().isPresent(account);
    expect(result).toBe(true);
    expect(typeof result).toBe('boolean');
    // Defensive: even serialized, the answer can never contain the token —
    // it structurally cannot, since it is a boolean, but assert the
    // property this whole class exists to guarantee.
    expect(JSON.stringify(result)).not.toContain(REAL_TOKEN);
  });

  it('a full connect -> isPresent round trip never surfaces the token anywhere a relay-bound payload could pick it up', async () => {
    const p = presence();
    const github = new GithubConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
      onCredentialChanged: p.onConnectOrDisconnect,
    });

    const connected = await github.connect({
      clientId: 'test-client-id',
      fetchImpl: stubGithubDeviceFlowFetch(),
      sleep: async () => {},
    });

    const isPresentResult = await p.isPresent(connected);
    expect(isPresentResult).toBe(true);

    // The only thing a caller building a relay/UI payload around this
    // check could serialize is `connected` (the metadata row, already
    // proven token-free by github-connect.test.ts) and the boolean
    // itself — assert neither carries the token.
    expect(JSON.stringify({ account: connected, present: isPresentResult })).not.toContain(
      REAL_TOKEN,
    );
  });
});

describe('NodeAccountPresence — connect/disconnect invalidation (issue #228 acceptance)', () => {
  it('a connect on this node is immediately reflected — no stale "absent" after onConnectOrDisconnect fires', async () => {
    const p = presence();
    const github = new GithubConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
      onCredentialChanged: p.onConnectOrDisconnect,
    });

    const account = accountFixture();
    expect(await p.isPresent(account)).toBe(false); // caches "absent" before connecting

    const connected = await github.connect({
      clientId: 'test-client-id',
      fetchImpl: stubGithubDeviceFlowFetch(),
      sleep: async () => {},
    });

    expect(await p.isPresent(connected)).toBe(true);
  });

  it('a disconnect on this node is immediately reflected — no stale "present" after onConnectOrDisconnect fires', async () => {
    const p = presence();
    const github = new GithubConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
      onCredentialChanged: p.onConnectOrDisconnect,
    });

    const connected = await github.connect({
      clientId: 'test-client-id',
      fetchImpl: stubGithubDeviceFlowFetch(),
      sleep: async () => {},
    });
    expect(await p.isPresent(connected)).toBe(true); // caches "present" before disconnecting

    await github.deleteAccessToken(connected);
    expect(await p.isPresent(connected)).toBe(false);
  });

  it('without the onCredentialChanged hook wired, a connect would otherwise leave a stale cached answer — this is what the hook exists to prevent', async () => {
    const p = presence();
    // Deliberately NOT wiring onCredentialChanged, to demonstrate the
    // failure mode the hook fixes.
    const github = new GithubConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
    });

    const account = accountFixture();
    expect(await p.isPresent(account)).toBe(false);

    await github.connect({
      clientId: 'test-client-id',
      fetchImpl: stubGithubDeviceFlowFetch(),
      sleep: async () => {},
    });

    expect(await p.isPresent(account)).toBe(false); // stale, proving the hook is load-bearing
    p.invalidate(account.secretRef);
    expect(await p.isPresent(account)).toBe(true); // manual invalidate() still recovers it
  });
});

// --- test helpers -------------------------------------------------------

function createConnectedAccountKeyringForTest(dir: string) {
  return createConnectedAccountKeyring({
    stateDir: dir,
    osKeyringBackendFactory: async () => undefined,
  });
}

/** Stubs GitHub's device-flow + identity endpoints (mirrors `github-connect.test.ts`'s own `stubGithubFetch`) so `GithubConnectService.connect` runs end to end without a real network call. */
function stubGithubDeviceFlowFetch(): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/login/device/code')) {
      return jsonResponse(200, {
        device_code: 'devcode',
        user_code: 'USER-CODE',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 0,
      });
    }
    if (url.includes('/login/oauth/access_token')) {
      return jsonResponse(200, {
        access_token: REAL_TOKEN,
        token_type: 'bearer',
        scope: 'repo,read:user,read:org',
      });
    }
    if (url.includes('/user')) {
      return jsonResponse(200, { id: 1111, login: 'octocat', avatar_url: undefined });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return impl;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
