import { runDiagnostics, readBrowserEnv } from './diagnostics';

/**
 * `www/index.html`'s entire script, bundled by `scripts/build-www.mjs` into
 * `www/diagnostics.js`. Renders {@link runDiagnostics}'s results to the DOM
 * (so a screenshot on a booted simulator is evidence on its own) and also
 * `console.log`s a single-line JSON summary, since Capacitor forwards the
 * WebView's console to native stdout — that line is what
 * `xcrun simctl launch --console` captures headless over SSH.
 */
function render(): void {
  const results = runDiagnostics(readBrowserEnv());
  const root = document.getElementById('results');
  if (root) {
    root.innerHTML = results
      .map(
        (r) =>
          `<div class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}: ${r.detail}</div>`,
      )
      .join('\n');
  }
  console.log('LOOMBOX_DIAGNOSTICS ' + JSON.stringify(results));
}

render();
