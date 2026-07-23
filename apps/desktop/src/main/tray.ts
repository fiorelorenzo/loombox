import { Menu, Tray, type BrowserWindow } from 'electron';

export interface CreateTrayOptions {
  /** Path to the tray icon; Electron auto-picks up a `@2x` sibling for HiDPI by naming convention. Defaults to `../../assets/tray-iconTemplate.png` (a placeholder woven-motif mark — see `README.md`'s "swap the placeholder art" note). The `Template` suffix opts into macOS's automatic light/dark menu-bar tinting. */
  iconPath: string;
  window: BrowserWindow;
  onQuit: () => void;
}

/** Creates the menubar/tray presence (issue #403): click toggles the main window, right-click (or the same click on Linux/Windows) shows a small menu. */
export function createTray(options: CreateTrayOptions): Tray {
  const tray = new Tray(options.iconPath);
  tray.setToolTip('loombox');

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
      { label: 'Show loombox', click: toggleWindow },
      { type: 'separator' },
      { label: 'Quit loombox', click: options.onQuit },
    ]),
  );

  tray.on('click', toggleWindow);

  return tray;
}
