import { describe, expect, it } from 'vitest';
import {
  AA_CONTRAST_MIN,
  contrastRatio,
  darken,
  deriveAccentPalette,
  pickOnAccentInk,
  relativeLuminance,
  withAlpha,
} from './accent-color';
import { ACCENT_PRESETS } from './accent-presets';

describe('darken (#376 derive-accent util)', () => {
  it('darkens each channel toward black by the given fraction', () => {
    expect(darken('#3b9df7', 0)).toBe('#3b9df7');
    expect(darken('#ffffff', 0.5)).toBe('#808080');
    expect(darken('#000000', 0.5)).toBe('#000000');
  });

  it('never produces a negative or out-of-range channel', () => {
    const result = darken('#010101', 1);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    expect(result).toBe('#000000');
  });
});

describe('withAlpha', () => {
  it('formats as rgb(r g b / a%), matching tokens.css subtle tokens', () => {
    expect(withAlpha('#3b9df7', 16)).toBe('rgb(59 157 247 / 16%)');
  });
});

describe('relativeLuminance / contrastRatio', () => {
  it('gives black and white the WCAG-canonical 21:1 ratio', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is symmetric and 1:1 for identical colors', () => {
    expect(contrastRatio('#3b9df7', '#3b9df7')).toBeCloseTo(1, 5);
    expect(contrastRatio('#112233', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#112233'), 5);
  });
});

describe('pickOnAccentInk', () => {
  it('picks near-white ink against a dark accent', () => {
    expect(pickOnAccentInk('#1b1d20')).toBe('#ffffff');
  });

  it('picks near-black ink against a light/bright accent', () => {
    expect(pickOnAccentInk('#f5f5f5')).toBe('#0a0a0a');
  });

  it('always clears (or ties at) AA against every one of the six preset base hexes, both grounds', () => {
    for (const grounds of Object.values(ACCENT_PRESETS)) {
      for (const hex of [grounds.dark, grounds.light]) {
        const ink = pickOnAccentInk(hex);
        expect(contrastRatio(hex, ink)).toBeGreaterThanOrEqual(AA_CONTRAST_MIN);
      }
    }
  });
});

describe('deriveAccentPalette', () => {
  it('derives hover/active as progressively darker, and preserves the base as `accent`', () => {
    const palette = deriveAccentPalette('#3b9df7');
    expect(palette.accent).toBe('#3b9df7');
    expect(relativeLuminance(palette.hover)).toBeLessThan(relativeLuminance(palette.accent));
    expect(relativeLuminance(palette.active)).toBeLessThan(relativeLuminance(palette.hover));
  });

  it('derives subtle as the base at 16% alpha', () => {
    const palette = deriveAccentPalette('#3b9df7');
    expect(palette.subtle).toBe('rgb(59 157 247 / 16%)');
  });

  it('derives an AA-correct on-accent contrast ink for every built-in preset, both grounds', () => {
    for (const grounds of Object.values(ACCENT_PRESETS)) {
      for (const hex of [grounds.dark, grounds.light]) {
        const palette = deriveAccentPalette(hex);
        expect(contrastRatio(hex, palette.contrast)).toBeGreaterThanOrEqual(AA_CONTRAST_MIN);
      }
    }
  });

  it('is a pure function of the input hex (same input -> identical output)', () => {
    expect(deriveAccentPalette('#7c74ff')).toEqual(deriveAccentPalette('#7c74ff'));
  });
});
