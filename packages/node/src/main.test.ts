import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generateAmk,
  generateRecoveryCode,
  packWrappedAmkForWire,
  wrapAmkWithRecoveryCode,
} from '@loombox/crypto';
import { PROTOCOL_V1, type AmkEscrow, type Initialize } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import type { AmkBootstrapper } from './amk-bootstrap';
import { ConfigError } from './config';
import { DeviceTokenFileStore } from './device-token-store';
import { installGracefulShutdown, start, type DeviceLoginRunner } from './main';
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

/**
 * Escrows `wrappedAmk` for `accountId` on `relay`, exactly the way a real
 * client would (SPEC §8 path 2's `amk_escrow` message) — a raw WebSocket
 * round-trip, mirroring `amk-bootstrap.test.ts`'s own helper, so `start()`'s
 * recovery-code path (issue #386) has something real to bootstrap against.
 */
async function escrowAmk(
  relay: StartedRelay,
  accountId: string,
  amk: Uint8Array,
  recoveryCode: string,
): Promise<void> {
  const blob = await wrapAmkWithRecoveryCode(amk, recoveryCode, accountId);
  const wrappedAmk = packWrappedAmkForWire(blob);

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(relay.url);
    socket.addEventListener('open', () => {
      const initialize: Initialize = {
        type: 'initialize',
        protocolVersion: PROTOCOL_V1,
        role: 'node',
        authToken: accountId,
        deviceId: `${accountId}-escrow-source`,
        devicePublicKey: 'ZXNjcm93LXNvdXJjZQ==',
      };
      socket.send(JSON.stringify(initialize));
    });
    let sentEscrow = false;
    socket.addEventListener('message', () => {
      if (sentEscrow) return;
      sentEscrow = true;
      const escrow: AmkEscrow = { type: 'amk_escrow', protocolVersion: PROTOCOL_V1, wrappedAmk };
      socket.send(JSON.stringify(escrow));
      setTimeout(() => {
        socket.close();
        resolve();
      }, 50);
    });
    socket.addEventListener('error', () => reject(new Error('escrowAmk: relay unreachable')));
  });
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

describe('start: AMK from a Recovery Code (issue #386)', () => {
  let relay: StartedRelay;
  let stateDir: string;

  beforeEach(async () => {
    relay = await startRelay();
    stateDir = await mkdtemp(join(tmpdir(), 'loombox-node-main-amk-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await relay.close();
  });

  function recoveryEnvFor(relayUrl: string, dir: string, accountId: string, recoveryCode: string) {
    return {
      LOOMBOX_RELAY_URL: relayUrl,
      LOOMBOX_NODE_ID: 'recovery-node',
      LOOMBOX_AUTH_TOKEN: accountId,
      LOOMBOX_ACCOUNT_ID: accountId,
      LOOMBOX_RECOVERY_CODE: recoveryCode,
      LOOMBOX_NODE_STATE_DIR: dir,
    };
  }

  it('connects using the AMK recovered from a Recovery Code, with no LOOMBOX_AMK set at all', async () => {
    const amk = generateAmk();
    const recoveryCode = generateRecoveryCode();
    const accountId = 'acct-recovery-main';
    await escrowAmk(relay, accountId, amk, recoveryCode);

    const started = await start({
      env: recoveryEnvFor(relay.url, stateDir, accountId, recoveryCode),
      argv: [],
    });

    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
  });

  it("calls bootstrapAmk with this node's own resolved accountId/device identity and recoveryCode, and connects with what it returns", async () => {
    const amk = generateAmk();
    const bootstrapAmk = vi.fn<AmkBootstrapper>().mockResolvedValue(amk);

    const started = await start({
      env: recoveryEnvFor(relay.url, stateDir, 'acct-spy', 'SOME-RECOVERY-CODE'),
      argv: [],
      bootstrapAmk,
    });

    expect(bootstrapAmk).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        relayUrl: relay.url,
        accountId: 'acct-spy',
        authToken: 'acct-spy',
        deviceId: 'recovery-node',
        recoveryCode: 'SOME-RECOVERY-CODE',
      }),
    );
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
  });

  it('rejects with a clear error, and never connects, when the recovery code is wrong', async () => {
    const amk = generateAmk();
    const recoveryCode = generateRecoveryCode();
    const accountId = 'acct-recovery-wrong-code';
    await escrowAmk(relay, accountId, amk, recoveryCode);

    const env = recoveryEnvFor(relay.url, stateDir, accountId, generateRecoveryCode());
    await expect(start({ env, argv: [] })).rejects.toThrow(ConfigError);
  });

  it('an explicit LOOMBOX_AMK still works as a raw override, bypassing the recovery-code bootstrap entirely', async () => {
    const amk = generateAmk();
    const bootstrapAmk = vi.fn<AmkBootstrapper>();

    const started = await start({
      env: envFor(relay.url, stateDir, amk),
      argv: [],
      resolveAccountId: stubResolveAccountId,
      bootstrapAmk,
    });

    expect(bootstrapAmk).not.toHaveBeenCalled();
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
  });
});

