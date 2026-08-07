import { Menu, Tray, type BrowserWindow } from 'electron';

export interface CreateTrayOptions {
  /** Path to the tray icon; Electron auto-picks up a `@2x` sibling for HiDPI by naming convention. The call site (`./index.ts`) resolves this via `./tray-icon.ts`'s `pickTrayIconPath` before calling `createTray`, so this is always already the platform-appropriate render: the macOS `Template` image or the colored (azure) one (issue #566). */
  iconPath: string;
  window: BrowserWindow;
  onQuit: () => void;
  /** Shown in the tooltip and the menu items below — defaults to `'loombox'`. `./index.ts` passes `./environment.ts`'s resolved `productName` so a preview install's tray reads "loombox Preview" throughout, not the same "loombox" production's tray shows (issue #866). */
  productName?: string;
}

/** Creates the menubar/tray presence (issue #403): click toggles the main window, right-click (or the same click on Linux/Windows) shows a small menu. */
export function createTray(options: CreateTrayOptions): Tray {
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

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Show ${productName}`, click: toggleWindow },
      { type: 'separator' },
      { label: `Quit ${productName}`, click: options.onQuit },
    ]),
  );

  tray.on('click', toggleWindow);

  return tray;
}
