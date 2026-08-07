import { describe, expect, it } from 'vitest';

import { LocalNodeBridge } from './local-node/bridge';
import { buildStatus, type AppVersionSource } from './status';
import type { LoginItemApp } from './login-item';
import type { UpdateController, UpdaterState } from './updater';

function fakeApp(openAtLogin: boolean, version: string): LoginItemApp & AppVersionSource {
  return {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: () => {},
    getVersion: () => version,
  };
}

function fakeUpdateController(state: UpdaterState): UpdateController {
  return {
    getState: () => state,
    checkForUpdates: async () => state,
    applyUpdate: async () => state,
  };
}

describe('buildStatus', () => {
  it('assembles app version, launch-at-login, local node status, and update state into one snapshot', () => {
    const app = fakeApp(true, '0.1.0');
    const localNode = new LocalNodeBridge(undefined, {});

    const status = buildStatus(app, localNode, fakeUpdateController({ status: 'idle' }));

    expect(status).toEqual({
      appVersion: '0.1.0',
      launchAtLogin: true,
      localNode: { status: 'stopped', pid: undefined },
      update: { status: 'idle' },
    });
  });

  it('reflects launchAtLogin: false', () => {
    const app = fakeApp(false, '0.1.0');
    const status = buildStatus(
      app,
      new LocalNodeBridge(undefined, {}),
      fakeUpdateController({ status: 'idle' }),
    );
    expect(status.launchAtLogin).toBe(false);
  });

  it("reflects the update controller's own current state, whatever it is", () => {
    const status = buildStatus(
      fakeApp(false, '0.1.0'),
      new LocalNodeBridge(undefined, {}),
      fakeUpdateController({ status: 'available', version: '0.9.0' }),
    );
    expect(status.update).toEqual({ status: 'available', version: '0.9.0' });
  });
});
