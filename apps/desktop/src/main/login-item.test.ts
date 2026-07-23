import { describe, expect, it } from 'vitest';

import { getLaunchAtLogin, setLaunchAtLogin, type LoginItemApp } from './login-item';

function fakeApp(initialOpenAtLogin = false): LoginItemApp {
  let openAtLogin = initialOpenAtLogin;
  return {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: (settings) => {
      openAtLogin = settings.openAtLogin;
    },
  };
}

describe('getLaunchAtLogin', () => {
  it('reflects the app-reported openAtLogin setting', () => {
    expect(getLaunchAtLogin(fakeApp(false))).toBe(false);
    expect(getLaunchAtLogin(fakeApp(true))).toBe(true);
  });
});

describe('setLaunchAtLogin', () => {
  it('enables launch-at-login', () => {
    const app = fakeApp(false);
    setLaunchAtLogin(app, true);
    expect(getLaunchAtLogin(app)).toBe(true);
  });

  it('disables launch-at-login', () => {
    const app = fakeApp(true);
    setLaunchAtLogin(app, false);
    expect(getLaunchAtLogin(app)).toBe(false);
  });
});
