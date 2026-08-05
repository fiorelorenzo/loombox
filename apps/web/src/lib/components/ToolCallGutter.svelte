<script lang="ts">
  /**
   * Shared gutter column for every tool-call row (`GenericToolRow` plus
   * every `tool-widgets/*` bespoke widget): just the tool-kind glyph now
   * (design spec `2026-08-03-cockpit-v6-design.md` §3.4, issue #575, point
   * 3: "tool rows keep their card and the TOOL word goes — the tool icon
   * already says it"). v5 §4 used to pair this glyph with a visible "Tool"
   * caption to match `MessageItem`'s own gutter word; that word is gone
   * from both now, replaced there by a glyph plus a `.sr-only` label. This
   * gutter never carried the accessible name in the first place — the
   * whole column has always been `aria-hidden` (see below) — so dropping
   * the word loses no accessible information; the specific kind
   * (bash/edit/search/…) still reaches screen readers through each
   * caller's own visible title text and `GenericToolRow`'s own `sr-only`
   * kind label. One component rather than four copies of the same
   * markup+CSS, which is what `GenericToolRow`/`BashWidget`/
   * `EditWriteWidget`/`TodoWidget` each hand-rolled before this pass.
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
</div>

<style>
  .tool-gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3xs);
    /* Optical nudge, issue #703: an SVG icon at `1em` sits flush to its own
       box top (no font leading), while the header text next to it carries
       real ascent metrics above its glyphs — so with zero top offset the
       icon reads noticeably higher than the command it names. This value
       is calibrated against the header text alone (measured on real
       `BashWidget`/`GenericToolRow` rows, both themes): `ToolCard`'s own
       `.tool-card-plain` used to carry a matching copy of this same
       padding "to align with the icon", which instead cancelled the nudge
       out (both sides sink together) and put the glyph visibly *below*
       the command line — see that rule's own comment for why it was
       removed rather than kept in sync.
    */
    padding-top: var(--space-sm);
    /* Same inner-edge alignment and reserved padding as `MessageItem`'s
       gutter, so the role column reads as one rule down the whole transcript
       rather than two columns that nearly line up. */
    padding-right: var(--space-sm);
    overflow: hidden;
  }

  /* `flex-shrink: 0` used to sit here too, but `Icon`'s own
     `.icon { flex-shrink: 0; }` scoped root rule already provides the
     identical value (issue #665's guard-test scan) — redundant dead CSS,
     dropped rather than kept. */
  :global(.type-icon) {
    color: var(--color-text-secondary);
  }

  /* Below `--bp-mobile` every other row sharing this column collapses too
     (see `MessageItem`'s own copy of this block for the measurement) — a
     flex child cannot turn its own parent, and they must all move together
     or the timeline's one rule becomes several that nearly line up. This
     component only ever holds the icon now, so the row/column switch below
     is purely for parity with those siblings' own layout, not because the
     icon alone needs to reflow. */
  @media (max-width: 479px) {
    .tool-gutter {
      flex: 0 0 auto;
      width: auto;
      flex-direction: row;
      align-items: center;
      gap: var(--space-2xs);
      padding-right: 0;
      padding-top: var(--space-xs);
    }
  }
</style>
