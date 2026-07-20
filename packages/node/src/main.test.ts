import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateAmk } from '@loombox/crypto';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { ConfigError } from './config';
import { installGracefulShutdown, start } from './main';

function envFor(relayUrl: string, stateDir: string, amk: Uint8Array, nodeId = 'main-test-node') {
  return {
    LOOMBOX_RELAY_URL: relayUrl,
    LOOMBOX_NODE_ID: nodeId,
    LOOMBOX_AUTH_TOKEN: `acct-${nodeId}`,
    LOOMBOX_AMK: Buffer.from(amk).toString('base64'),
    LOOMBOX_NODE_STATE_DIR: stateDir,
  };
}

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
    const started = await start({ env: envFor(relay.url, stateDir, amk), argv: [] });

    expect(started.nodeId).toBe('main-test-node');
    expect(started.devicePublicKey.length).toBeGreaterThan(0);

    const connected = new Promise<void>((resolve) => started.node.once('connected', resolve));
    await connected;

    await expect(started.stop()).resolves.toBeUndefined();
  });

  it('stop() is idempotent: calling it more than once is a safe no-op', async () => {
    const amk = generateAmk();
    const started = await start({ env: envFor(relay.url, stateDir, amk), argv: [] });
    await new Promise<void>((resolve) => started.node.once('connected', resolve));

    await started.stop();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it('rejects with the underlying ConfigError when required config is missing, before touching identity or the relay', async () => {
    await expect(start({ env: {}, argv: [] })).rejects.toThrow(ConfigError);
  });

  it('rejects when the AMK is malformed, same as loadNodeConfig', async () => {
    const env = envFor(relay.url, stateDir, generateAmk());
    env.LOOMBOX_AMK = 'not-valid-base64-length';
    await expect(start({ env, argv: [] })).rejects.toThrow(ConfigError);
  });

  it('reuses the persisted node identity across restarts sharing the same state dir', async () => {
    const amk = generateAmk();
    const env = envFor(relay.url, stateDir, amk);

    const first = await start({ env, argv: [] });
    await new Promise<void>((resolve) => first.node.once('connected', resolve));
    const firstKey = first.devicePublicKey;
    await first.stop();

    const second = await start({ env, argv: [] });
    await new Promise<void>((resolve) => second.node.once('connected', resolve));
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
      const a = await start({ env: envFor(relay.url, dirA, amk, 'node-a'), argv: [] });
      const b = await start({ env: envFor(relay.url, dirB, amk, 'node-b'), argv: [] });
      await Promise.all([
        new Promise<void>((resolve) => a.node.once('connected', resolve)),
        new Promise<void>((resolve) => b.node.once('connected', resolve)),
      ]);

      expect(a.devicePublicKey).not.toBe(b.devicePublicKey);

      await a.stop();
      await b.stop();
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  }, 10_000);
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
