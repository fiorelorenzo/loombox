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
/** The right sidebar's open-by-default threshold (design spec §3.3, issue #571) — above this, it defaults open when a session is selected; below it, `drawerPinned`'s predecessor and now `+page.svelte`'s own `rightSidebarNarrowViewport` decide the panel is always a sheet/overlay regardless of any pin-like preference. */
export const WIDE_VIEWPORT_BREAKPOINT_PX = 1280;

/**
 * The sub-pixel amount subtracted from a breakpoint to build the EXCLUSIVE
 * complement of a `min-width: ${breakpointPx}px` CSS rule at that same
 * number (issue #573). Before this, `isNarrowViewport(breakpointPx)`
 * interpolated the breakpoint into `max-width` as-is, so a caller that also
 * had a `min-width` rule at the identical number got two conditions BOTH
 * true at exactly that pixel — `viewport.ts`'s own `(max-width: 1280px)` and
 * `+page.svelte`'s `(min-width: 1280px)` were both true at 1280px, which is
 * exactly where the workbench panel's pin control sat dead: visible because
 * the CSS rule matched, inert because the JS-driven overlay flag also
 * matched. `0.02` is the conventional fix (`matchMedia` resolves widths to
 * two decimal places, so it's the smallest step that still lands strictly
 * below any integer pixel width a real viewport reports) — derived from
 * `breakpointPx` itself via {@link isNarrowViewport}'s `exclusive` option
 * rather than a second, separately hand-typed literal, so the two
 * conditions can never drift back apart the way they did before.
 */
export const EXCLUSIVE_BREAKPOINT_EPSILON_PX = 0.02;

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
export function isNarrowViewport(
  breakpointPx = NARROW_VIEWPORT_BREAKPOINT_PX,
  options?: {
    /**
     * Builds `(max-width: ${breakpointPx - EXCLUSIVE_BREAKPOINT_EPSILON_PX}px)`
     * instead of `(max-width: ${breakpointPx}px)` — see
     * {@link EXCLUSIVE_BREAKPOINT_EPSILON_PX}'s doc comment. Pass this
     * whenever `breakpointPx` is also used as a CSS `min-width` threshold
     * for the same on/off decision. The two existing bare callers (the
     * narrow-viewport footer at 480, the sessions sheet at 768) have no such
     * sibling rule and stay `false`, unchanged.
     */
    exclusive?: boolean;
  },
): Readable<boolean> {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return readable(false);
  }

  const thresholdPx = options?.exclusive
    ? breakpointPx - EXCLUSIVE_BREAKPOINT_EPSILON_PX
    : breakpointPx;
  const query = window.matchMedia(`(max-width: ${thresholdPx}px)`);
  return readable(query.matches, (set) => {
    const listener = (event: MediaQueryListEvent) => set(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  });
}
