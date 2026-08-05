// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPAND_THOUGHTS, expandThoughtsStore } from './expand-thoughts';

const STORAGE_KEY = 'loombox:expand-thoughts';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  expandThoughtsStore.setExpanded(DEFAULT_EXPAND_THOUGHTS);
  localStorage.clear();
});

describe('expandThoughtsStore (B2-1, issue #709: one global switch, every thought follows it)', () => {
  it('defaults to expanded with nothing stored — Lorenzo\'s own ask ("di default espanso")', () => {
    expandThoughtsStore.init();
    expect(get(expandThoughtsStore.expanded)).toBe(true);
  });

  it('setExpanded(false) persists the collapsed choice to localStorage', () => {
    expandThoughtsStore.setExpanded(false);
    expect(get(expandThoughtsStore.expanded)).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('a later init() restores the persisted choice — the reload-survives-it guarantee', () => {
    expandThoughtsStore.setExpanded(false);
    // A fresh call to init() is what a newly-opened session runs: it must
    // read back the same persisted value, not silently reset to the
    // module's static default.
    expandThoughtsStore.init();
    expect(get(expandThoughtsStore.expanded)).toBe(false);
  });

  it('toggle() flips the current value and persists the flip', () => {
    expandThoughtsStore.setExpanded(true);
    expandThoughtsStore.toggle();
    expect(get(expandThoughtsStore.expanded)).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');

    expandThoughtsStore.toggle();
    expect(get(expandThoughtsStore.expanded)).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('ignores a corrupt/unknown stored value and falls back to expanded', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-real-value');
    expandThoughtsStore.init();
    expect(get(expandThoughtsStore.expanded)).toBe(true);
  });
});
