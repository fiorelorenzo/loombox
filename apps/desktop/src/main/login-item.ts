/**
 * Launch-at-login wiring (issue #403), behind a setting rather than always
 * on. Takes the exact slice of Electron's `app` it needs as a parameter
 * (`LoginItemApp`) instead of importing `electron` directly, so this module
 * is testable with a plain fake on this headless devbox (no real Electron
 * runtime) — the production caller (`./index.ts`) passes the real `app`.
 */

/** The `app.{get,set}LoginItemSettings` slice this module needs — structurally satisfied by Electron's real `app` (see `electron.d.ts`'s `App` interface) and by the fake in `login-item.test.ts`. */
export interface LoginItemApp {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

/** Whether the app is currently set to launch at login. */
export function getLaunchAtLogin(app: LoginItemApp): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

/** Enables/disables launch-at-login. Idempotent (`setLoginItemSettings` is itself idempotent — reading it back is left to `getLaunchAtLogin`, not duplicated here). */
export function setLaunchAtLogin(app: LoginItemApp, enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}
