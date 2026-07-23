import path from 'node:path';

import { BrowserWindow } from 'electron';

export interface CreateMainWindowOptions {
  /** The loombox PWA's URL to load — see `./config.ts`'s `resolvePwaUrl`. */
  url: string;
  /** Overrides the preload script path; defaults to `../preload/bootstrap.cjs` (the tsx-loading shim — see that file's doc comment). Overridable for tests that never actually construct a `BrowserWindow`. */
  preloadPath?: string;
  /** Polled on the window's `close` event: `true` means let it actually close (app is quitting, via `./index.ts`'s `before-quit` handler); `false`/omitted means hide instead, so the tray keeps the app alive when the user just clicks the window's close button. */
  isQuitting?: () => boolean;
}

/**
 * Creates the single main `BrowserWindow` that loads the loombox PWA
 * (issue #403). Starts hidden and shows once the page is ready, avoiding
 * the classic white-flash-then-content flicker; closing it hides the window
 * rather than quitting (the tray keeps the app alive — see `./tray.ts` and
 * `./index.ts`'s `window-all-closed` handling).
 */
export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'loombox',
    webPreferences: {
      // Sandboxed + isolated + no direct Node access in the renderer (the
      // PWA is untrusted, remotely-loaded web content) — the preload script
      // is the *only* bridge, via `contextBridge` (see `../preload/index.ts`
      // and `../../shared/bridge.ts`'s doc comment).
      preload: options.preloadPath ?? path.join(__dirname, '../preload/bootstrap.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.on('close', (event) => {
    if (!options.isQuitting?.()) {
      event.preventDefault();
      window.hide();
    }
  });

  void window.loadURL(options.url);

  return window;
}
