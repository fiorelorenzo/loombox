import path from 'node:path';

import { BrowserWindow } from 'electron';

import { buildChromeBadgeCss, buildChromeBadgeScript } from './chrome-badge';

export interface CreateMainWindowOptions {
  /** The loombox PWA's URL to load — see `./config.ts`'s `resolvePwaUrl`. */
  url: string;
  /** The window title, and on macOS the name shown in the app menu next to the Apple menu. Defaults to `'loombox'`; `./index.ts` passes `./environment.ts`'s resolved `productName` so a preview build's window never reads the same title as production's (issue #866). */
  title?: string;
  /** Stamped onto the loaded page's own chrome via `./chrome-badge.ts` on every navigation, independent of the PWA's own content — `undefined`/`null` shows nothing. `./index.ts` passes `./environment.ts`'s resolved `chromeBadge` (issue #866: "a visible marker inside the app's own chrome", beyond the title alone). */
  chromeBadge?: string | null;
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
    title: options.title ?? 'loombox',
    webPreferences: {
      // Context-isolated with no direct Node access in the renderer (the PWA
      // is untrusted, remotely-loaded web content) — the preload script is
      // the *only* bridge, via `contextBridge` (see `../preload/index.ts` and
      // `../../shared/bridge.ts`'s doc comment). `sandbox` is off: the preload
      // runs raw TS through tsx (`preload/bootstrap.cjs`), and a sandboxed
      // preload cannot `require('tsx/cjs')` (only a small module allow-list is
      // available), so it failed to load at all. contextIsolation still keeps
      // the renderer walled off from the preload's Node world.
      preload: options.preloadPath ?? path.join(__dirname, '../preload/bootstrap.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // The environment marker (issue #866): (re-)injected on every
  // `did-finish-load` — the initial load and any later *real* navigation
  // (a full document reload, e.g. an OAuth redirect round trip), which is
  // the only time the injected element is actually gone. The PWA's own
  // client-side routing (`pushState`) never fires this event and never
  // removes `document.documentElement`, so the badge simply persists
  // through it untouched. `buildChromeBadgeScript` is idempotent regardless
  // — it updates the existing element instead of appending a new one — so a
  // rapid string of real navigations never stacks duplicate ribbons.
  if (options.chromeBadge) {
    const badge = options.chromeBadge;
    window.webContents.on('did-finish-load', () => {
      void window.webContents.insertCSS(buildChromeBadgeCss());
      void window.webContents.executeJavaScript(buildChromeBadgeScript(badge));
    });
  }

  window.on('close', (event) => {
    if (!options.isQuitting?.()) {
      event.preventDefault();
      window.hide();
    }
  });

  void window.loadURL(options.url);

  return window;
}
