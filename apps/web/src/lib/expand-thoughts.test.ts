// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THOUGHT_DISPLAY_MODE, expandThoughtsStore } from './expand-thoughts';

const STORAGE_KEY = 'loombox:expand-thoughts';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  expandThoughtsStore.setMode(DEFAULT_THOUGHT_DISPLAY_MODE);
  localStorage.clear();
});

describe('expandThoughtsStore (C4-2, issue #745: one global three-state switch, every thought follows it)', () => {
  it("defaults to automatic with nothing stored — C4-2's own pick", () => {
    expandThoughtsStore.init();
    expect(get(expandThoughtsStore.mode)).toBe('automatic');
  });

  it('setMode persists each of the three states to localStorage', () => {
    expandThoughtsStore.setMode('collapsed');
    expect(get(expandThoughtsStore.mode)).toBe('collapsed');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('collapsed');

    expandThoughtsStore.setMode('expanded');
    expect(get(expandThoughtsStore.mode)).toBe('expanded');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('expanded');

    expandThoughtsStore.setMode('automatic');
    expect(get(expandThoughtsStore.mode)).toBe('automatic');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('automatic');
  });

  it('a later init() restores the persisted choice — the reload-survives-it guarantee', () => {
    expandThoughtsStore.setMode('collapsed');
    // A fresh call to init() is what a newly-opened session runs: it must
    // read back the same persisted value, not silently reset to the
    // module's static default.
    expandThoughtsStore.init();
    expect(get(expandThoughtsStore.mode)).toBe('collapsed');
  });

  it('falls back to automatic on a corrupt/unrecognized stored value', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-real-value');
    expandThoughtsStore.init();
    expect(get(expandThoughtsStore.mode)).toBe('automatic');
  });

  describe('migrating the pre-#745 boolean', () => {
    it("a stored 'true' (old always-expanded) migrates to 'expanded'", () => {
      localStorage.setItem(STORAGE_KEY, 'true');
      expandThoughtsStore.init();
      expect(get(expandThoughtsStore.mode)).toBe('expanded');
    });

    it("a stored 'false' migrates to 'automatic', not 'collapsed' — 'false' used to mean \"forced visible while producing, collapsed once settled\" (issue #660), which is what 'automatic' means now; mapping it to the new, stricter 'collapsed' would silently take away streaming visibility nobody asked to lose", () => {
      localStorage.setItem(STORAGE_KEY, 'false');
      expandThoughtsStore.init();
      expect(get(expandThoughtsStore.mode)).toBe('automatic');
    });

    it('rewrites the migrated value back to localStorage so the legacy boolean is not re-migrated on every future load', () => {
      localStorage.setItem(STORAGE_KEY, 'true');
      expandThoughtsStore.init();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('expanded');
    });

    it('does not touch localStorage for a brand-new user with nothing stored', () => {
      expandThoughtsStore.init();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });
});
