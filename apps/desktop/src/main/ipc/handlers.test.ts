import { FakeTransport, SshTargetStore } from '@loombox/node';
import { describe, expect, it } from 'vitest';

import { BRIDGE_CHANNELS } from '../../shared/bridge';
import { LocalNodeBridge } from '../local-node/bridge';
import type { LoginItemApp } from '../login-item';
import type { AppVersionSource } from '../status';
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

describe('registerBridgeHandlers', () => {
  it('registers every BRIDGE_CHANNELS entry', () => {
    const ipcMain = new FakeIpcMain();
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
    });
    expect(new Set(ipcMain.registeredChannels)).toEqual(new Set(Object.values(BRIDGE_CHANNELS)));
  });

  it('listSshHostCandidates delegates to the TODO stub', async () => {
    const ipcMain = new FakeIpcMain();
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
    });
    await expect(ipcMain.invoke(BRIDGE_CHANNELS.listSshHostCandidates)).resolves.toEqual({
      candidates: [],
      requiresManualEntry: true,
    });
  });

  it('provisionTarget reports notConfigured by default (no deps resolved in this scaffold)', async () => {
    const ipcMain = new FakeIpcMain();
    registerBridgeHandlers(ipcMain, {
      localNode: new LocalNodeBridge(undefined, {}),
      app: fakeApp(),
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

  it('spawnLocalNode / stopLocalNode / status delegate to the LocalNodeBridge and status builder', async () => {
    const ipcMain = new FakeIpcMain();
    const app = fakeApp();
    registerBridgeHandlers(ipcMain, { localNode: new LocalNodeBridge(undefined, {}), app });

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
    });
  });
});
