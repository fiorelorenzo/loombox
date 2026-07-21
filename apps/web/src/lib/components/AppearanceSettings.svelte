<script lang="ts">
  /**
   * The appearance settings panel (issues #195/#376's settings surface):
   * theme preference (system/dark/light — the header's own toggle already
   * cycles dark/light; this surfaces all three as explicit, individually
   * selectable choices) plus the accent preset/custom picker. A plain form
   * over `$lib/theme.ts`/`$lib/accent.ts`'s stores — this component owns no
   * theming logic itself, only reads/writes the two module-level singleton
   * stores directly (unlike `NotificationPreferences.svelte`'s injectable-
   * storage pattern, there is exactly one `themeStore`/`accentStore`
   * instance app-wide, the same ones the header's own theme toggle already
   * talks to). Selecting anything applies live (both stores apply to the
   * DOM synchronously on every `set*` call) and persists to localStorage.
   */
  import { accentStore, isValidAccentHex } from '$lib/accent';
  import { ACCENT_PRESET_KEYS, ACCENT_PRESET_LABELS, ACCENT_PRESETS } from '$lib/accent-presets';
  import { themeStore, type ThemePreference } from '$lib/theme';

  const accentSelection = accentStore.selection;
  const themePreference = themeStore.preference;

  const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
  ];

  // Seeded from whatever's already selected so the color input never shows
  // a bare placeholder swatch; only actually applied once the user edits it
  // (`onCustomHexInput` below), so merely opening this panel never
  // overwrites a preset selection with an unrelated custom one.
  let customHex = $state(
    $accentSelection.type === 'custom' ? $accentSelection.hex : ACCENT_PRESETS.azure.dark,
  );

  function onCustomHexInput(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    customHex = value;
    if (isValidAccentHex(value)) accentStore.setCustom(value);
  }
</script>

<div class="appearance-settings" data-testid="appearance-settings">
  <section class="theme-section">
    <h3>Theme</h3>
    <div class="theme-options" role="radiogroup" aria-label="Theme">
      {#each THEME_OPTIONS as option (option.value)}
        <button
          type="button"
          class="theme-option"
          class:selected={$themePreference === option.value}
          aria-pressed={$themePreference === option.value}
          onclick={() => themeStore.setTheme(option.value)}
          data-testid={`theme-option-${option.value}`}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </section>

  <section class="accent-section">
    <h3>Accent</h3>
    <div class="accent-swatches" role="radiogroup" aria-label="Accent preset">
      {#each ACCENT_PRESET_KEYS as key (key)}
        <button
          type="button"
          class="accent-swatch"
          class:selected={$accentSelection.type === 'preset' && $accentSelection.key === key}
          aria-pressed={$accentSelection.type === 'preset' && $accentSelection.key === key}
          style={`background: ${ACCENT_PRESETS[key].dark};`}
          onclick={() => accentStore.setPreset(key)}
          data-testid={`accent-preset-${key}`}
          title={ACCENT_PRESET_LABELS[key]}
        >
          <span class="sr-only">{ACCENT_PRESET_LABELS[key]}</span>
        </button>
      {/each}
    </div>

    <label class="custom-accent" class:selected={$accentSelection.type === 'custom'}>
      <input
        type="color"
        value={customHex}
        oninput={onCustomHexInput}
        data-testid="custom-accent-input"
        aria-label="Custom accent color"
      />
      Custom
    </label>
  </section>
</div>

<style>
  .appearance-settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
    font-size: var(--text-small-size);
  }

  .theme-section,
  .accent-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  h3 {
    margin: 0;
    font-size: 0.8rem;
    opacity: 0.7;
    font-weight: 600;
  }

  .theme-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2xs);
  }

  .theme-option {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    font: inherit;
  }

  .theme-option.selected {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .accent-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
  }

  .accent-swatch {
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-full);
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    /* An outline (not a border-color swap) marks selection, so every
       swatch's own hue stays true to the actual preset color. */
    outline: 2px solid transparent;
    outline-offset: 2px;
  }

  .accent-swatch.selected {
    outline-color: var(--color-text-primary);
  }

  .custom-accent {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    width: fit-content;
    cursor: pointer;
    padding: var(--space-2xs) var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .custom-accent.selected {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .custom-accent input[type='color'] {
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    cursor: pointer;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133), same breakpoint
     `NotificationPreferences.svelte` uses. */
  @media (pointer: coarse) {
    .theme-option,
    .custom-accent {
      min-height: 2.75rem;
    }

    .accent-swatch {
      width: 2.5rem;
      height: 2.5rem;
    }
  }
</style>
