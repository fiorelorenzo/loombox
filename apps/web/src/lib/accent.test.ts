// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accentStore, DEFAULT_ACCENT_SELECTION } from './accent';
import { deriveAccentPalette } from './accent-color';
import { ACCENT_PRESETS } from './accent-presets';
import { themeStore } from './theme';

const STORAGE_KEY = 'loombox:accent';

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
    fire: (next: boolean) => listeners.forEach((l) => l({ matches: next } as MediaQueryListEvent)),
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.style.cssText = '';
});

afterEach(() => {
  themeStore.setTheme('system');
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.style.cssText = '';
  vi.unstubAllGlobals();
});

describe('accentStore (#376 accent theme system)', () => {
  it('defaults to the azure preset with nothing stored', () => {
    accentStore.init();
    expect(get(accentStore.selection)).toEqual(DEFAULT_ACCENT_SELECTION);
    expect(document.documentElement.getAttribute('data-accent')).toBe('azure');
    const expected = deriveAccentPalette(ACCENT_PRESETS.azure.dark);
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(expected.accent);
    expect(document.documentElement.style.getPropertyValue('--color-accent-contrast')).toBe(
      expected.contrast,
    );
  });

  it('selecting a preset applies its derived palette and persists the selection', () => {
    accentStore.init();
    accentStore.setPreset('violet');

    expect(get(accentStore.selection)).toEqual({ type: 'preset', key: 'violet' });
    expect(document.documentElement.getAttribute('data-accent')).toBe('violet');
    const expected = deriveAccentPalette(ACCENT_PRESETS.violet.dark);
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(expected.accent);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      type: 'preset',
      key: 'violet',
    });
  });

  it('a preset resolves its light hex once the theme is explicitly light', () => {
    accentStore.init();
    accentStore.setPreset('teal');
    themeStore.setTheme('light');

    const expected = deriveAccentPalette(ACCENT_PRESETS.teal.light);
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(expected.accent);
  });

  it('a preset re-resolves when the OS scheme flips while still on "system"', () => {
    const { fire } = stubMatchMedia(false);
    accentStore.init();
    accentStore.setPreset('cyan');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(
      deriveAccentPalette(ACCENT_PRESETS.cyan.dark).accent,
    );

    fire(true);
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(
      deriveAccentPalette(ACCENT_PRESETS.cyan.light).accent,
    );
  });

  it('setCustom derives and applies a palette from the given hex, and persists it', () => {
    accentStore.init();
    accentStore.setCustom('#123abc');

    expect(get(accentStore.selection)).toEqual({ type: 'custom', hex: '#123abc' });
    expect(document.documentElement.getAttribute('data-accent')).toBe('custom');
    const expected = deriveAccentPalette('#123abc');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(expected.accent);
    expect(document.documentElement.style.getPropertyValue('--color-accent-hover')).toBe(
      expected.hover,
    );
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      type: 'custom',
      hex: '#123abc',
    });
  });

  it('a custom hex stays applied regardless of theme (one hex, both grounds)', () => {
    accentStore.init();
    accentStore.setCustom('#123abc');
    themeStore.setTheme('light');

    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(
      deriveAccentPalette('#123abc').accent,
    );
  });

  it('init() restores a persisted custom selection', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'custom', hex: '#654321' }));
    accentStore.init();

    expect(get(accentStore.selection)).toEqual({ type: 'custom', hex: '#654321' });
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(
      deriveAccentPalette('#654321').accent,
    );
  });

  it('ignores a corrupt/unknown stored value and falls back to azure', () => {
    localStorage.setItem(STORAGE_KEY, 'not json at all');
    accentStore.init();
    expect(get(accentStore.selection)).toEqual(DEFAULT_ACCENT_SELECTION);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'preset', key: 'not-a-real-preset' }));
    accentStore.init();
    expect(get(accentStore.selection)).toEqual(DEFAULT_ACCENT_SELECTION);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'custom', hex: 'not-a-hex' }));
    accentStore.init();
    expect(get(accentStore.selection)).toEqual(DEFAULT_ACCENT_SELECTION);
  });
});
