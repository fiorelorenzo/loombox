import path from 'node:path';

import { app, ipcMain } from 'electron';

import { resolvePwaUrl } from './config';
import { registerBridgeHandlers } from './ipc/handlers';
import { LocalNodeBridge } from './local-node/bridge';
import { getLaunchAtLogin } from './login-item';
import { createMainWindow } from './window';
import { createTray } from './tray';
import { pickTrayIconPath } from './tray-icon';

/**
 * Electron main-process entry point (issue #403). Cannot run on this
 * headless devbox (no display, no real Electron runtime — see
 * `README.md`); this file only needs to typecheck here. Lorenzo runs it for
 * real on his Mac via `pnpm --filter @loombox/desktop dev`.
 */

const TRAY_ICON_TEMPLATE_PATH = path.join(__dirname, '../../assets/tray-iconTemplate.png');
const TRAY_ICON_COLORED_PATH = path.join(__dirname, '../../assets/tray-icon-azure.png');
const APP_ICON_PATH = path.join(__dirname, '../../assets/icon.png');

let isQuitting = false;
app.on('before-quit', () => {
  isQuitting = true;
});

void app.whenReady().then(() => {
  // loombox has a real cockpit window, so it lives in the Dock like a normal
  // app (the tray stays too). We deliberately do NOT `app.dock.hide()`: the
  // menubar-only convention hid the Dock icon entirely, but the app is used
  // as a full window, not a background utility. In dev (`electron .`) the Dock
  // would otherwise show the generic Electron icon, so set the loombox mark
  // explicitly (a packaged build also carries it via the bundle's .icns).
  app.dock?.setIcon(APP_ICON_PATH);

  const window = createMainWindow({
    url: resolvePwaUrl(),
    isQuitting: () => isQuitting,
  });

  // Clicking the Dock icon (or app re-activation) re-shows the window, since
  // closing it only hides it (see `./window.ts`). Standard macOS behavior.
  app.on('activate', () => {
    window.show();
    window.focus();
  });

  createTray({
    iconPath: pickTrayIconPath(process.platform, {
      template: TRAY_ICON_TEMPLATE_PATH,
      colored: TRAY_ICON_COLORED_PATH,
    }),
    window,
    onQuit: () => app.quit(),
  });

  // Launch-at-login is off by default (issue #403: "behind a setting") —
  // this only reads the current OS-level setting so a future renderer-side
  // preferences UI has something to reflect; toggling it is a
  // `setLaunchAtLogin` call away (`./login-item.ts`), not yet wired to any
  // UI in this scaffold.
  void getLaunchAtLogin(app);

  registerBridgeHandlers(ipcMain, {
    localNode: new LocalNodeBridge(),
    app,
  });
});

// Menubar apps conventionally stay alive with no windows open (quitting is
// via the tray's "Quit loombox" item, not the window's close button — see
// `./window.ts`'s `close` handler).
app.on('window-all-closed', () => {
  // Intentionally does nothing: overrides Electron's default
  // quit-on-all-windows-closed so the tray keeps the app running.
});
