/**
 * Desktop-app config resolution (issue #403). Small and env-driven, matching
 * `@loombox/node`'s own `loadNodeConfig` convention of "env vars, function
 * takes an injectable `env` for tests" (`packages/node/src/config.ts`).
 */

import { resolveDesktopEnvironmentConfig } from './environment';

/** The production PWA's own default origin (matches `@loombox/relay`'s `DEFAULT_APP_URL`, `packages/relay/src/device-auth.ts`, and `deploy/web/README.md`) — the production entry of `./environment.ts`'s table, re-exported here since every existing caller of this constant means "the production origin specifically", not "whichever environment this build is". */
export const DEFAULT_PWA_URL = resolveDesktopEnvironmentConfig({ env: {} }).defaultPwaUrl;

/** The argv flag that overrides the loaded URL, e.g. `--pwa-url=http://100.64.0.1:5173`. */
export const PWA_URL_FLAG = '--pwa-url=';

export interface ResolvePwaUrlOptions {
  /** Defaults to `process.env`; tests inject a plain object instead. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.argv`; tests inject a plain array instead. */
  argv?: readonly string[];
}

/**
 * Resolves the URL the main `BrowserWindow` loads (issue #403: "loads
 * app.loombox.dev or a bundled build"; issue #866: "preview points at
 * preview.loombox.dev, production at app.loombox.dev").
 *
 * Three overrides, most specific first: `--pwa-url=<url>` then
 * `LOOMBOX_DESKTOP_PWA_URL`, both for pointing the shell at a `vite dev`
 * origin instead of a production/preview PWA. The argv flag exists because
 * the env var alone cannot be delivered to a GUI app launched over SSH:
 * `launchctl setenv` writes the launchd user domain (and `launchctl getenv`
 * reads it right back), but on macOS 26 a LaunchServices-started app does
 * not inherit it, so `scripts/mac-desktop.sh`'s documented `PWA_URL=`
 * override silently loaded production anyway. argv is delivered by `open
 * --args`, which does work. With neither set, the default is
 * `./environment.ts`'s `defaultPwaUrl` for whichever environment
 * `LOOMBOX_DESKTOP_ENV` (read via the same `env`) resolves to.
 */
export function resolvePwaUrl(options: ResolvePwaUrlOptions = {}): string {
  const argv = options.argv ?? process.argv;
  const flag = argv
    .find((arg) => arg.startsWith(PWA_URL_FLAG))
    ?.slice(PWA_URL_FLAG.length)
    .trim();
  if (flag) return flag;

  const env = options.env ?? process.env;
  const override = env.LOOMBOX_DESKTOP_PWA_URL?.trim();
  if (override) return override;

  return resolveDesktopEnvironmentConfig({ env }).defaultPwaUrl;
}
