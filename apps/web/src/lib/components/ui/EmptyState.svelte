<script lang="ts">
  /**
   * The shared empty/pre-select state (redesign brief
   * `docs/design/redesign.md` §4, issue #428): a dimmed `BrandMark` (14%
   * opacity, 4rem) + one-sentence explanation + an optional primary-action
   * slot — used identically for empty sessions, empty inbox, empty
   * targets, and the pre-select transcript pane (redesign brief §6, "adopt
   * `EmptyState`'s dimmed-`BrandMark` language"). Call-site migration is a
   * later, per-surface issue; this ships the primitive plus a
   * `/style-reference` proof-of-use only.
   *
   * `cta` is a snippet, not a fixed `ctaLabel`/`onCta` pair — the brief
   * calls it "one primary Button CTA slot", so the caller supplies its own
   * `<Button variant="primary">`, keeping this primitive decoupled from
   * `Button`'s own prop surface (and free to hold something other than a
   * button, on the rare surface that needs it).
   */
  import type { Snippet } from 'svelte';
  import BrandMark from '../BrandMark.svelte';

  interface Props {
    /** One-sentence explanation of what's empty and, where relevant, what to do next. */
    message: string;
    /** Optional primary-action slot, typically a `<Button variant="primary">`. */
    cta?: Snippet;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
  }

  const { message, cta, class: className = '' }: Props = $props();
</script>

<div class={`ui-empty-state ${className}`.trim()} data-testid="ui-empty-state">
  <BrandMark class="ui-empty-state-mark" />
  <p class="ui-empty-state-message">{message}</p>
  {#if cta}
    <div class="ui-empty-state-cta">{@render cta()}</div>
  {/if}
</div>

<style>
  .ui-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-md);
    padding: var(--space-2xl);
  }

  /* BrandMark's `class` prop lands on an element inside BrandMark's own
     component scope, not this one — `:global()` under a local ancestor
     class is the standard, narrowly-scoped way to reach it (as opposed to
     an unscoped `:global(.ui-empty-state-mark)`, which would leak). */
  .ui-empty-state :global(.ui-empty-state-mark) {
    width: 4rem;
    height: 4rem;
    opacity: 0.14;
    color: var(--color-text-primary);
  }

  .ui-empty-state-message {
    max-width: 28rem;
    margin: 0;
    color: var(--color-text-secondary);
  }

  .ui-empty-state-cta {
    margin-top: var(--space-2xs);
  }
</style>
