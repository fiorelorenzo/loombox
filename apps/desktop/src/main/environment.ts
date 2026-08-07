/**
 * Desktop-app environment resolution (issue #866, epic #863): the one place
 * that knows every value that has to differ between a production install and
 * a preview install running on the same Mac at the same time. Both
 * `electron-builder.ts` (build time — appId, productName, deep-link scheme)
 * and `./index.ts` (run time — userData directory, window title, in-app
 * marker, default PWA origin) read this same table, so there is exactly one
 * build configuration parameterised by environment rather than two configs
 * that can drift apart.
 *
 * Same env-injection convention as `./config.ts`'s `resolvePwaUrl` and
 * `@loombox/node`'s `loadNodeConfig`: a function that defaults to
 * `process.env` but takes an injectable `env` for tests.
 */

export type DesktopEnvironment = 'production' | 'preview';

export interface DesktopEnvironmentConfig {
  readonly environment: DesktopEnvironment;
  /**
   * electron-builder's `appId`. Two installs with the same id are the same
   * app to macOS: the second install replaces the first instead of sitting
   * beside it.
   */
  readonly appId: string;
  /**
   * The product name Electron surfaces in the dock, the menu bar and the
   * default window title (`app.setName()` at runtime, `productName` at
   * build time). Has to be obvious at a glance, because the whole point of
   * this issue is running both at once.
   */
  readonly productName: string;
  /**
   * The directory name `./index.ts` passes to `app.setPath('userData', …)`,
   * joined onto `app.getPath('appData')` (the one path segment Electron
   * would otherwise derive from `productName` on its own). Set explicitly
   * rather than left to Electron's own derivation: the implicit path only
   * differs once a package actually carries a distinct `productName`, and
   * dev (`electron .`, no build step) reads `apps/desktop/package.json`
   * directly, which has neither a `productName` field nor one that varies
   * by environment. An explicit, resolved-and-tested path holds in both
   * dev and packaged, in every environment, with nothing implicit to drift.
   * This is the one that actually bites: a shared `userData` means a shared
   * `localStorage`, so a shared bearer token, a shared AMK and a shared
   * session list.
   */
  readonly userDataDirName: string;
  /**
   * The custom URL scheme this install registers as its deep-link handler
   * (electron-builder's `protocols` + `app.setAsDefaultProtocolClient` in
   * `./index.ts`). Two installs claiming the same scheme is undefined
   * behaviour — the OS picks one, silently, and it need not be the one the
   * link was meant for.
   */
  readonly protocolScheme: string;
  /**
   * Text stamped onto the loaded page's own chrome by `./chrome-badge.ts`,
   * independent of anything the PWA itself renders — `null` for production
   * (no marker). Running two identical-looking windows side by side is
   * exactly how a preview command gets sent to production by mistake, so
   * the marker lives in the app shell, not in a PWA-side opt-in.
   */
  readonly chromeBadge: string | null;
  /**
   * The PWA origin `./config.ts`'s `resolvePwaUrl` loads unless overridden.
   * `preview.loombox.dev` does not resolve yet (#865 builds the preview web
   * deployment); pointing preview installs at it now is still correct — the
   * default just isn't reachable until that issue lands.
   */
  readonly defaultPwaUrl: string;
}

const PRODUCTION: DesktopEnvironmentConfig = {
  environment: 'production',
  appId: 'com.loombox.desktop',
  productName: 'loombox',
  userDataDirName: 'loombox',
  protocolScheme: 'loombox',
  chromeBadge: null,
  defaultPwaUrl: 'https://app.loombox.dev',
};

const PREVIEW: DesktopEnvironmentConfig = {
  environment: 'preview',
  appId: 'com.loombox.desktop.preview',
  productName: 'loombox Preview',
  userDataDirName: 'loombox-preview',
  protocolScheme: 'loombox-preview',
  chromeBadge: 'PREVIEW BUILD — not production',
  defaultPwaUrl: 'https://preview.loombox.dev',
};

/** Every environment this app can be built/run as, keyed by {@link DesktopEnvironment}. */
export const DESKTOP_ENVIRONMENTS: Readonly<Record<DesktopEnvironment, DesktopEnvironmentConfig>> =
  {
    production: PRODUCTION,
    preview: PREVIEW,
  };

/**
 * The env var both `electron-builder.ts` (build time, via its own process
 * env when `pnpm run package:*:preview` is invoked) and `./index.ts` (run
 * time) read to pick an environment. Unset — the common case, every existing
 * `pnpm dev` / `pnpm package:mac` invocation — resolves to `'production'`,
 * so this is a strictly additive change: nothing has to pass this to keep
 * building the app it already built.
 */
export const DESKTOP_ENVIRONMENT_VAR = 'LOOMBOX_DESKTOP_ENV';

export interface ResolveDesktopEnvironmentOptions {
  /** Defaults to `process.env`; tests inject a plain object instead. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves which {@link DesktopEnvironment} this build/run targets.
 * Throws on an unrecognized value rather than silently falling back to
 * production — a typo'd `LOOMBOX_DESKTOP_ENV` producing a production
 * artifact from a preview build invocation is exactly the "wrong app
 * overwritten" failure mode this issue exists to close off.
 */
export function resolveDesktopEnvironmentName(
  options: ResolveDesktopEnvironmentOptions = {},
): DesktopEnvironment {
  const env = options.env ?? process.env;
  const raw = env[DESKTOP_ENVIRONMENT_VAR]?.trim();
  if (!raw) return 'production';
  if (raw === 'production' || raw === 'preview') return raw;
  throw new Error(
    `${DESKTOP_ENVIRONMENT_VAR} must be "production" or "preview" (or unset), got ${JSON.stringify(raw)}`,
  );
}

/** Resolves the full {@link DesktopEnvironmentConfig} for the current (or injected) environment. */
export function resolveDesktopEnvironmentConfig(
  options: ResolveDesktopEnvironmentOptions = {},
): DesktopEnvironmentConfig {
  return DESKTOP_ENVIRONMENTS[resolveDesktopEnvironmentName(options)];
}
