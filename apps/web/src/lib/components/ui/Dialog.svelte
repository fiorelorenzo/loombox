<script lang="ts">
  /**
   * The shared modal chrome (redesign brief `docs/design/redesign.md` §4,
   * issue #428): backdrop + `thread-lift` panel + header/body/footer slots
   * + Esc/backdrop-click/focus-trap, once, instead of the four hand-rolled
   * near-duplicates `CommandPalette`, `NewSessionDialog`, `AddTargetWizard`,
   * and `FileReferencePicker` each currently maintain. Call-site migration
   * onto this primitive is a later, per-surface issue; this ships the
   * primitive plus a `/style-reference` proof-of-use only.
   *
   * Elevation: the panel IS the `floating` tier (redesign brief §3) —
   * `--color-surface-raised` / `--color-border-strong` / `--shadow-lg`,
   * same tokens `Card`'s `elevation="floating"` maps to.
   *
   * `open` only controls whether the caller *wants* the dialog visible —
   * closing calls `onClose` (Esc, a backdrop click) and leaves the actual
   * `open` state to the caller, exactly like every existing hand-rolled
   * dialog in this package already works.
   *
   * Motion — `thread-lift` (redesign brief §2 table: "backdrop fades
   * independently at `--duration-fast`/`--ease-beat`; card `scale(0.97→1)`
   * + fade" at `--duration-base`/`--ease-tension`). This is the one
   * primitive in this library that reaches for Svelte's own `in:`/`out:`
   * transition directives rather than a plain CSS `transition`/`animation`
   * (every other primitive here stays CSS-only, letting `tokens.css`'s
   * single global `prefers-reduced-motion` rule handle them for free) —
   * Dialog specifically needs a *real* exit animation, and only Svelte's
   * transition engine can delay the panel's removal from the DOM until an
   * outro finishes. The duration/easing values below mirror
   * `--duration-base`/`--duration-fast`/`--ease-tension` and are kept in
   * sync with `tokens.css` by hand — the same manual-sync convention
   * `$lib/viewport.ts` already uses for its breakpoint numbers, for the
   * same reason (plain TS can't read a CSS custom property at this call
   * site). `reducedMotion` forces the static (durationless) fallback,
   * mirroring `WovenLoader`'s own explicit override for callers/tests
   * (jsdom doesn't evaluate `prefers-reduced-motion`); the automatic case
   * is covered by a live `matchMedia` read, the same convention
   * `$lib/theme.ts`/`$lib/accent.ts` already use for the same media query.
   */
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';

  export type DialogSize = 'sm' | 'md' | 'lg';

  interface Props {
    open: boolean;
    /** Accessible name for the `role="dialog"` panel. */
    label: string;
    onClose: () => void;
    /** Optional header region (title, search input, …) rendered above the body. */
    header?: Snippet;
    /** Body content. */
    children: Snippet;
    /** Optional footer region (typically action buttons) rendered below the body. */
    footer?: Snippet;
    size?: DialogSize;
    /** Forces the static reduced-motion fallback regardless of the media query — see the file doc comment. */
    reducedMotion?: boolean;
    /** Additional class name(s) merged onto the panel. */
    class?: string;
  }

  const {
    open,
    label,
    onClose,
    header,
    children,
    footer,
    size = 'md',
    reducedMotion = false,
    class: className = '',
  }: Props = $props();

  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let panelEl = $state<HTMLElement | undefined>(undefined);
  let previouslyFocused: HTMLElement | null = null;

  function focusableElements(): HTMLElement[] {
    if (!panelEl) return [];
    return Array.from(panelEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  // Focus-trap entry/exit (issue #428's acceptance: "a focus trap"): moves
  // focus into the panel's first focusable element the moment it opens,
  // and restores it to whatever had focus beforehand once it closes —
  // mirrors `CommandPalette`'s own `inputEl?.focus()` on open, generalized
  // to "the first focusable thing" since a generic Dialog has no fixed
  // input to target.
  $effect(() => {
    if (open) {
      previouslyFocused = document.activeElement as HTMLElement | null;
      const first = focusableElements()[0];
      (first ?? panelEl)?.focus();
    } else if (previouslyFocused) {
      previouslyFocused.focus();
      previouslyFocused = null;
    }
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function reduced(): boolean {
    return (
      reducedMotion ||
      (typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    );
  }

  function panelLift(_node: Element): TransitionConfig {
    const duration = reduced() ? 0 : 220; // tokens.css --duration-base
    return {
      duration,
      easing: cubicOut, // approximates --ease-tension's snap-then-ease for this JS-driven transition
      css: (t: number) => `opacity: ${t}; transform: scale(${0.97 + 0.03 * t});`,
    };
  }

  function backdropFade(_node: Element): TransitionConfig {
    const duration = reduced() ? 0 : 140; // tokens.css --duration-fast
    return { duration, easing: cubicOut, css: (t: number) => `opacity: ${t};` };
  }
</script>

{#if open}
  <div
    class="dialog-backdrop"
    role="presentation"
    onclick={onClose}
    in:backdropFade
    out:backdropFade
    data-testid="dialog-backdrop"
  >
    <div
      bind:this={panelEl}
      class={`dialog-panel dialog-panel-${size} ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={handleKeydown}
      in:panelLift
      out:panelLift
      data-testid="dialog"
    >
      {#if header}
        <div class="dialog-header">{@render header()}</div>
      {/if}
      <div class="dialog-body">{@render children()}</div>
      {#if footer}
        <div class="dialog-footer">{@render footer()}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: var(--color-overlay);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 6vh var(--space-md);
    overflow-y: auto;
    z-index: var(--z-modal);
  }

  .dialog-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    width: min(28rem, 100%);
    padding: var(--space-lg);
    border-radius: var(--radius-xl);
    /* floating tier (redesign brief §3) — same tokens as Card's elevation="floating". */
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border-strong);
    box-shadow: var(--shadow-lg);
    color: var(--color-text-primary);
  }

  .dialog-panel-sm {
    width: min(22rem, 100%);
  }

  .dialog-panel-md {
    width: min(28rem, 100%);
  }

  .dialog-panel-lg {
    width: min(40rem, 100%);
  }

  .dialog-panel:focus-visible {
    /* The focus trap always moves real focus onto a child control (or, as
       a last resort, the panel itself) — an outline on the panel shell
       would be a second, redundant focus indicator. */
    outline: none;
  }

  .dialog-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .dialog-header :global(h2) {
    margin: 0;
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    overflow-y: auto;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
  }
</style>
