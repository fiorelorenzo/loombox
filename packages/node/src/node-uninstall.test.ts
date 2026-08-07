import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createInMemoryRelayStore,
  startRelay,
  type StartedRelay,
  type SyncRelayStore,
} from '@loombox/relay';

import { NodeIdentityStore } from './identity';
import {
  resolveNodeUninstallRelayOptions,
  revokeNodeDeviceOnRelay,
  uninstallNode,
  type NodeUninstallRelayOptions,
} from './node-uninstall';
import type { KeyringBackend } from './keyring';
import type {
  SupervisorBackend,
  SupervisorBackendActionResult,
  SupervisorBackendUninstallOptions,
} from './supervisor-backend';
import { DeviceTokenFileStore } from './device-token-store';

/** A syntactically valid (if meaningless) base64 `devicePublicKey` fixture — the relay's `initialize` schema rejects anything else with a hard socket close (4400) before ever replying, which this file's own tests must never trip over by accident. */
function randomBase64(byteLength = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLength))).toString('base64');
}

/** A minimal `SupervisorBackend` double — only `uninstall` is exercised here. */
function fakeBackend(
  uninstallImpl: (
    options?: SupervisorBackendUninstallOptions,
  ) => Promise<SupervisorBackendActionResult>,
): SupervisorBackend {
  return {
    install: () => {
      throw new Error('not used in this test');
    },
    start: () => {
      throw new Error('not used in this test');
    },
    stop: () => {
      throw new Error('not used in this test');
    },
    status: () => {
      throw new Error('not used in this test');
    },
    uninstall: uninstallImpl,
    survivesReboot: () => {
      throw new Error('not used in this test');
    },
  };
}

let relay: StartedRelay;
let store: SyncRelayStore;

beforeEach(async () => {
  store = createInMemoryRelayStore();
  relay = await startRelay({ host: '127.0.0.1', port: 0, store });
});

afterEach(async () => {
  await relay.close();
});

