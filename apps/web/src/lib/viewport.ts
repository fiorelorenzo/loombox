import { readable, type Readable } from 'svelte/store';

/** SPEC.md §7.3's narrow-viewport breakpoint (issue #134) — a phone-width cutoff, not a generic "tablet" one. */
export const NARROW_VIEWPORT_BREAKPOINT_PX = 480;

/**
 * The Warp Deck app-shell breakpoints (redesign brief §1, issue #427) —
 * siblings of {@link NARROW_VIEWPORT_BREAKPOINT_PX} above, which they
 * reuse as `TABLET_VIEWPORT_BREAKPOINT_PX`'s mobile floor rather than
 * duplicating the number. These four match `tokens.css`'s `--bp-mobile`/
 * `--bp-tablet`/`--bp-desktop`/`--bp-wide` custom properties value-for-
 * value (kept in sync by hand — plain CSS `@media` conditions can't read
 * a custom property, so the shell's actual `@media` rules and any JS
 * `matchMedia` reads, like `isNarrowViewport` below, match against these
 * numeric constants, not the CSS tokens directly).
 */
export const TABLET_VIEWPORT_BREAKPOINT_PX = 768;
export const DESKTOP_VIEWPORT_BREAKPOINT_PX = 1024;
/** The drawer-pin threshold (redesign brief §1): below this, the Drawer is always an overlay/bottom-sheet, regardless of the user's pin preference. */
export const WIDE_VIEWPORT_BREAKPOINT_PX = 1280;

/**
 * A live `matchMedia`-backed readable of whether the viewport is currently
 * narrow (SPEC.md §7.3 "Narrow-viewport permission footer"/"Scrollable
 * option lists", issue #134). SSR/non-browser-safe: `window`/`matchMedia`
 * don't exist during `routes/page.test.ts`'s SSR render, so this starts
 * (and stays) `false` outside a real browser rather than throwing —
 * `+page.svelte` only ever reads it client-side anyway (`$effect`/
 * `onMount`), same guard pattern as this file's siblings
 * (`relay-client.ts`'s `randomBase64` doc comment explains the same
 * browser-vs-SSR split for a different API).
 */
export function isNarrowViewport(breakpointPx = NARROW_VIEWPORT_BREAKPOINT_PX): Readable<boolean> {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return readable(false);
  }

  const query = window.matchMedia(`(max-width: ${breakpointPx}px)`);
  return readable(query.matches, (set) => {
    const listener = (event: MediaQueryListEvent) => set(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  });
}
