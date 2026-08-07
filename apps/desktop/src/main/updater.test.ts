import { describe, expect, it, vi } from 'vitest';

import { createUpdateController, type AutoUpdaterLike } from './updater';

/** A minimal, real (not mocked) event emitter satisfying `AutoUpdaterLike` — tests fire events by calling the captured listeners directly, exactly like electron-updater would. */
function fakeAutoUpdater(
  overrides: Partial<Pick<AutoUpdaterLike, 'checkForUpdates' | 'downloadUpdate'>> = {},
): AutoUpdaterLike & { emit: (event: string, ...args: unknown[]) => void } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event, listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener as (...args: unknown[]) => void);
      listeners.set(event, existing);
      return this;
    },
    checkForUpdates: overrides.checkForUpdates ?? vi.fn().mockResolvedValue(undefined),
    downloadUpdate: overrides.downloadUpdate ?? vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

describe('createUpdateController', () => {
  it('forces autoDownload and autoInstallOnAppQuit off — never updates without the explicit applyUpdate action (epic #653: no auto-update without consent)', () => {
    const autoUpdater = fakeAutoUpdater();
    createUpdateController(autoUpdater);
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('starts idle', () => {
    const controller = createUpdateController(fakeAutoUpdater());
    expect(controller.getState()).toEqual({ status: 'idle' });
  });

  it('reflects checking-for-update while a check is in flight', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);
    autoUpdater.emit('checking-for-update');
    expect(controller.getState()).toEqual({ status: 'checking' });
  });

  it('reflects update-available with the discovered version', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);
    autoUpdater.emit('update-available', { version: '0.9.0' });
    expect(controller.getState()).toEqual({ status: 'available', version: '0.9.0' });
  });

  it('reflects update-not-available', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);
    autoUpdater.emit('update-available', { version: '0.9.0' });
    autoUpdater.emit('update-not-available');
    expect(controller.getState()).toEqual({ status: 'not-available' });
  });

  it("reflects an 'error' event without a message-bearing Error object as a plain string", async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);
    autoUpdater.emit('error', new Error('feed unreachable'));
    expect(controller.getState()).toEqual({ status: 'error', error: 'feed unreachable' });
  });

  it('checkForUpdates calls through to autoUpdater.checkForUpdates and returns the settled state', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);
    // Simulates electron-updater's own event ordering: checkForUpdates()
    // resolves once it has already emitted update-available/not-available.
    (autoUpdater.checkForUpdates as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      autoUpdater.emit('update-available', { version: '1.2.0' });
    });

    const state = await controller.checkForUpdates();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ status: 'available', version: '1.2.0' });
  });

  it('checkForUpdates resolves to an error state when the call rejects directly, without throwing', async () => {
    const autoUpdater = fakeAutoUpdater({
      checkForUpdates: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
    });
    const controller = createUpdateController(autoUpdater);

    const state = await controller.checkForUpdates();

    expect(state).toEqual({ status: 'error', error: 'ENOTFOUND' });
  });

  it('applyUpdate is a no-op when nothing has been found yet (idle)', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);

    const state = await controller.applyUpdate();

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(state).toEqual({ status: 'idle' });
  });

  it('applyUpdate downloads then installs when an update is available — the one explicit, consent-gated action', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);
    autoUpdater.emit('update-available', { version: '0.9.0' });

    await controller.applyUpdate();

    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate installs directly, without re-downloading, when the update is already downloaded', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController(autoUpdater);
    autoUpdater.emit('update-downloaded', { version: '0.9.0' });

    await controller.applyUpdate();

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate resolves to an error state, without throwing, when downloadUpdate rejects', async () => {
    const autoUpdater = fakeAutoUpdater({
      downloadUpdate: vi.fn().mockRejectedValue(new Error('checksum mismatch')),
    });
    const controller = createUpdateController(autoUpdater);
    autoUpdater.emit('update-available', { version: '0.9.0' });

    const state = await controller.applyUpdate();

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(state).toEqual({ status: 'error', error: 'checksum mismatch' });
  });
});