describe('revokeNodeDeviceOnRelay (issue #814, decision E1-3)', () => {
  it('revokes a never-rotated device (epoch 0 -> 1) and the relay genuinely marks it revoked', async () => {
    const options: NodeUninstallRelayOptions = {
      relayUrl: relay.url,
      deviceId: 'device-under-test',
      devicePublicKey: randomBase64(),
      authToken: 'acct-revoke-1',
    };

    const result = await revokeNodeDeviceOnRelay(options);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('epoch 1');
    expect(store.devices.get('device-under-test')?.status).toBe('revoked');
  });

  it('a revoked device can never reconnect (the relay closes it with "device revoked")', async () => {
    const options: NodeUninstallRelayOptions = {
      relayUrl: relay.url,
      deviceId: 'device-reconnect-test',
      devicePublicKey: randomBase64(),
      authToken: 'acct-revoke-2',
    };
    await revokeNodeDeviceOnRelay(options);
    expect(store.devices.get('device-reconnect-test')?.status).toBe('revoked');

    // A second attempt to revoke (i.e. reconnect as this device) never even
    // completes a handshake — the relay's own `initialize` handler rejects
    // any connection for an already-revoked deviceId.
    const secondAttempt = await revokeNodeDeviceOnRelay({ ...options, connectTimeoutMs: 2_000 });
    expect(secondAttempt.ok).toBe(false);
    expect(secondAttempt.message).toContain('could not reach');
  });

  it('catches up to a real prior epoch via amk_epoch_fetch_response before revoking (never guesses newEpoch: 1 blindly)', async () => {
    // Seed a pending epoch-3 envelope for this device, mirroring what a real
    // prior `device_revoke`'s wrap-fan-out leaves parked for a survivor
    // (`AmkRotationStore.putPending`) — proves this function's own epoch
    // arithmetic reads that value rather than assuming it is the first
    // revoke ever on the account.
    await store.amkRotation.advanceEpoch('acct-revoke-3', 1);
    await store.amkRotation.advanceEpoch('acct-revoke-3', 2);
    await store.amkRotation.advanceEpoch('acct-revoke-3', 3);
    await store.devices.upsert({
      deviceId: 'device-someone-else',
      devicePublicKey: randomBase64(),
      accountId: 'acct-revoke-3',
    });
    await store.amkRotation.putPending('acct-revoke-3', 'device-catchup-test', {
      epoch: 3,
      fromDeviceId: 'device-someone-else',
      envelope: {
        resourceId: 'amk-epoch',
        iv: randomBase64(12),
        ciphertext: randomBase64(48),
        alg: 'AES-256-GCM',
      },
    });

    const result = await revokeNodeDeviceOnRelay({
      relayUrl: relay.url,
      deviceId: 'device-catchup-test',
      devicePublicKey: randomBase64(),
      authToken: 'acct-revoke-3',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('epoch 4');
  });

  it('reports failure honestly (never silently succeeds) when the relay is unreachable', async () => {
    const result = await revokeNodeDeviceOnRelay({
      relayUrl: 'ws://127.0.0.1:1',
      deviceId: 'device-unreachable',
      devicePublicKey: randomBase64(),
      authToken: 'acct-unreachable',
      connectTimeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('could not reach');
  });
});

describe('uninstallNode (issue #814)', () => {
  it('always attempts the local teardown even when no relay is configured, and honestly reports the device as not revoked', async () => {
    const backend = fakeBackend(async (options) => {
      expect(options?.keepData).toBe(true);
      return { ok: true, message: 'backend uninstalled (keepData)' };
    });

    const result = await uninstallNode({ backend, keepData: true });

    expect(result.ok).toBe(true);
    expect(result.deviceRevoked).toBe(false);
    expect(result.revokeMessage).toContain('no relay connection configured');
    expect(result.keyringCleared).toBe(false);
  });

  it("keepData: false clears this identity's OS keyring entry; keepData: true leaves it alone", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'loombox-node-uninstall-test-'));
    try {
      const entries: Record<string, string> = {};
      const fakeKeyringBackend: KeyringBackend = {
        get: async (service, account) => entries[`${service}:${account}`],
        set: async (service, account, value) => {
          entries[`${service}:${account}`] = value;
        },
        delete: async (service, account) => {
          delete entries[`${service}:${account}`];
        },
      };
      const identityStore = new NodeIdentityStore({
        stateDir,
        osKeyringBackendFactory: async () => fakeKeyringBackend,
      });
      await identityStore.create();
      expect(Object.keys(entries)).toHaveLength(1);

      const backend = fakeBackend(async () => ({ ok: true, message: 'ok' }));

      // keepData: true — the entry survives.
      await uninstallNode({ backend, keepData: true, identityStore });
      expect(Object.keys(entries)).toHaveLength(1);

      // keepData: false (the default) — the entry is gone.
      const resultRemoveData = await uninstallNode({ backend, keepData: false, identityStore });
      expect(resultRemoveData.keyringCleared).toBe(true);
      expect(Object.keys(entries)).toHaveLength(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('keepData: true really leaves the on-disk state dir intact on a real filesystem, and a fresh NodeIdentityStore reload afterward adopts the exact same identity rather than generating a new one (acceptance: "declining data keeps the state dir, re-installing adopts the existing identity")', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'loombox-node-uninstall-keepdata-test-'));
    try {
      const original = await new NodeIdentityStore({
        stateDir,
        osKeyringBackendFactory: async () => undefined,
      }).create();

      const backend = fakeBackend(async (options) => {
        expect(options?.keepData).toBe(true);
        // A real backend never touches the state dir at all when keepData
        // is set (`../ssh/systemd-supervisor-backend.ts`/`../launchd/
        // launchd-supervisor-backend.ts`'s own `if (!keepData)` guard) —
        // this fake mirrors that by doing nothing to `stateDir` either.
        return { ok: true, message: 'unit uninstalled; state dir preserved (keepData)' };
      });

      const result = await uninstallNode({
        backend,
        keepData: true,
        identityStore: new NodeIdentityStore({
          stateDir,
          osKeyringBackendFactory: async () => undefined,
        }),
      });

      expect(result.ok).toBe(true);
      expect(result.keyringCleared).toBe(false);
      expect(existsSync(stateDir)).toBe(true);
      expect(existsSync(join(stateDir, 'identity.json'))).toBe(true);

      // A completely fresh store instance (as a real reinstall would build) —
      // proves the file, not process memory, is what makes this durable.
      const reloaded = await new NodeIdentityStore({
        stateDir,
        osKeyringBackendFactory: async () => undefined,
      }).loadOrCreate();
      expect(reloaded.publicKeyBase64).toBe(original.publicKeyBase64);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('revokes the real device on the relay AND runs the local teardown, reporting both outcomes', async () => {
    const backend = fakeBackend(async () => ({ ok: true, message: 'backend uninstalled' }));

    const result = await uninstallNode({
      backend,
      keepData: true,
      relay: {
        relayUrl: relay.url,
        deviceId: 'device-full-uninstall',
        devicePublicKey: randomBase64(),
        authToken: 'acct-full-uninstall',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.deviceRevoked).toBe(true);
    expect(store.devices.get('device-full-uninstall')?.status).toBe('revoked');
  });

  it('reports ok: false from the local teardown even when the device was successfully revoked (independent outcomes, never conflated)', async () => {
    const backend = fakeBackend(async () => ({ ok: false, message: 'systemctl disable failed' }));

    const result = await uninstallNode({
      backend,
      keepData: true,
      relay: {
        relayUrl: relay.url,
        deviceId: 'device-partial-failure',
        devicePublicKey: randomBase64(),
        authToken: 'acct-partial-failure',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.deviceRevoked).toBe(true);
  });
});

describe('resolveNodeUninstallRelayOptions (issue #814)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'loombox-node-uninstall-resolve-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('returns undefined when this node was never fully provisioned (no identity, no token)', async () => {
    const resolved = await resolveNodeUninstallRelayOptions({
      relayUrl: relay.url,
      deviceId: 'never-provisioned',
      stateDir,
    });
    expect(resolved).toBeUndefined();
  });

  it('reads the real on-disk identity + device token and resolves them, then a real revoke round-trips end to end', async () => {
    const identity = await new NodeIdentityStore({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
    }).loadOrCreate();
    new DeviceTokenFileStore({ stateDir }).save('acct-resolve-e2e');

    const resolved = await resolveNodeUninstallRelayOptions({
      relayUrl: relay.url,
      deviceId: 'device-resolve-e2e',
      stateDir,
    });

    expect(resolved).toEqual({
      relayUrl: relay.url,
      deviceId: 'device-resolve-e2e',
      devicePublicKey: identity.publicKeyBase64,
      authToken: 'acct-resolve-e2e',
      webSocketImpl: undefined,
    });

    const revoked = await revokeNodeDeviceOnRelay(resolved!);
    expect(revoked.ok).toBe(true);
    expect(store.devices.get('device-resolve-e2e')?.status).toBe('revoked');
  });
});
