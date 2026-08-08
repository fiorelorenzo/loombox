import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Issue #281's spike scaffold. `webDir: 'www'` currently holds the
 * diagnostics probe (`scripts/build-www.mjs`'s output), not the real PWA —
 * see the spike doc for why apps/web's `adapter-node` build can't be
 * `cap sync`'d as-is.
 *
 * `server.androidScheme: 'https'` is Capacitor 5+'s own default (kept
 * explicit rather than implied, since the whole point of writing it down is
 * that a future Capacitor major silently changing the default would
 * silently change loombox's secure-context story too) — it is what makes
 * `isSecureContext`/`crypto.subtle` available at all: Android intercepts
 * `https://localhost/*` and serves the bundled `webDir` locally
 * (`WebViewLocalServer`, no real TLS handshake), which Chromium's WebView
 * treats as a secure context because the check is scheme + host, not "was
 * there a real certificate". iOS has no such choice — `capacitor://` is the
 * only local scheme WKWebView supports (`https:` is reserved for real
 * remote loads there) and it is secure-context by the same
 * scheme-allowlist logic; see the spike doc's per-platform citations.
 */
const config: CapacitorConfig = {
  appId: 'dev.loombox.app',
  appName: 'loombox',
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
};

export default config;
