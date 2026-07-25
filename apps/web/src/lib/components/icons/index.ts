/**
 * Barrel for the shared icon set (issue #457) — every surface should import
 * from here rather than reaching into `Icon.svelte`/`icon-paths.ts`
 * directly.
 */
export { default as Icon } from './Icon.svelte';
export { ICON_NAMES, ICON_PATHS, FALLBACK_ICON_PATHS, type IconName } from './icon-paths';