describe('start: bearer token resolution (issue #387)', () => {
  let relay: StartedRelay;
  let stateDir: string;

  beforeEach(async () => {
    relay = await startRelay();
    stateDir = await mkdtemp(join(tmpdir(), 'loombox-node-main-devicetoken-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await relay.close();
  });

  /** `envFor` minus `LOOMBOX_AUTH_TOKEN` — every test below supplies its own bearer via a different path. */
  function envWithoutAuthToken(nodeId = 'main-test-node') {
    const env = envFor(relay.url, stateDir, generateAmk(), nodeId) as Record<
      string,
      string | undefined
    >;
    delete env.LOOMBOX_AUTH_TOKEN;
    return env;
  }

  it('uses LOOMBOX_DEVICE_TOKEN directly, without running the device-login flow', async () => {
    const deviceLogin = vi.fn();
    const started = await start({
      env: { ...envWithoutAuthToken(), LOOMBOX_DEVICE_TOKEN: 'a-direct-device-token' },
      argv: [],
      resolveAccountId: stubResolveAccountId,
      runDeviceLogin: deviceLogin,
    });

    expect(deviceLogin).not.toHaveBeenCalled();
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
  });

  it('reuses a device token already persisted under this node’s state dir, skipping login', async () => {
    new DeviceTokenFileStore({ stateDir }).save('a-persisted-device-token');
    const deviceLogin = vi.fn();

    const started = await start({
      env: envWithoutAuthToken(),
      argv: [],
      resolveAccountId: stubResolveAccountId,
      runDeviceLogin: deviceLogin,
    });

    expect(deviceLogin).not.toHaveBeenCalled();
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
  });

  it('runs the device-login flow when neither LOOMBOX_AUTH_TOKEN, LOOMBOX_DEVICE_TOKEN, nor a persisted token exist, then persists the result', async () => {
    const deviceLogin = vi.fn<DeviceLoginRunner>().mockResolvedValue({
      accessToken: 'freshly-logged-in-token',
    });

    const started = await start({
      env: envWithoutAuthToken(),
      argv: [],
      resolveAccountId: stubResolveAccountId,
      runDeviceLogin: deviceLogin,
    });

    expect(deviceLogin).toHaveBeenCalledExactlyOnceWith({ relayUrl: relay.url });
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();

    expect(new DeviceTokenFileStore({ stateDir }).load()).toBe('freshly-logged-in-token');
  });

  it('an explicit LOOMBOX_AUTH_TOKEN wins over LOOMBOX_DEVICE_TOKEN, and never runs the device-login flow', async () => {
    const deviceLogin = vi.fn();
    const started = await start({
      env: { ...envFor(relay.url, stateDir, generateAmk()), LOOMBOX_DEVICE_TOKEN: 'ignored' },
      argv: [],
      resolveAccountId: stubResolveAccountId,
      runDeviceLogin: deviceLogin,
    });

    expect(deviceLogin).not.toHaveBeenCalled();
    await expect(started.node.whenConnected()).resolves.toBeUndefined();
    await started.stop();
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
