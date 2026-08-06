// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AppearanceSettings from './AppearanceSettings.svelte';
import { accentStore } from '$lib/accent';
import { DEFAULT_THOUGHT_DISPLAY_MODE, expandThoughtsStore } from '$lib/expand-thoughts';
import { themeStore } from '$lib/theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.style.cssText = '';
  themeStore.init();
  accentStore.init();
  expandThoughtsStore.init();
});

afterEach(() => {
  cleanup();
  themeStore.setTheme('system');
  expandThoughtsStore.setMode(DEFAULT_THOUGHT_DISPLAY_MODE);
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.style.cssText = '';
});

describe('AppearanceSettings (#195/#376 settings panel)', () => {
  it('renders a theme option per preference and an accent swatch per preset', () => {
    render(AppearanceSettings);
    expect(screen.getByTestId('appearance-settings')).toBeTruthy();
    expect(screen.getByTestId('theme-option-system')).toBeTruthy();
    expect(screen.getByTestId('theme-option-dark')).toBeTruthy();
    expect(screen.getByTestId('theme-option-light')).toBeTruthy();
    expect(screen.getByTestId('accent-preset-azure')).toBeTruthy();
    expect(screen.getByTestId('accent-preset-violet')).toBeTruthy();
    expect(screen.getByTestId('accent-preset-teal')).toBeTruthy();
    expect(screen.getByTestId('accent-preset-orchid')).toBeTruthy();
    expect(screen.getByTestId('accent-preset-emerald')).toBeTruthy();
    expect(screen.getByTestId('accent-preset-cyan')).toBeTruthy();
  });

  it('marks azure selected by default and switching theme option updates themeStore', async () => {
    render(AppearanceSettings);
    expect(screen.getByTestId('accent-preset-azure').getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(screen.getByTestId('theme-option-dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByTestId('theme-option-dark').getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking a preset swatch applies it via accentStore', async () => {
    render(AppearanceSettings);
    await fireEvent.click(screen.getByTestId('accent-preset-teal'));

    expect(document.documentElement.getAttribute('data-accent')).toBe('teal');
    expect(screen.getByTestId('accent-preset-teal').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('accent-preset-azure').getAttribute('aria-pressed')).toBe('false');
  });

  it('setting a custom color via the color input applies it via accentStore', async () => {
    render(AppearanceSettings);
    const input = screen.getByTestId('custom-accent-input') as HTMLInputElement;
    input.value = '#123abc';
    await fireEvent.input(input);

    expect(document.documentElement.getAttribute('data-accent')).toBe('custom');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#123abc');
    // No preset stays visually "selected" once a custom accent is active.
    expect(screen.getByTestId('accent-preset-azure').getAttribute('aria-pressed')).toBe('false');
  });

  it('renders Theme, Accent and Thinking as one merged card, not several (design spec §0.8)', () => {
    render(AppearanceSettings);
    expect(screen.getAllByTestId('ui-card')).toHaveLength(1);
    expect(screen.getByText('Theme')).toBeTruthy();
    expect(screen.getByText('Accent')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
  });
});

describe('AppearanceSettings: thought-display mode (C4-2, issue #745)', () => {
  it('renders a thought-mode option per mode, automatic selected by default', () => {
    render(AppearanceSettings);
    expect(screen.getByTestId('thought-mode-option-automatic')).toBeTruthy();
    expect(screen.getByTestId('thought-mode-option-expanded')).toBeTruthy();
    expect(screen.getByTestId('thought-mode-option-collapsed')).toBeTruthy();
    expect(screen.getByTestId('thought-mode-option-automatic').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('clicking a mode option applies it via expandThoughtsStore and persists it', async () => {
    render(AppearanceSettings);
    await fireEvent.click(screen.getByTestId('thought-mode-option-collapsed'));

    expect(screen.getByTestId('thought-mode-option-collapsed').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByTestId('thought-mode-option-automatic').getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(localStorage.getItem('loombox:expand-thoughts')).toBe('collapsed');
  });

  it('a later init() restores the persisted mode across a reload', async () => {
    render(AppearanceSettings);
    await fireEvent.click(screen.getByTestId('thought-mode-option-expanded'));
    cleanup();

    expandThoughtsStore.init();
    render(AppearanceSettings);
    expect(screen.getByTestId('thought-mode-option-expanded').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
