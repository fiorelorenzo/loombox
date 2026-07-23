import { describe, expect, it } from 'vitest';

import { LocalNodeBridge } from './local-node/bridge';
import { buildStatus, type AppVersionSource } from './status';
import type { LoginItemApp } from './login-item';

function fakeApp(openAtLogin: boolean, version: string): LoginItemApp & AppVersionSource {
  return {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: () => {},
    getVersion: () => version,
  };
}

describe('buildStatus', () => {
  it('assembles app version, launch-at-login, and local node status into one snapshot', () => {
    const app = fakeApp(true, '0.1.0');
    const localNode = new LocalNodeBridge(undefined, {});

    const status = buildStatus(app, localNode);

    expect(status).toEqual({
      appVersion: '0.1.0',
      launchAtLogin: true,
      localNode: { status: 'stopped', pid: undefined },
    });
  });

  it('reflects launchAtLogin: false', () => {
    const app = fakeApp(false, '0.1.0');
    const status = buildStatus(app, new LocalNodeBridge(undefined, {}));
    expect(status.launchAtLogin).toBe(false);
  });
});
