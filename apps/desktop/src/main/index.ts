import path from 'node:path';

import { app, ipcMain } from 'electron';

import { resolvePwaUrl } from './config';
import { registerBridgeHandlers } from './ipc/handlers';
import { LocalNodeBridge } from './local-node/bridge';
import { getLaunchAtLogin } from './login-item';
import { createMainWindow } from './window';
import { createTray } from './tray';

/**
 * Electron main-process entry point (issue #403). Cannot run on this
 * headless devbox (no display, no real Electron runtime — see
 * `README.md`); this file only needs to typecheck here. Lorenzo runs it for
 * real on his Mac via `pnpm --filter @loombox/desktop dev`.
 */

const TRAY_ICON_PATH = path.join(__dirname, '../../assets/tray-iconTemplate.png');

let isQuitting = false;
app.on('before-quit', () => {
  isQuitting = true;
});

// Menubar-only app: no Dock icon, no window shown until the tray/dock
// re-activates it (macOS convention for a background utility app).
app.dock?.hide();

void app.whenReady().then(() => {
  const window = createMainWindow({
    url: resolvePwaUrl(),
    isQuitting: () => isQuitting,
  });

  createTray({
    iconPath: TRAY_ICON_PATH,
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
