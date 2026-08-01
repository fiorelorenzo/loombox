<script lang="ts">
  /**
   * The shared button primitive (redesign brief `docs/design/redesign.md`
   * §4 "Component treatment", issue #428): `primary` (solid accent fill),
   * `secondary` (1px `border-strong`, transparent), `ghost` (text-only,
   * underline on hover), and `danger` (danger border/text) — every button
   * in the app should compose this rather than hand-rolling its own
   * border/radius/background rules, the copy-pasted-CSS gap the brief
   * calls out as P1/#7/#8. Call-site migration is a later, per-surface
   * issue; this ships the primitive plus a `/style-reference` proof-of-use.
   *
   * Motion: `tension-press` on `:active` (background darkens, `scale(0.98)`,
   * `--duration-instant`/`--ease-beat`, no bounce/overshoot per the brief),
   * a `--duration-fast`/`--ease-beat` hover shift, and `:focus-visible`
   * always resolves to `--color-focus-ring` (a hairline border), never the
   * accent color — accent stays reserved for meaning, not chrome, the same
   * discipline `tokens.css` documents for its own focus-ring token. Every
   * transition is written as `<prop> var(--duration-*) var(--ease-*)`, so
   * `prefers-reduced-motion` (which zeroes every `--duration-*` custom
   * property globally, see `tokens.css`) collapses them to instant for
   * free — no per-component reduced-motion branch needed here.
   *
   * `children` is a Svelte 5 snippet, not a fixed string prop like most of
   * this package's existing components (`CopyButton`'s `text`/`label`,
   * `TurnStopControl`'s hardcoded "Stop") — unlike those single-purpose
   * components, a shared `Button` has to host arbitrary content (plain text
   * today, an icon-plus-label once the brief's §5 icon system lands), so it
   * needs the fully generic slot. Plain nested content (`<Button>Retry</Button>`)
   * is all a caller needs to write; Svelte compiles that into the
   * `children` snippet automatically.
   *
   * `pressed` opts a button into being a real toggle: it sets `aria-pressed`
   * and switches to the accent-subtle background + accent border, exactly
   * as `IconButton`'s own `pressed` already does. Added for the topbar's
   * three-way panel switch (Files/Terminal/Config), where the selected
   * segment has to be selected in the accessibility tree and not merely
   * tinted — a segmented control whose state lives only in a background
   * colour tells a screen reader nothing. Omit it entirely for a plain
   * action, per ARIA's guidance not to set `aria-pressed` on a control that
   * isn't a toggle. `title` is the matching hover tooltip, for the widths
   * where such a control hides its own visible word.
   */
  import type { Snippet } from 'svelte';
  import WovenLoader from '../WovenLoader.svelte';

  export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
  export type ButtonSize = 'sm' | 'md';

  interface Props {
    variant?: ButtonVariant;
    size?: ButtonSize;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    /** Shows the inline `WovenLoader` and disables interaction — for an in-flight async action (mirrors `NewSessionDialog`'s existing submit-button loading pattern, issue #274). */
    loading?: boolean;
    fullWidth?: boolean;
    onclick?: (event: MouseEvent) => void;
    /** Accessible-name override — only needed when `children` isn't plain readable text (e.g. an icon-plus-label pairing where the icon stays `aria-hidden`). */
    ariaLabel?: string;
    /** Omit for a plain action; set for a real toggle (drives `aria-pressed` and the pressed treatment). */
    pressed?: boolean;
    /** Native hover tooltip — pair it with `ariaLabel` on a control whose visible label is hidden at some widths. */
    title?: string;
    /** Additional class name(s) merged onto the root `<button>`. */
    class?: string;
    /**
     * Overrides the root `data-testid` (default `"ui-button"`). Lets a
     * surface that already has a per-option/per-action test selector (e.g.
     * `AppearanceSettings`, `TargetStatusView`) route through this shared
     * primitive without renaming its tests (issue #460, follow-up to #454).
     * Omitting it preserves today's exact value, so every existing call
     * site is untouched.
     */
    dataTestId?: string;
    children: Snippet;
  }

  const {
    variant = 'primary',
    size = 'md',
    type = 'button',
    disabled = false,
    loading = false,
    fullWidth = false,
    onclick,
    ariaLabel,
    pressed,
    title,
    class: className = '',
    dataTestId = 'ui-button',
    children,
  }: Props = $props();

  const isDisabled = $derived(disabled || loading);
</script>

<button
  {type}
  class={`ui-button ui-button-${variant} ui-button-${size} ${className}`.trim()}
  class:ui-button-full={fullWidth}
  class:ui-button-pressed={pressed === true}
  disabled={isDisabled}
  aria-busy={loading || undefined}
  aria-label={ariaLabel}
  aria-pressed={pressed}
  {title}
  {onclick}
  data-testid={dataTestId}
  data-variant={variant}
  data-size={size}
>
  {#if loading}
    <!-- `tone="inherit"` so the weave paints in the label's colour: the loader's
         accent default is this button's own background on `primary`, which made
         a busy state that measured correct and showed nothing. -->
    <WovenLoader size="sm" tone="inherit" label="Working" />
  {/if}
  <span class="ui-button-label">{@render children()}</span>
</button>

<style>
  .ui-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-xs);
    border-radius: var(--radius-md);
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat),
      color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .ui-button-label {
    display: inline-flex;
    align-items: center;
  }

  .ui-button-md {
    padding: var(--space-sm) var(--space-lg);
    font-size: var(--text-body-size);
  }

  .ui-button-sm {
    padding: var(--space-2xs) var(--space-md);
    font-size: var(--text-small-size);
  }

  .ui-button-full {
    width: 100%;
  }

  /* tension-press (redesign brief §2): darken + scale(0.98) on press, no
     bounce/overshoot — bounce is reserved for nothing in this product. */
  .ui-button:not(:disabled):active {
    transform: scale(0.98);
  }

  .ui-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .ui-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /* primary — solid accent fill, accent-contrast text. */
  .ui-button-primary {
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .ui-button-primary:not(:disabled):hover {
    background: var(--color-accent-hover);
  }

  .ui-button-primary:not(:disabled):active {
    background: var(--color-accent-active);
  }

  /* secondary — 1px border-strong, transparent fill. */
  .ui-button-secondary {
    background: transparent;
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  .ui-button-secondary:not(:disabled):hover {
    background: var(--color-fill-subtle);
  }

  .ui-button-secondary:not(:disabled):active {
    background: var(--color-fill);
  }

  /* ghost — text-only, underline on hover, never a background. */
  .ui-button-ghost {
    background: transparent;
    color: var(--color-text-primary);
  }

  .ui-button-ghost:not(:disabled):hover {
    text-decoration: underline;
  }

  /* danger — danger border/text. */
  .ui-button-danger {
    background: transparent;
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .ui-button-danger:not(:disabled):hover,
  .ui-button-danger:not(:disabled):active {
    background: var(--color-danger-subtle);
  }

  /* aria-pressed=true — the same accent-subtle fill + accent border
     `IconButton` uses for a pressed toggle, so the two primitives read
     identically when a surface mixes them. */
  .ui-button-pressed {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133), the same
     coarse-pointer convention `CopyButton`/`PermissionCard` already use. */
  @media (pointer: coarse) {
    .ui-button-md {
      min-height: 2.75rem;
    }

    .ui-button-sm {
      min-height: 2.5rem;
    }
  }
</style>
