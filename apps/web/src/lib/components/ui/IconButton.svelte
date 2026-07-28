<script lang="ts">
  /**
   * The icon-only button primitive (redesign brief `docs/design/redesign.md`
   * §4, issue #428): replaces the six near-identical `.inbox-toggle`/
   * `.target-status-toggle`/etc. rulesets `+page.svelte` currently
   * hand-rolls (call-site migration is a later, per-surface issue — this
   * ships the primitive plus a `/style-reference` proof-of-use only).
   *
   * 32px hit target on a fine pointer, 44px (`2.75rem`) under
   * `(pointer: coarse)` — the same touch-target convention `CopyButton`/
   * `PermissionCard` already use elsewhere in this package. `pressed`
   * drives `aria-pressed` for a real toggle control (e.g. a pinned-drawer
   * button, a rail item's active state) and switches to the accent-subtle
   * background + accent border the brief calls for; omit it entirely for a
   * plain, non-toggling icon action — no `aria-pressed` at all, per ARIA's
   * own guidance not to set it on a control that isn't really a toggle.
   *
   * Motion/focus mirror `Button`'s exactly: `tension-press` on `:active`,
   * a `--duration-fast` hover shift, `:focus-visible` always resolves to
   * `--color-focus-ring` (never accent).
   */
  import type { Snippet } from 'svelte';

  interface Props {
    /** Accessible name — required, since the button's only visible content is an icon. */
    label: string;
    type?: 'button' | 'submit';
    disabled?: boolean;
    /** Omit for a plain action button; set for a real toggle (drives `aria-pressed`). */
    pressed?: boolean;
    onclick?: (event: MouseEvent) => void;
    /** A small count/alert badge (e.g. Inbox's unread count, Nodes & Targets' unhealthy flag). */
    badge?: string | number;
    /** Additional class name(s) merged onto the root `<button>`. */
    class?: string;
    /**
     * Overrides the root `data-testid` (default `"ui-icon-button"`). Lets a
     * surface that already has a per-action test selector route through
     * this shared primitive without renaming its tests (issue #460,
     * follow-up to #454). Omitting it preserves today's exact value, so
     * every existing call site is untouched.
     */
    dataTestId?: string;
    /** The icon markup (inline SVG/glyph) — rendered `aria-hidden`, since `label` already carries the accessible name. */
    children: Snippet;
  }

  const {
    label,
    type = 'button',
    disabled = false,
    pressed,
    onclick,
    badge,
    class: className = '',
    dataTestId = 'ui-icon-button',
    children,
  }: Props = $props();
</script>

<button
  {type}
  class={`ui-icon-button ${className}`.trim()}
  class:ui-icon-button-pressed={pressed === true}
  {disabled}
  aria-label={label}
  title={label}
  aria-pressed={pressed}
  {onclick}
  data-testid={dataTestId}
>
  <span class="ui-icon-button-icon" aria-hidden="true">{@render children()}</span>
  {#if badge !== undefined}
    <span class="ui-icon-button-badge" data-testid="ui-icon-button-badge">{badge}</span>
  {/if}
</button>

<style>
  .ui-icon-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .ui-icon-button-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
  }

  .ui-icon-button:not(:disabled):hover {
    background: var(--color-fill-subtle);
  }

  /* tension-press (redesign brief §2). */
  .ui-icon-button:not(:disabled):active {
    transform: scale(0.98);
    background: var(--color-fill);
  }

  .ui-icon-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .ui-icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* aria-pressed=true — accent-subtle bg + accent border, per the brief. */
  .ui-icon-button-pressed {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .ui-icon-button-badge {
    position: absolute;
    top: -0.25rem;
    right: -0.25rem;
    min-width: 1rem;
    height: 1rem;
    padding: 0 var(--space-2xs);
    border-radius: var(--radius-full);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    font-size: var(--text-caption-size);
    font-weight: 700;
    line-height: 1rem;
    text-align: center;
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): the same 44px
     coarse-pointer convention `CopyButton`/`PermissionCard` already use. */
  @media (pointer: coarse) {
    .ui-icon-button {
      width: 2.75rem;
      height: 2.75rem;
    }
  }
</style>
