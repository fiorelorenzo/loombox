<script lang="ts">
  /**
   * Shared gutter column for every tool-call row (`GenericToolRow` plus
   * every `tool-widgets/*` bespoke widget): the tool-kind glyph plus a
   * visible "Tool" role caption, so the same column that tells a
   * `MessageItem` row "You" from the provider's name also tells a tool
   * call apart from either (design spec v5 §4: "every turn states its
   * role" — `You` / the provider's name / `Tool`, never colour alone).
   * One component rather than four copies of the same markup+CSS, which
   * is what `GenericToolRow`/`BashWidget`/`EditWriteWidget`/`TodoWidget`
   * each hand-rolled before this pass.
   *
   * The specific kind (bash/edit/search/…) still reaches screen readers
   * through each caller's own visible title text (and `GenericToolRow`'s
   * extra `sr-only` kind label) — this column only ever says the one word
   * "Tool", mirroring `MessageItem`'s own gutter only ever saying "You" or
   * the provider's name. Kept `aria-hidden` as a whole, same as the
   * (decorative) icon it replaces: a screen reader gets the row's role
   * from the visible content already, not a duplicate announcement here.
   */
  import Icon from './icons/Icon.svelte';
  import type { IconName } from './icons/icon-paths';

  interface Props {
    /** Which glyph identifies the tool kind (`tool-bash` / `tool-edit` / `tool-generic`). */
    icon: IconName;
  }

  const { icon }: Props = $props();
</script>

<div class="tool-gutter" aria-hidden="true">
  <Icon name={icon} class="type-icon" />
  <span class="role-label">Tool</span>
</div>

<style>
  .tool-gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3xs);
    padding-top: var(--space-2xs);
    /* Same inner-edge alignment and reserved padding as `MessageItem`'s
       gutter, so the role column reads as one rule down the whole transcript
       rather than two columns that nearly line up. */
    padding-right: var(--space-sm);
    overflow: hidden;
  }

  :global(.type-icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  /* Same `--text-caption-size` uppercase treatment as MessageItem's own
     role label (design spec v5 §4) — one word, "Tool", every time. */
  .role-label {
    font-size: var(--text-caption-size);
    line-height: var(--text-caption-line);
    letter-spacing: var(--text-caption-tracking);
    font-weight: var(--text-caption-weight);
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
</style>
