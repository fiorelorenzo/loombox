import { readable, type Readable } from 'svelte/store';

/** SPEC.md §7.3's narrow-viewport breakpoint (issue #134) — a phone-width cutoff, not a generic "tablet" one. */
export const NARROW_VIEWPORT_BREAKPOINT_PX = 480;

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
