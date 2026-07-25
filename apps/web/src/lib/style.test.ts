// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { styleStore } from './style';

const STORAGE_KEY = 'loombox:style';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-style');
});

afterEach(() => {
  styleStore.setStyle('deck');
  localStorage.clear();
  document.documentElement.removeAttribute('data-style');
});

describe('styleStore (#458 Style-system architecture)', () => {
  it('init() with no stored preference defaults to deck and stamps it on <html>', () => {
    styleStore.init();
    expect(get(styleStore.preference)).toBe('deck');
    expect(document.documentElement.getAttribute('data-style')).toBe('deck');
  });

  it('init() restores a persisted explicit preference and stamps it on <html>', () => {
    localStorage.setItem(STORAGE_KEY, 'loom');
    styleStore.init();
    expect(get(styleStore.preference)).toBe('loom');
    expect(document.documentElement.getAttribute('data-style')).toBe('loom');
  });

  it('setStyle("studio") stamps data-style and persists it', () => {
    styleStore.setStyle('studio');
    expect(get(styleStore.preference)).toBe('studio');
    expect(document.documentElement.getAttribute('data-style')).toBe('studio');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('studio');
  });

  it('setStyle("deck") stamps data-style and persists it too (no "system"/omit case, unlike theme.ts)', () => {
    styleStore.setStyle('loom');
    styleStore.setStyle('deck');
    expect(get(styleStore.preference)).toBe('deck');
    expect(document.documentElement.getAttribute('data-style')).toBe('deck');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('deck');
  });

  it('ignores a corrupt/unknown stored value and falls back to deck', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-real-style');
    styleStore.init();
    expect(get(styleStore.preference)).toBe('deck');
    expect(document.documentElement.getAttribute('data-style')).toBe('deck');
  });
});
