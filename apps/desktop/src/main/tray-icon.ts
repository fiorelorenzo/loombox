/**
 * Which of the two tray icon renders `gen-brand-assets.mjs` produces
 * (issue #566) `createTray` should get, given the running platform. Split
 * out of `tray.ts` on purpose: `tray.ts` imports `electron` directly (it's
 * one of the few files under `main/` the README's "Architecture" section
 * calls out as not written against an injectable Electron surface), and
 * this pick needs none of that — keeping it here means `pickTrayIconPath`
 * stays unit-testable with a plain platform string, and importing it
 * never pulls the real `electron` package into a `vitest run` the way
 * `import ... from './tray'` would.
 */

export interface TrayIconPaths {
  /** The macOS template image (black + alpha) — macOS tints this automatically for the light/dark menu bar via the `Template` filename suffix. */
  template: string;
  /** The colored (azure) glyph for platforms macOS doesn't tint. */
  colored: string;
}

/**
 * Picks the template image on darwin (which the OS tints itself) and the
 * colored render everywhere else — Windows and a dark Linux panel apply
 * no tinting at all, so an untinted template image would sit on the
 * taskbar as a solid black blob.
 */
export function pickTrayIconPath(platform: NodeJS.Platform, paths: TrayIconPaths): string {
  return platform === 'darwin' ? paths.template : paths.colored;
}
