<script lang="ts">
  /**
   * The appearance settings panel (issues #195/#376's settings surface):
   * theme preference (system/dark/light — the header's own toggle already
   * cycles dark/light; this surfaces all three as explicit, individually
   * selectable choices) and the accent preset/custom picker. A plain form
   * over `$lib/theme.ts`/`$lib/accent.ts`'s stores — this component owns
   * no theming logic itself, only reads/writes the two module-level
   * singleton stores directly (unlike `NotificationPreferences.svelte`'s
   * injectable-storage pattern, there is exactly one `themeStore`/
   * `accentStore` instance app-wide, the same ones the header's own theme
   * toggle already talks to). Selecting anything applies live (every store
   * applies to the DOM synchronously on every `set*` call) and persists to
   * localStorage.
   *
   * The Style picker (Deck/Loom/Studio) that used to sit above Theme is
   * gone (redesign v3 design spec §3.7, issue #502): the audit found the
   * three "Styles" only ever differed by hue, never density or shape, so
   * they were cut to the one palette rather than shipped as dead options —
   * see `$lib/styles/deck.css`'s doc comment.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§6,
   * issue #434): grouped onto `Card elevation="raised"` (the tier the
   * brief's elevation table assigns to config cards), with the theme/
   * accent pickers made tactile (hover lift, a settle-in "beat" on
   * selection). The theme option `<button>`s keep their exact
   * `data-testid`/`aria-pressed` contract from before this restyle —
   * intentionally NOT swapped for the shared `Button` primitive: its
   * per-option testids are load-bearing for this panel's tests, and while
   * `Button`/`IconButton` gained an overridable `dataTestId` since (issue
   * #460), they're still hand-styled here to the same visual language
   * (radius, transitions, `--color-focus-ring` focus, `tension-press` on
   * `:active`) so the result reads as the same system without a rename.
   * The accent swatches (redesign v3 issue #502 re-check) stay purpose-
   * built for the same `dataTestId` reason, plus one `Button`/`IconButton`
   * genuinely can't absorb: each swatch's fill IS a specific preset hex, a
   * per-instance dynamic value neither primitive's fixed prop surface
   * accepts, and duplicating `$lib/accent-presets.ts`'s hex table into
   * this file's CSS would trade one bypass for a worse one (a second,
   * driftable copy of the preset colors). They still draw from the exact
   * same tokens (`--radius-full`, `--color-focus-ring`, `--duration-fast`/
   * `--ease-beat`/`--ease-shuttle`) `IconButton` itself uses, and the fill
   * is set via Svelte's `style:` property binding, not a string-templated
   * `style` attribute.
   */
  import { accentStore, isValidAccentHex } from '$lib/accent';
  import { ACCENT_PRESET_KEYS, ACCENT_PRESET_LABELS, ACCENT_PRESETS } from '$lib/accent-presets';
  import { themeStore, type ThemePreference } from '$lib/theme';
  import Card from './ui/Card.svelte';

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
  <Card elevation="raised" padding="md" class="settings-card">
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
            <span class="theme-option-icon" aria-hidden="true">
              {#if option.value === 'system'}
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="2.5" y="4" width="15" height="10" rx="1.5" />
                  <path d="M7 17.5h6M10 14v3.5" stroke-linecap="round" />
                </svg>
              {:else if option.value === 'dark'}
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path
                    d="M17 11.4A7 7 0 1 1 8.6 3 5.6 5.6 0 0 0 17 11.4Z"
                    stroke-linejoin="round"
                  />
                </svg>
              {:else}
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="10" cy="10" r="3.5" />
                  <path
                    d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7"
                    stroke-linecap="round"
                  />
                </svg>
              {/if}
            </span>
            {option.label}
          </button>
        {/each}
      </div>
    </section>
  </Card>

  <Card elevation="raised" padding="md" class="settings-card">
    <section class="accent-section">
      <h3>Accent</h3>
      <div class="accent-swatches" role="radiogroup" aria-label="Accent preset">
        {#each ACCENT_PRESET_KEYS as key (key)}
          {@const isSelected = $accentSelection.type === 'preset' && $accentSelection.key === key}
          <button
            type="button"
            class="accent-swatch"
            class:selected={isSelected}
            aria-pressed={isSelected}
            style:background={ACCENT_PRESETS[key].dark}
            onclick={() => accentStore.setPreset(key)}
            data-testid={`accent-preset-${key}`}
            title={ACCENT_PRESET_LABELS[key]}
          >
            {#if isSelected}
              <svg
                class="accent-swatch-check"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                aria-hidden="true"
              >
                <path d="M5 10.5 8.5 14 15 6.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
            <span class="sr-only">{ACCENT_PRESET_LABELS[key]}</span>
          </button>
        {/each}
      </div>

      <label class="custom-accent" class:selected={$accentSelection.type === 'custom'}>
        <span class="custom-accent-swatch">
          <input
            type="color"
            value={customHex}
            oninput={onCustomHexInput}
            data-testid="custom-accent-input"
            aria-label="Custom accent color"
          />
        </span>
        Custom
      </label>
    </section>
  </Card>
</div>

<style>
  .appearance-settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    font-size: var(--text-small-size);
  }

  .theme-section,
  .accent-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  h3 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    line-height: var(--text-caption-line);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  .theme-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2xs);
  }

  .theme-option {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-secondary);
    padding: var(--space-2xs) var(--space-md);
    cursor: pointer;
    font: inherit;
    font-weight: 500;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat),
      color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .theme-option-icon {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
  }

  .theme-option-icon svg {
    width: 100%;
    height: 100%;
  }

  .theme-option:hover {
    border-color: var(--color-border-strong);
    background: var(--color-fill-subtle);
  }

  .theme-option:active {
    transform: scale(0.98);
  }

  .theme-option:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
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
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-full);
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    color: var(--color-accent-contrast);
    /* An outline (not a border-color swap) marks selection, so every
       swatch's own hue stays true to the actual preset color. */
    outline: 2px solid transparent;
    outline-offset: 2px;
    transition:
      outline-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-fast) var(--ease-shuttle);
  }

  .accent-swatch:hover {
    transform: scale(1.08);
  }

  .accent-swatch:active {
    transform: scale(0.96);
  }

  .accent-swatch:focus-visible {
    outline-color: var(--color-focus-ring);
  }

  .accent-swatch.selected {
    outline-color: var(--color-text-primary);
    transform: scale(1.04);
  }

  .accent-swatch-check {
    width: 1.1rem;
    height: 1.1rem;
    filter: drop-shadow(0 1px 1px rgb(0 0 0 / 35%));
  }

  .custom-accent {
    display: inline-flex;
    align-items: center;
    gap: var(--space-sm);
    width: fit-content;
    cursor: pointer;
    padding: var(--space-2xs) var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    transition:
      border-color var(--duration-fast) var(--ease-beat),
      color var(--duration-fast) var(--ease-beat);
  }

  .custom-accent:hover {
    border-color: var(--color-border-strong);
  }

  .custom-accent.selected {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .custom-accent-swatch {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--color-border);
  }

  .custom-accent input[type='color'] {
    width: 100%;
    height: 100%;
    padding: 0;
    border: none;
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
      width: 2.75rem;
      height: 2.75rem;
    }
  }
</style>
