import { FakeTransport, SshTargetStore } from '@loombox/node';
import { describe, expect, it } from 'vitest';

import { BRIDGE_CHANNELS } from '../../shared/bridge';
import { LocalNodeBridge } from '../local-node/bridge';
import type { LoginItemApp } from '../login-item';
import type { AppVersionSource } from '../status';
import type { UpdateController, UpdaterState } from '../updater';
import { registerBridgeHandlers, type IpcMainLike } from './handlers';

/** Records every `ipcMain.handle(channel, listener)` call so a test can invoke a channel's listener directly, without any real Electron `ipcMain`. */
class FakeIpcMain implements IpcMainLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors IpcMainLike's own Electron-matching signature (see handlers.ts).
  private readonly listeners = new Map<string, (event: any, ...args: any[]) => any>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, listener: (event: any, ...args: any[]) => any): void {
    this.listeners.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const listener = this.listeners.get(channel);
    if (!listener) throw new Error(`no handler registered for channel "${channel}"`);
    return listener({}, ...args);
  }

  get registeredChannels(): string[] {
    return [...this.listeners.keys()];
  }
}

function fakeApp(): LoginItemApp & AppVersionSource {
  let openAtLogin = false;
  return {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: (settings) => {
      openAtLogin = settings.openAtLogin;
    },
    getVersion: () => '0.1.0',
  };
}

/** A trivial `UpdateController` fake — `checkForUpdates`/`applyUpdate` just report whatever `state` was constructed with, never touching a real feed. */
function fakeUpdateController(state: UpdaterState = { status: 'idle' }): UpdateController {
  return {
    getState: () => state,
    checkForUpdates: async () => state,
    applyUpdate: async () => state,
  };
}

describe('registerBridgeHandlers', () => {
  it('registers every BRIDGE_CHANNELS entry', () => {
    const ipcMain = new FakeIpcMain();
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
      updateController: fakeUpdateController(),
    });
    expect(new Set(ipcMain.registeredChannels)).toEqual(new Set(Object.values(BRIDGE_CHANNELS)));
  });

  it('listSshHostCandidates delegates to the injected discovery', async () => {
    const ipcMain = new FakeIpcMain();
    const discovered = {
      candidates: [
        {
          alias: 'build-server',
          hostName: '10.0.0.5',
          user: 'lorenzo',
          identityFiles: ['/home/lorenzo/.ssh/id_ed25519'],
        },
      ],
      requiresManualEntry: false,
    };
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
      updateController: fakeUpdateController(),
      listSshHostCandidates: () => Promise.resolve(discovered),
    });
    await expect(ipcMain.invoke(BRIDGE_CHANNELS.listSshHostCandidates)).resolves.toEqual(
      discovered,
    );
  });

  it('provisionTarget reports notConfigured by default (no deps resolved in this scaffold)', async () => {
    const ipcMain = new FakeIpcMain();
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
      updateController: fakeUpdateController(),
    });
    const result = await ipcMain.invoke(BRIDGE_CHANNELS.provisionTarget, {
      target: { id: 't1', label: 'Test', host: '127.0.0.1' },
    });
    expect(result).toMatchObject({ ok: false, targetId: 't1', notConfigured: true });
  });

  it('provisionTarget genuinely runs @loombox/node provision() when deps are injected', async () => {
    const ipcMain = new FakeIpcMain();
    const connectError = new Error('connect ECONNREFUSED') as Error & { code: string };
    connectError.code = 'ECONNREFUSED';

    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
      updateController: fakeUpdateController(),
      provisionTargetDeps: {
        transportFactory: () => new FakeTransport({ connectError }),
        store: new SshTargetStore({ stateDir: '/tmp/loombox-desktop-handlers-test-unused' }),
        runtime: { skip: true },
        supervisor: {
          artifactSource: {
            fetch: async () => {
              throw new Error('never reached');
            },
          },
          targetVersion: '0.0.0-test',
          publicKey: new Uint8Array(32),
        },
        residentNode: { skip: true, config: { relayUrl: 'wss://relay.loombox.dev', nodeId: 't1' } },
      },
    });

    const result = await ipcMain.invoke(BRIDGE_CHANNELS.provisionTarget, {
      target: { id: 't1', label: 'Test', host: '127.0.0.1' },
    });
    expect(result).toMatchObject({ ok: false, targetId: 't1', failedStep: 'verify_and_persist' });
  });

  it('provisionLocalNode delegates to the injected deps and genuinely runs @loombox/node provisionLocalNode()', async () => {
    const ipcMain = new FakeIpcMain();
    const connectError = new Error('spawn ENOENT');

    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
      updateController: fakeUpdateController(),
      provisionLocalNodeDeps: {
        version: '1.0.0',
        fetchArchive: async () => {
          throw new Error('fetchArchive should never be called: the transport never connects');
        },
        backend: {
          install: async () => {
            throw new Error('backend.install should never be called');
          },
          start: async () => ({ ok: false, message: 'unused' }),
          stop: async () => ({ ok: false, message: 'unused' }),
          status: async () => ({ installed: false, state: 'stopped', message: 'unused' }),
          uninstall: async () => ({ ok: false, message: 'unused' }),
          survivesReboot: async () => false,
        },
        transport: new FakeTransport({ connectError }),
        stateDir: '/tmp/loombox-desktop-handlers-test-unused-local-node',
      },
    });

    const result = await ipcMain.invoke(BRIDGE_CHANNELS.provisionLocalNode, {
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-1',
      actingAuthToken: 'session-token',
      amkBase64: Buffer.alloc(32).toString('base64'),
      nodeId: 'mac-local-1',
    });
    expect(result).toMatchObject({ ok: false, failedStep: 'runtime_bootstrap' });
  });

  it('spawnLocalNode / stopLocalNode / status delegate to the LocalNodeBridge and status builder', async () => {
    const ipcMain = new FakeIpcMain();
    const app = fakeApp();
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app,
      updateController: fakeUpdateController({ status: 'available', version: '0.9.0' }),
    });

    await expect(ipcMain.invoke(BRIDGE_CHANNELS.spawnLocalNode)).resolves.toMatchObject({
      notConfigured: true,
    });
    await expect(ipcMain.invoke(BRIDGE_CHANNELS.stopLocalNode)).resolves.toMatchObject({
      status: 'stopped',
    });
    await expect(ipcMain.invoke(BRIDGE_CHANNELS.status)).resolves.toEqual({
      appVersion: '0.1.0',
      launchAtLogin: false,
      localNode: { status: 'stopped', pid: undefined },
      update: { status: 'available', version: '0.9.0' },
    });
  });

  it('checkForUpdate / applyUpdate delegate to the injected UpdateController', async () => {
    const ipcMain = new FakeIpcMain();
    const updateController = fakeUpdateController({ status: 'available', version: '1.0.0' });
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
      updateController,
    });

    await expect(ipcMain.invoke(BRIDGE_CHANNELS.checkForUpdate)).resolves.toEqual({
      status: 'available',
      version: '1.0.0',
    });
    await expect(ipcMain.invoke(BRIDGE_CHANNELS.applyUpdate)).resolves.toEqual({
      status: 'available',
      version: '1.0.0',
    });
  });
});
