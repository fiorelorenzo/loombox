// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNarrowViewport } from './viewport';

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
