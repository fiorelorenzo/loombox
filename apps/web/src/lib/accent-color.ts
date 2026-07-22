/**
 * Pure color math for loombox's accent-theming system (issue #376,
 * SPEC.md §4's "thread" accent). One function, {@link deriveAccentPalette},
 * turns a single base hex into the full set of accent tokens `tokens.css`
 * already defines (`--color-accent{,-hover,-active,-subtle,-contrast}`) —
 * the six built-in presets (`accent-presets.ts`) and a user-typed custom
 * hex both go through this exact function, so there is only ever one
 * derivation to keep AA-correct, not two.
 *
 * No DOM/localStorage access here on purpose (see `accent.ts` for that) —
 * this file is plain math, trivially unit-testable against fixed inputs.
 */

export interface AccentPalette {
  /** The base accent color itself, unchanged. */
  accent: string;
  /** ~8% darker than `accent` — hover state. */
  hover: string;
  /** ~14% darker than `accent` — active/pressed state. */
  active: string;
  /** `accent` at ~16% alpha, in `tokens.css`'s own `rgb(r g b / a%)` format — selected/subtle-fill backgrounds. */
  subtle: string;
  /** Near-black or near-white, whichever clears (or comes closer to) WCAG AA against `accent` — the ink for text/icons drawn on an accent-filled surface (e.g. a primary button's label). */
  contrast: string;
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

type Rgb = [number, number, number];

/** Accepts `#rgb` or `#rrggbb` (case-insensitive, leading `#` optional). */
function hexToRgb(hex: string): Rgb {
  const normalized = hex.trim().replace(/^#/, '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized;
  const value = parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Darkens a hex color toward black by `amount` (a 0..1 fraction of each channel's value). */
export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const factor = 1 - amount;
  return rgbToHex([r * factor, g * factor, b * factor]);
}

/** `rgb(r g b / alphaPct%)` — the exact alpha-channel format `tokens.css`'s own `*-subtle` tokens already use. */
export function withAlpha(hex: string, alphaPct: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / ${alphaPct}%)`;
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG 2.x contrast ratio between two colors: 1 (identical) to 21 (black vs white). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

const NEAR_BLACK = '#0a0a0a';
const NEAR_WHITE = '#ffffff';

/** WCAG AA, normal-size text/icons. */
export const AA_CONTRAST_MIN = 4.5;

/** Picks whichever of near-black/near-white ink clears (or, failing that, comes closest to) AA against `hex` — the "on-accent" ink for text/icons drawn on an accent-filled surface. */
export function pickOnAccentInk(hex: string): string {
  const blackRatio = contrastRatio(hex, NEAR_BLACK);
  const whiteRatio = contrastRatio(hex, NEAR_WHITE);
  return blackRatio >= whiteRatio ? NEAR_BLACK : NEAR_WHITE;
}

const HOVER_DARKEN = 0.08;
const ACTIVE_DARKEN = 0.14;
const SUBTLE_ALPHA_PCT = 16;

/**
 * Derives the full accent palette from a single base hex (#376): hover
 * ~8% darker, active ~14% darker, a 16%-alpha soft fill, and an AA-correct
 * on-accent ink. Both the six built-in presets (`accent-presets.ts`, one
 * call per theme ground) and a user's custom hex (one call, reused across
 * both grounds) go through this exact function — see that file's and
 * `accent.ts`'s doc comments for how the two compose with light/dark.
 */
export function deriveAccentPalette(baseHex: string): AccentPalette {
  return {
    accent: baseHex,
    hover: darken(baseHex, HOVER_DARKEN),
    active: darken(baseHex, ACTIVE_DARKEN),
    subtle: withAlpha(baseHex, SUBTLE_ALPHA_PCT),
    contrast: pickOnAccentInk(baseHex),
  };
}
