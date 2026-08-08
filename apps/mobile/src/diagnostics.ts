/**
 * Runtime probe for issue #281 (Capacitor mobile spike): the exact three
 * questions SPEC §5.4/§8's E2E model depends on that no amount of reading
 * Capacitor's source can settle from a Linux devbox with no emulator — they
 * need a real WebView. `www/index.html` loads this bundled and renders the
 * result to the DOM; Capacitor mirrors `console.*` from the WebView to
 * native stdout (`Bridge`'s console-forwarding, see the spec doc), so
 * `xcrun simctl launch --console` on a real booted simulator captures this
 * output even headless over SSH.
 *
 * Pure and DOM-free on purpose (only `runDiagnostics`'s caller touches the
 * DOM) so the pass/fail logic itself is unit-testable in plain Node/jsdom,
 * not just eyeballed from a screenshot.
 */
export interface DiagnosticResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface DiagnosticsEnv {
  readonly isSecureContext: boolean | undefined;
  readonly hasCryptoSubtle: boolean;
  readonly locationHref: string;
  readonly localStorageRoundTrip: () => boolean;
  readonly webSocketCtor: unknown;
}

/** Reads the live browser globals — the real `DiagnosticsEnv` `www/index.html`'s bootstrap script passes in. Kept separate from {@link runDiagnostics} so the decision logic never touches `window`/`crypto`/`localStorage` directly and can be tested against a fabricated env. */
export function readBrowserEnv(): DiagnosticsEnv {
  return {
    isSecureContext: typeof isSecureContext === 'boolean' ? isSecureContext : undefined,
    hasCryptoSubtle: typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined',
    locationHref: typeof location !== 'undefined' ? location.href : '(no location)',
    localStorageRoundTrip: () => {
      try {
        const key = '__loombox_diag__';
        localStorage.setItem(key, '1');
        const ok = localStorage.getItem(key) === '1';
        localStorage.removeItem(key);
        return ok;
      } catch {
        return false;
      }
    },
    webSocketCtor: typeof WebSocket !== 'undefined' ? WebSocket : undefined,
  };
}

/**
 * The four checks issue #281 asked for evidence on, in order: what origin/
 * scheme the WebView actually loaded (tells `capacitor://` vs
 * `https://localhost` apart), whether that origin is a secure context (the
 * AMK unwrap depends on it), whether `crypto.subtle` is actually present
 * (redundant with secure-context on a spec-compliant engine, checked
 * separately because it is the concrete API the app calls, not the
 * abstract flag), and whether `localStorage` (where the AMK is persisted,
 * `amk-store.ts`) and `WebSocket` (the relay transport) both exist and
 * work in this WebView.
 */
export function runDiagnostics(env: DiagnosticsEnv): DiagnosticResult[] {
  return [
    { name: 'origin', pass: true, detail: env.locationHref },
    {
      name: 'isSecureContext',
      pass: env.isSecureContext === true,
      detail: String(env.isSecureContext),
    },
    {
      name: 'crypto.subtle present',
      pass: env.hasCryptoSubtle,
      detail: env.hasCryptoSubtle ? 'present' : 'MISSING',
    },
    {
      name: 'localStorage round-trip',
      pass: env.localStorageRoundTrip(),
      detail: env.localStorageRoundTrip() ? 'read back own write' : 'FAILED',
    },
    {
      name: 'WebSocket constructor present',
      pass: env.webSocketCtor !== undefined,
      detail: env.webSocketCtor !== undefined ? 'present' : 'MISSING',
    },
  ];
}

/**
 * A live WebSocket round trip against `url` — closes the gap between "the
 * `WebSocket` constructor exists" ({@link runDiagnostics}'s check, which a
 * stub could pass) and "this WebView can actually open a socket, send, and
 * receive over it", which is what issue #281's relay-connection question
 * needs. `ctor` is injectable so the resolve/reject/timeout races below are
 * unit-testable against a fake, not just eyeballed from a screenshot after
 * an echo server round trip.
 */
export function probeWebSocketRoundTrip(
  ctor: typeof WebSocket,
  url: string,
  timeoutMs: number,
): Promise<DiagnosticResult> {
  const { promise, resolve } = Promise.withResolvers<DiagnosticResult>();
  let settled = false;
  const settle = (pass: boolean, detail: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ name: 'WebSocket round trip', pass, detail });
  };
  const timer = setTimeout(() => settle(false, `timed out after ${timeoutMs}ms`), timeoutMs);
  try {
    const socket = new ctor(url);
    const probeMessage = 'loombox-diagnostics-probe';
    socket.onopen = () => socket.send(probeMessage);
    socket.onmessage = (event) => {
      settle(true, `open + echoed ${JSON.stringify(event.data)}`);
      socket.close();
    };
    socket.onerror = () => settle(false, 'onerror fired');
    socket.onclose = (event) =>
      settle(false, `closed before a message arrived (code ${event.code})`);
  } catch (err) {
    settle(false, err instanceof Error ? err.message : String(err));
  }
  return promise;
}
