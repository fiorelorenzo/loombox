// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { themeStore } from './theme';

const STORAGE_KEY = 'loombox:theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  themeStore.setTheme('system');
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('themeStore (#195 design tokens: theme mechanism)', () => {
  it('init() with no stored preference leaves data-theme unset (tokens.css follows prefers-color-scheme)', () => {
    themeStore.init();
    expect(get(themeStore.preference)).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('init() restores a persisted explicit preference and stamps it on <html>', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    themeStore.init();
    expect(get(themeStore.preference)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('setTheme("dark") stamps data-theme and persists it', () => {
    themeStore.setTheme('dark');
    expect(get(themeStore.preference)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('setTheme("system") clears the attribute and the persisted key', () => {
    themeStore.setTheme('light');
    themeStore.setTheme('system');
    expect(get(themeStore.preference)).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('toggleTheme() flips dark <-> light', () => {
    themeStore.setTheme('dark');
    themeStore.toggleTheme();
    expect(get(themeStore.preference)).toBe('light');
    themeStore.toggleTheme();
    expect(get(themeStore.preference)).toBe('dark');
  });

  it('ignores a corrupt/unknown stored value and falls back to system', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-real-theme');
    themeStore.init();
    expect(get(themeStore.preference)).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
