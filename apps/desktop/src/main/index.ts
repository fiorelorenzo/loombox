import path from 'node:path';

import { app, ipcMain } from 'electron';

import { resolvePwaUrl } from './config';
import { resolveDesktopEnvironmentConfig } from './environment';
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

// Everything issue #866 needs resolved before a second production install
// could ever collide with this one: which environment this build/run is
// (`LOOMBOX_DESKTOP_ENV`, defaulting to production), and every value that
// has to differ because of it. `app.setName`/`app.setPath('userData', …)`
// below both have to run before `app.whenReady()` — Electron derives
// several paths, including session storage, from them as soon as the app
// starts initializing, not only once 'ready' fires.
const desktopEnv = resolveDesktopEnvironmentConfig();

// The dock/menu-bar identity (issue #866). Also the identity Electron would
// otherwise derive `userData` from — set explicitly below anyway, so this
// call is about the dock/menu bar, not a dependency the next line relies on.
app.setName(desktopEnv.productName);

// The one that actually bites: a userData directory shared between a
// production and a preview install is a shared `localStorage`, so a shared
// bearer token, a shared AMK and a shared session list (issue #866). Joined
// onto `appData` (the per-user app-data root, shared and unaffected by
// `setName` above) rather than left to Electron's own productName-derived
// default, which only actually differs once a package carries a distinct
// `productName` — dev (`electron .`) reads `package.json` directly, which
// has no per-environment `productName` field at all.
app.setPath('userData', path.join(app.getPath('appData'), desktopEnv.userDataDirName));

// Two installs claiming the same deep-link scheme is undefined behaviour —
// the OS picks one, silently (issue #866). electron-builder's `protocols`
// config (`../../electron-builder.ts`) is what actually registers this with
// the OS in a packaged build (Info.plist on macOS, the registry on
// Windows); this call is the dev-mode/Linux-desktop-file-refresh path and
// is otherwise a harmless idempotent re-registration.
app.setAsDefaultProtocolClient(desktopEnv.protocolScheme);

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
    title: desktopEnv.productName,
    chromeBadge: desktopEnv.chromeBadge,
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
    productName: desktopEnv.productName,
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
// via the tray's "Quit" item — `./tray.ts`'s `Quit ${productName}` — not the
// window's close button — see `./window.ts`'s `close` handler).
app.on('window-all-closed', () => {
  // Intentionally does nothing: overrides Electron's default
  // quit-on-all-windows-closed so the tray keeps the app running.
});
