/**
 * Self-update wiring for the desktop shell (issue #657; epic #653), via
 * electron-updater against the GitHub Releases feed `../../electron-builder
 * .ts`'s `publish` config points at, fed by the signed artifacts
 * `scripts/release-desktop.sh` (macOS, run by hand) and
 * `.github/workflows/release-desktop.yml` (Windows/Linux, on tag push)
 * upload — see that script and workflow for what's actually verified.
 *
 * Takes electron-updater's `autoUpdater` singleton as an injectable
 * {@link AutoUpdaterLike} — the same "narrowest slice of Electron (or an
 * Electron-adjacent package) a module actually needs" convention
 * `./login-item.ts` already uses — so this module is unit-testable with a
 * plain fake on this headless devbox, unlike `./index.ts`/`./tray.ts`,
 * which import `electron-updater` directly and only typecheck here (see
 * README.md's "Every file under main/ other than index.ts, window.ts, and
 * tray.ts...").
 *
 * The epic's own "Out of scope" section is load-bearing: auto-updating
 * WITHOUT consent is explicitly excluded. `autoDownload = false` is set
 * unconditionally at construction, so electron-updater itself never
 * downloads or installs anything on its own — {@link UpdateController.checkForUpdates}
 * only ever learns whether a newer build exists;
 * {@link UpdateController.applyUpdate} is the one explicit, user-initiated
 * action that downloads AND installs (#653: "the action [is] one click").
 */

export type UpdaterStatus =
  'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

/** A point-in-time snapshot of the update check/apply cycle — `./status.ts`'s `buildStatus` folds this into `BridgeStatus.update`, and `./tray.ts` reads it to decide what the tray menu offers. */
export interface UpdaterState {
  status: UpdaterStatus;
  /** The available/downloading/downloaded build's version, once known — absent for 'idle'/'checking'/'not-available'. */
  version?: string;
  /** Set only when `status` is `'error'` — electron-updater's own message, never a raw stack (this module never has one to begin with; see the `'error'` listener below). */
  error?: string;
}

/** The electron-updater `autoUpdater` singleton's own slice this module needs — structurally satisfied by the real `autoUpdater` import (`electron-updater`'s `AppUpdater`, an `EventEmitter`) and by a plain fake in `updater.test.ts`. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateController {
  /** The last known state — never triggers a check itself. */
  getState(): UpdaterState;
  /** Asks electron-updater to check the feed. Never downloads (`autoDownload` stays `false` for this controller's whole life) — resolves once the check itself settles (available/not-available/error), which is not the same as a download finishing. Safe to call repeatedly (e.g. `./index.ts`'s own periodic timer); each call simply re-checks and updates the snapshot. */
  checkForUpdates(): Promise<UpdaterState>;
  /**
   * The one explicit, user-consented action (#653: "the action [is] one
   * click"): downloads the update `checkForUpdates` already found, then
   * restarts into it. A no-op (returns the current state unchanged) unless
   * an update is actually available or already downloaded — there is
   * nothing to apply before a check has found something, and calling
   * `quitAndInstall` with nothing staged would just relaunch the CURRENT
   * version.
   */
  applyUpdate(): Promise<UpdaterState>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wires listeners onto `autoUpdater` and returns the small controller `./index.ts`/`./tray.ts` drive. Never throws — every electron-updater failure mode (a rejected `checkForUpdates()`/`downloadUpdate()`, or an `'error'` event with no corresponding rejection) collapses into `{ status: 'error' }` instead of an unhandled rejection or a crashed main process. */
export function createUpdateController(autoUpdater: AutoUpdaterLike): UpdateController {
  autoUpdater.autoDownload = false;
  // Not load-bearing for this controller — `applyUpdate` always calls
  // `quitAndInstall` directly rather than deferring to app-quit — set
  // explicitly so a future reader doesn't have to go check
  // electron-updater's own default.
  autoUpdater.autoInstallOnAppQuit = false;

  let state: UpdaterState = { status: 'idle' };

  autoUpdater.on('checking-for-update', () => {
    state = { status: 'checking' };
  });
  autoUpdater.on('update-available', (info?: { version?: string }) => {
    state = { status: 'available', version: info?.version };
  });
  autoUpdater.on('update-not-available', () => {
    state = { status: 'not-available' };
  });
  autoUpdater.on('error', (error: unknown) => {
    state = { status: 'error', error: messageOf(error) };
  });
  autoUpdater.on('download-progress', () => {
    // Keeps whatever version `update-available` already recorded — a
    // progress tick carries transfer stats this snapshot doesn't surface,
    // not a version.
    state = { ...state, status: 'downloading' };
  });
  autoUpdater.on('update-downloaded', (info?: { version?: string }) => {
    state = { status: 'downloaded', version: info?.version ?? state.version };
  });

  return {
    getState: () => state,
    checkForUpdates: async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        // electron-updater's own 'error' listener above usually fires for
        // this too, but `checkForUpdates()` can also reject directly (e.g.
        // no network) without emitting 'error' first — cover both paths so
        // a caller awaiting this promise never sees an unhandled rejection.
        state = { status: 'error', error: messageOf(error) };
      }
      return state;
    },
    applyUpdate: async () => {
      if (state.status === 'downloaded') {
        autoUpdater.quitAndInstall();
        return state;
      }
      if (state.status !== 'available') return state;
      try {
        await autoUpdater.downloadUpdate();
        // `downloadUpdate()` resolving doesn't strictly guarantee the
        // 'update-downloaded' listener above already ran first — nothing in
        // electron-updater's public contract promises that ordering — so
        // this calls `quitAndInstall` unconditionally here rather than
        // re-checking `state.status`.
        autoUpdater.quitAndInstall();
      } catch (error) {
        state = { status: 'error', error: messageOf(error) };
      }
      return state;
    },
  };
}
