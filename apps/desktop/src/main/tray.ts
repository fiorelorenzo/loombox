import { Menu, Tray, type BrowserWindow } from 'electron';

import type { UpdaterState } from './updater';

/** Wires the tray's own self-update menu item to `../main/updater.ts`'s `UpdateController` (issue #657) — the tray IS the "make it visible, one click to act" surface, no separate preferences window needed. */
export interface TrayUpdateOptions {
  /** Read fresh every time the menu is (re)built via `LoomboxTray.refreshMenu` — see that method's own doc comment for why a live read matters here. */
  getState: () => UpdaterState;
  onCheckForUpdates: () => void;
  onApplyUpdate: () => void;
}

export interface CreateTrayOptions {
  /** Path to the tray icon; Electron auto-picks up a `@2x` sibling for HiDPI by naming convention. The call site (`./index.ts`) resolves this via `./tray-icon.ts`'s `pickTrayIconPath` before calling `createTray`, so this is always already the platform-appropriate render: the macOS `Template` image or the colored (azure) one (issue #566). */
  iconPath: string;
  window: BrowserWindow;
  onQuit: () => void;
  /** Shown in the tooltip and the menu items below — defaults to `'loombox'`. `./index.ts` passes `./environment.ts`'s resolved `productName` so a preview install's tray reads "loombox Preview" throughout, not the same "loombox" production's tray shows (issue #866). */
  productName?: string;
  update?: TrayUpdateOptions;
}

export interface LoomboxTray {
  tray: Tray;
  /**
   * Rebuilds the context menu from `update.getState()`'s current value.
   * Electron's `Tray` doesn't re-invoke a menu factory each time it's about
   * to show — `setContextMenu` binds a fixed `Menu` object — so a caller
   * whose update state changed asynchronously (a periodic background
   * check finding something, a download finishing) has to call this
   * explicitly for the tray to reflect it. `./index.ts` calls it right
   * after every `checkForUpdates()`/`applyUpdate()` settles.
   */
  refreshMenu: () => void;
}

function updateMenuItem(update: TrayUpdateOptions): Electron.MenuItemConstructorOptions {
  const state = update.getState();
  switch (state.status) {
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false };
    case 'available':
      return {
        label: `Download & Install${state.version ? ` v${state.version}` : ''}`,
        click: update.onApplyUpdate,
      };
    case 'downloading':
      return { label: 'Downloading Update…', enabled: false };
    case 'downloaded':
      return {
        label: `Restart to Update${state.version ? ` (v${state.version})` : ''}`,
        click: update.onApplyUpdate,
      };
    case 'error':
      // Still offers a retry rather than dead-ending on one failed check
      // (a transient network blip shouldn't need an app restart to clear).
      return { label: 'Check for Updates (last check failed)', click: update.onCheckForUpdates };
    case 'not-available':
    case 'idle':
    default:
      return { label: 'Check for Updates', click: update.onCheckForUpdates };
  }
}

/** Creates the menubar/tray presence (issue #403): click toggles the main window, right-click (or the same click on Linux/Windows) shows a small menu. */
export function createTray(options: CreateTrayOptions): LoomboxTray {
  const productName = options.productName ?? 'loombox';
  const tray = new Tray(options.iconPath);
  tray.setToolTip(productName);

  const toggleWindow = (): void => {
    if (options.window.isVisible()) {
      options.window.hide();
    } else {
      options.window.show();
      options.window.focus();
    }
  };

  const buildMenu = (): Menu => {
    const update = options.update;
    return Menu.buildFromTemplate([
      { label: `Show ${productName}`, click: toggleWindow },
      { type: 'separator' },
      ...(update ? [updateMenuItem(update), { type: 'separator' } as const] : []),
      { label: `Quit ${productName}`, click: options.onQuit },
    ]);
  };

  const refreshMenu = (): void => {
    tray.setContextMenu(buildMenu());
  };
  refreshMenu();

  tray.on('click', toggleWindow);

  return { tray, refreshMenu };
}
