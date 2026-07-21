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
 */
export interface AccentPresetGrounds {
  dark: string;
  light: string;
}

export const ACCENT_PRESETS = {
  azure: { dark: '#3b9df7', light: '#1f7fd0' },
  violet: { dark: '#7c74ff', light: '#5b4fd6' },
  teal: { dark: '#17b8a6', light: '#0e8a7d' },
  orchid: { dark: '#db5bc4', light: '#b8339f' },
  emerald: { dark: '#2fbf87', light: '#0f9d68' },
  cyan: { dark: '#22c3d6', light: '#0e94a6' },
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
