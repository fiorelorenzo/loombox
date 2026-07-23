/**
 * Desktop-app config resolution (issue #403). Small and env-driven, matching
 * `@loombox/node`'s own `loadNodeConfig` convention of "env vars, function
 * takes an injectable `env` for tests" (`packages/node/src/config.ts`).
 */

/** The production PWA's own default origin (matches `@loombox/relay`'s `DEFAULT_APP_URL`, `packages/relay/src/device-auth.ts`, and `deploy/web/README.md`). */
export const DEFAULT_PWA_URL = 'https://app.loombox.dev';

export interface ResolvePwaUrlOptions {
  /** Defaults to `process.env`; tests inject a plain object instead. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the URL the main `BrowserWindow` loads (issue #403: "loads
 * app.loombox.dev or a bundled build"). `LOOMBOX_DESKTOP_PWA_URL` overrides
 * it for local dev against `pnpm --filter @loombox/web dev`'s own origin
 * (typically `http://localhost:5173`) instead of the production PWA.
 */
export function resolvePwaUrl(options: ResolvePwaUrlOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.LOOMBOX_DESKTOP_PWA_URL?.trim();
  return override ? override : DEFAULT_PWA_URL;
}
