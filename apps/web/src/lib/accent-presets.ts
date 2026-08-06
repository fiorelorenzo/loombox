/**
 * The six built-in accent presets (#376). Each preset carries a curated
 * hex per theme ground (dark/light) rather than one hex `deriveAccentPalette`
 * would tint for both — the same "thread" hue reads differently against
 * `tokens.css`'s dark ink vs light paper background, so both ends were
 * chosen by eye for even legibility rather than computed from one another.
 * `accent.ts` picks the right one of the pair off the current resolved
 * theme, then runs it through `deriveAccentPalette` (`accent-color.ts`) for
 * the hover/active/subtle/contrast variants — a custom hex (also in
 * `accent.ts`) skips this file entirely and uses one hex for both grounds.
 *
 * `dark` values were re-lightened for Zed-parity A1-2 (issue #733,
 * `deck.css`'s new lighter dark ground): the originals fell under
 * `accent-color.ts`'s `AA_CONTRAST_MIN` (4.5:1) as text against the new,
 * lighter `--color-surface-raised` (e.g. azure dropped to 3.39:1). Each
 * was lightened in Lab, hue and chroma held, until it cleared 4.5:1 there
 * again — `--color-surface-raised` chosen as the binding case because
 * it's the lightest of the three grounds these colors actually render
 * text on (`--color-bg`/`--color-surface` are darker, so easier). `light`
 * values are untouched: their own ground didn't move.
 */
export interface AccentPresetGrounds {
  dark: string;
  light: string;
}

export const ACCENT_PRESETS = {
  azure: { dark: '#64baff', light: '#1f7fd0' },
  violet: { dark: '#b7a8ff', light: '#5b4fd6' },
  teal: { dark: '#34c8b5', light: '#0e8a7d' },
  orchid: { dark: '#ff88f1', light: '#b8339f' },
  emerald: { dark: '#3dca91', light: '#0f9d68' },
  cyan: { dark: '#25c5d8', light: '#0e94a6' },
} as const satisfies Record<string, AccentPresetGrounds>;

export type AccentPresetKey = keyof typeof ACCENT_PRESETS;

/** Display order for the settings panel's swatch row — insertion order of `ACCENT_PRESETS`, azure (the default) first. */
export const ACCENT_PRESET_KEYS = Object.keys(ACCENT_PRESETS) as AccentPresetKey[];

/** Human-readable labels for the settings panel. */
export const ACCENT_PRESET_LABELS: Record<AccentPresetKey, string> = {
  azure: 'Azure',
  violet: 'Violet',
  teal: 'Teal',
  orchid: 'Orchid',
  emerald: 'Emerald',
  cyan: 'Cyan',
};

export function isAccentPresetKey(value: unknown): value is AccentPresetKey {
  return typeof value === 'string' && Object.hasOwn(ACCENT_PRESETS, value);
}
