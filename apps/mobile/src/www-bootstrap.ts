import { runDiagnostics, readBrowserEnv } from './diagnostics';

/**
 * `www/index.html`'s entire script, bundled by `scripts/build-www.mjs` into
 * `www/diagnostics.js`. Renders {@link runDiagnostics}'s results to the DOM
 * (so a screenshot on a booted simulator/emulator is evidence on its own)
 * and also `console.log`s a single-line JSON summary, since Capacitor
 * forwards the WebView's console to native stdout in some launch modes.
 *
 * Wrapped in try/catch and a `window.onerror` hook on purpose: the first
 * real run of this page (iOS simulator, capacitor://localhost) hit a
 * silent JS exception with nothing but Capacitor's generic native-side "JS
 * Eval error" to go on — no simulator GUI, no remote Web Inspector reachable
 * headless over SSH. Rendering the error text itself into `#results` is
 * what turned that from an unverifiable dead end into a diagnosable, and
 * fixable, screenshot.
 */
function render(): void {
  const root = document.getElementById('results');
  try {
    const results = runDiagnostics(readBrowserEnv());
    if (root) {
      root.innerHTML = results
        .map(
          (r) =>
            `<div class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}: ${r.detail}</div>`,
        )
        .join('\n');
    }
    console.log('LOOMBOX_DIAGNOSTICS ' + JSON.stringify(results));
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    if (root) root.innerHTML = `<div class="fail">THREW: ${message}</div>`;
    console.error('LOOMBOX_DIAGNOSTICS_ERROR', message);
  }
}

window.addEventListener('error', (event) => {
  const root = document.getElementById('results');
  if (root) root.innerHTML += `<div class="fail">window.onerror: ${event.message}</div>`;
});

render();
