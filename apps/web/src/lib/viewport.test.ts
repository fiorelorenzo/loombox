// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNarrowViewport, WIDE_VIEWPORT_BREAKPOINT_PX } from './viewport';

afterEach(() => vi.unstubAllGlobals());

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    addEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    fire: (next: boolean) => {
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

/**
 * A `matchMedia` stub that actually evaluates the `max-width` in the query
 * string against a fixed viewport width, unlike {@link stubMatchMedia}
 * above (which returns one fixed `matches` for every query regardless of
 * its text) — needed to prove the boundary itself, not just that SOME
 * value comes back.
 */
function stubMatchMediaAtWidth(viewportWidthPx: number) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const maxWidthPx = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? Infinity);
      return {
        matches: viewportWidthPx <= maxWidthPx,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }),
  );
}

describe('isNarrowViewport (#134)', () => {
  it('reflects matchMedia at construction time', () => {
    stubMatchMedia(true);
    expect(get(isNarrowViewport())).toBe(true);
  });

  it('updates live when the media query change fires', () => {
    const { fire } = stubMatchMedia(false);
    const store = isNarrowViewport();
    const values: boolean[] = [];
    const unsubscribe = store.subscribe((value) => values.push(value));
    fire(true);
    unsubscribe();
    expect(values).toEqual([false, true]);
  });
});

describe('isNarrowViewport({ exclusive: true }) (#573)', () => {
  // Before the fix, `(max-width: 1280px)` and a sibling `(min-width:
  // 1280px)` CSS rule were BOTH true at exactly 1280px — the workbench
  // panel's pin control sat visible-but-inert in that dead zone. `exclusive`
  // makes 1280px itself belong to the wide side only.
  it('is true below the breakpoint', () => {
    stubMatchMediaAtWidth(1279);
    expect(get(isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX, { exclusive: true }))).toBe(true);
  });

  it('is false exactly at the breakpoint, unlike the inclusive default', () => {
    stubMatchMediaAtWidth(1280);
    expect(get(isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX, { exclusive: true }))).toBe(false);
    expect(get(isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX))).toBe(true);
  });

  it('is false above the breakpoint', () => {
    stubMatchMediaAtWidth(1281);
    expect(get(isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX, { exclusive: true }))).toBe(false);
  });
});
