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
    /** Which glyph identifies the tool kind — see `$lib/tool-widgets.ts`'s `toolKindIcon` for the full `ToolKind -> IconName` mapping (issue #744). */
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
    /* Metric-independent alignment, issue #703 (v2 of this fix — see the
       PR discussion). A hand-tuned `padding-top` only ever matches ONE
       font/size combination, and this column serves several:
       `BashWidget`'s command is monospace at the ambient body size,
       `GenericToolRow`/`TodoWidget`'s title is UI-sans at
       `--text-small-size`, `EditWriteWidget`'s title is UI-sans too. Every
       one of those, plus this gutter, inherits the SAME `line-height` from
       `html` (`typography.css` sets it as an absolute `rem` value, not
       relative to local `font-size`, so it does not re-scale per
       consumer) — which is exactly what the `1lh` unit reads back on this
       element. Reserving one line's worth of height and centering the
       icon in it lines the icon's center up with the header text's own
       line-box center for whichever font/size that text happens to use,
       rather than a padding value tuned against one of them and left
       approximate for the rest.

       This still isn't pixel-perfect for every consumer — a real font's
       ink sits asymmetrically within its line box (ascent usually outweighs
       descent), so centering on the box itself leaves a small, consistent
       residual rather than zero (measured 0-4px across every
       `ToolCallGutter` consumer, both themes, in `tests-e2e/tool-call-
       gutter-alignment.spec.ts`) — but that residual now comes from real
       font metrics, not from a constant someone eyeballed against one row
       and left the rest to drift on.

       `lh`: Chromium 109+/Safari 16.4+, both comfortably below this app's
       floor (Electron 43 ships Chromium 130+; the PWA targets evergreen
       browsers). */
    min-height: 1lh;
    justify-content: center;
    gap: var(--space-3xs);
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
