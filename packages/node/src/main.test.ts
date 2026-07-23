import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateAmk } from '@loombox/crypto';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { ConfigError } from './config';
import { installGracefulShutdown, start } from './main';
import type { AccountIdResolver } from './resolve-account-id';

function envFor(relayUrl: string, stateDir: string, amk: Uint8Array, nodeId = 'main-test-node') {
  return {
    LOOMBOX_RELAY_URL: relayUrl,
    LOOMBOX_NODE_ID: nodeId,
    LOOMBOX_AUTH_TOKEN: `acct-${nodeId}`,
    LOOMBOX_AMK: Buffer.from(amk).toString('base64'),
    LOOMBOX_NODE_STATE_DIR: stateDir,
  };
}

/**
 * Every test below that needs a *connecting* node stubs `resolveAccountId`
 * rather than relying on any default (issue #380's whole point): the
 * hermetic `startRelay()` these tests use runs in stub mode (no Better Auth
 * mounted), so the real `resolveAccountIdViaRelay` would 404 against it.
 * Mirrors the relay's own stub — same input token, same output — so a
 * connection made with this resolver behaves like the pre-#380 default did,
 * but *explicitly*, not as a silent fallback.
 */
const stubResolveAccountId: AccountIdResolver = async (_relayUrl, authToken) => authToken;

describe('start (packages/node CLI entrypoint, issue #63)', () => {
  let relay: StartedRelay;
  let stateDir: string;

  beforeEach(async () => {
    relay = await startRelay();
    stateDir = await mkdtemp(join(tmpdir(), 'loombox-node-main-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await relay.close();
  });

  it('loads config, connects to the relay, and shuts down cleanly on stop()', async () => {
    const amk = generateAmk();
    const started = await start({
      env: envFor(relay.url, stateDir, amk),
      argv: [],
      resolveAccountId: stubResolveAccountId,
    });

    expect(started.nodeId).toBe('main-test-node');
    expect(started.devicePublicKey.length).toBeGreaterThan(0);

    const connected = started.node.whenConnected();
    await connected;

    await expect(started.stop()).resolves.toBeUndefined();
  });

  it('stop() is idempotent: calling it more than once is a safe no-op', async () => {
    const amk = generateAmk();
    const started = await start({
      env: envFor(relay.url, stateDir, amk),
      argv: [],
      resolveAccountId: stubResolveAccountId,
    });
    await started.node.whenConnected();

    await started.stop();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it('rejects with the underlying ConfigError when required config is missing, before touching identity or the relay', async () => {
    await expect(start({ env: {}, argv: [] })).rejects.toThrow(ConfigError);
  });

  it('rejects when the AMK is malformed, same as loadNodeConfig', async () => {
    const env = envFor(relay.url, stateDir, generateAmk());
    env.LOOMBOX_AMK = 'not-valid-base64-length';
    await expect(start({ env, argv: [], resolveAccountId: stubResolveAccountId })).rejects.toThrow(
      ConfigError,
    );
  });

  it('reuses the persisted node identity across restarts sharing the same state dir', async () => {
    const amk = generateAmk();
    const env = envFor(relay.url, stateDir, amk);

    const first = await start({ env, argv: [], resolveAccountId: stubResolveAccountId });
    await first.node.whenConnected();
    const firstKey = first.devicePublicKey;
    await first.stop();

    const second = await start({ env, argv: [], resolveAccountId: stubResolveAccountId });
    await second.node.whenConnected();
    expect(second.devicePublicKey).toBe(firstKey);
    await second.stop();
  });

  it('generates a fresh identity per state dir (two different node instances never collide)', async () => {
    // Two real relay connections + two fresh identity generations; give it
    // headroom over the 5s default when the whole suite runs under CPU
    // contention (other test files' own relay/node pairs running in
    // parallel workers), same as this package's existing slower
    // integration tests (e.g. `node-daemon-ssh.test.ts`'s lease tests).
    const amk = generateAmk();
    const dirA = await mkdtemp(join(tmpdir(), 'loombox-node-main-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'loombox-node-main-b-'));
    try {
      const a = await start({
        env: envFor(relay.url, dirA, amk, 'node-a'),
        argv: [],
        resolveAccountId: stubResolveAccountId,
      });
      const b = await start({
        env: envFor(relay.url, dirB, amk, 'node-b'),
        argv: [],
        resolveAccountId: stubResolveAccountId,
      });
      await Promise.all([a.node.whenConnected(), b.node.whenConnected()]);

      expect(a.devicePublicKey).not.toBe(b.devicePublicKey);

      await a.stop();
      await b.stop();
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('start: accountId resolution (issue #380)', () => {
  let relay: StartedRelay;
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'loombox-node-main-acct-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await relay?.close();
  });

  it('calls the resolver with (relayUrl, authToken) and uses its result as accountId, not authToken itself', async () => {
    relay = await startRelay({
      // The relay's own resolution: deliberately NOT identity, so a node
      // that (pre-#380) defaulted accountId to authToken would disagree
      // with this and have every session it creates dropped.
      resolveAccountId: async (authToken) => `resolved-${authToken}`,
    });
    const amk = generateAmk();
    const env = envFor(relay.url, stateDir, amk);
    const resolveAccountId = vi
      .fn<AccountIdResolver>()
      .mockImplementation(async (_relayUrl, authToken) => `resolved-${authToken}`);

    const started = await start({ env, argv: [], resolveAccountId });

    expect(resolveAccountId).toHaveBeenCalledExactlyOnceWith(relay.url, env.LOOMBOX_AUTH_TOKEN);
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
  });

  it('skips the resolver entirely when LOOMBOX_ACCOUNT_ID is set explicitly', async () => {
    relay = await startRelay({ resolveAccountId: async () => 'explicit-account' });
    const amk = generateAmk();
    const env = { ...envFor(relay.url, stateDir, amk), LOOMBOX_ACCOUNT_ID: 'explicit-account' };
    const resolveAccountId = vi.fn<AccountIdResolver>();

    const started = await start({ env, argv: [], resolveAccountId });

    expect(resolveAccountId).not.toHaveBeenCalled();
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
  });

  it('rejects with a clear error rather than silently using authToken as accountId, when the default resolver cannot resolve a real session (e.g. this relay has no Better Auth mounted)', async () => {
    relay = await startRelay(); // stub mode: no `auth`, so /api/auth/* 404s
    const amk = generateAmk();
    const env = envFor(relay.url, stateDir, amk);

    // No `resolveAccountId` override: exercises the real default
    // (`resolveAccountIdViaRelay`) against a relay that can't answer it.
    await expect(start({ env, argv: [] })).rejects.toThrow(ConfigError);
  });
});

describe('installGracefulShutdown (issue #63)', () => {
  // `process` is one shared global EventEmitter for the whole test worker;
  // each `installGracefulShutdown` call below registers `process.once()`
  // listeners for whichever signals it wasn't sent (a real `process.once`
  // only self-removes once its own event actually fires), so without this
  // cleanup they'd leak across tests/files sharing this worker.
  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('calls stop() once when SIGTERM is received', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    installGracefulShutdown(stop, { forceExitAfterMs: 50 });

    process.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('calls stop() once when SIGINT is received', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    installGracefulShutdown(stop, { forceExitAfterMs: 50 });

    process.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('only reacts to the configured signals (SIGTERM does not fire when only SIGINT is wired)', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    installGracefulShutdown(stop, { signals: ['SIGINT'], forceExitAfterMs: 50 });

    process.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).not.toHaveBeenCalled();

    process.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
