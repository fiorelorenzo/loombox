/**
 * The "visible marker inside the app's own chrome" issue #866 asks for,
 * beyond the product name already differing in the dock/menu bar/title:
 * a small ribbon `./window.ts` stamps onto whatever page is loaded, on
 * every navigation, from the main process — independent of the PWA's own
 * source. Two windows loading the same origin with the same title would
 * otherwise look identical enough that a preview command gets sent to
 * production by mistake, which is the whole failure mode this issue exists
 * to close off.
 *
 * Pure string builders so the generated CSS/JS is assertable without a real
 * `BrowserWindow` (this app's general testing convention — see
 * `./login-item.ts`'s doc comment); `./window.ts` is the only caller that
 * actually calls `webContents.insertCSS`/`executeJavaScript` with the
 * output.
 */

/** DOM id of the injected ribbon — also the re-injection guard: idempotent across repeated `did-finish-load` events (e.g. an in-page navigation) instead of stacking duplicate ribbons. */
export const CHROME_BADGE_ELEMENT_ID = 'loombox-desktop-chrome-badge';

/** CSS for the ribbon, injected once per page load via `webContents.insertCSS`. Fixed, full-width, top of the window, above any PWA content (`z-index` maxed) and non-interactive (`pointer-events: none`) so it never intercepts a click meant for the page underneath. */
export function buildChromeBadgeCss(): string {
  return `
#${CHROME_BADGE_ELEMENT_ID} {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2147483647;
  padding: 3px 0;
  text-align: center;
  font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #fff;
  background: #b45309;
  pointer-events: none;
}
`;
}

/** JS for the ribbon's text node, injected via `webContents.executeJavaScript`. Creates `#${CHROME_BADGE_ELEMENT_ID}` under `<html>` on first run, then only ever updates its text on later runs — safe to call on every `did-finish-load` without accumulating duplicates. */
export function buildChromeBadgeScript(label: string): string {
  return `
(() => {
  const id = ${JSON.stringify(CHROME_BADGE_ELEMENT_ID)};
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    document.documentElement.appendChild(el);
  }
  el.textContent = ${JSON.stringify(label)};
})();
`;
}
