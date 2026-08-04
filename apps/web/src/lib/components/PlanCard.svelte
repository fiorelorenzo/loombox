<script lang="ts">
  /**
   * The inline plan render (SPEC.md §7.24 "Plans", issue #143). ACP replaces
   * the whole plan entry list on every `plan_update` — never diffed
   * client-side — so this component just renders `plan` wholesale, at the
   * point in the transcript it was emitted. Shimmers while the plan's still
   * being worked (any entry not yet `completed`) and settles once every
   * entry is `completed`; collapsible, remembering collapse state for the
   * session (the caller owns that state — see `collapsed`/`onToggle` — so a
   * "remembers during the session" store lives once, in the transcript view,
   * not duplicated per card). The persistent per-session sidebar view of the
   * same data is a separate v2 issue (§12); this is the inline card only.
   *
   * Warp Deck restyle (docs/design/redesign.md §3/§6, issue #432): adopts
   * the elevation ladder's "raised" tier by name (the brief's table lists
   * `PlanCard` directly). The shimmer keeps its existing `plan-shimmer`
   * testid and behavior but is hand-styled as a small `thread-draw` ring
   * (the same traveling-`stroke-dashoffset` technique `StatusDot` uses for
   * its `pulse` state) instead of a plain opacity blink, so an in-progress
   * plan reads as part of the same motion language as the rest of the app.
   * A single un-staggered `beat-in` plays once on mount (mirroring
   * `MessageItem`/`ToolCallRow`).
   *
   * Deck token pass (redesign v2 design spec §2, issue #468): the
   * in-progress step now gets the same accent-for-meaning left marker
   * `TodoWidget`'s in-progress entry already uses (`--color-accent`,
   * reserved for the one thing actually happening right now, never chrome)
   * instead of relying on font-weight alone, so the two checklist-shaped
   * widgets read as one consistent family.
   *
   * Redesign v3 (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md`
   * §3.4 "Canvas and transcript" — "keep the shape"): the card sits behind
   * a `.plan-gutter` spacer the same `var(--gutter)` width as every other
   * row's gutter, so its left edge lines up with the rest of the
   * timeline's content column instead of reading as a foreign card flush
   * against the canvas edge.
   *
   * Design spec v5 §4 "one card language for tool calls": the raised-tier
   * box the paragraph above once described is gone — a raised, shadowed
   * card next to `PermissionCard`'s own raised/bordered treatment made two
   * different surfaces look like the same kind of "this needs attention"
   * interrupt, when only `PermissionCard` actually is one. `.plan-card`
   * now carries the same flat, hairline-bordered `.tool-card` recipe
   * `GenericToolRow`/`tool-widgets/*` share (via their own `ToolCard`) —
   * inlined here rather than importing that component, since Plan's
   * header/entries/actions already own their own padding and wrapping
   * would double it up.
   */
  import type { AcpPlanEntry } from '@loombox/providers-core/browser';
  import CopyButton from './CopyButton.svelte';
  import StatusDot from './ui/StatusDot.svelte';

  interface Props {
    entries: AcpPlanEntry[];
    collapsed: boolean;
    onToggle: () => void;
  }

  const { entries, collapsed, onToggle }: Props = $props();

  const active = $derived(entries.some((entry) => entry.status !== 'completed'));
  const completedCount = $derived(entries.filter((entry) => entry.status === 'completed').length);
  const copyText = $derived(
    entries.map((entry) => `[${entry.status}] ${entry.content}`).join('\n'),
  );
</script>

<div class="plan-row">
  <div class="plan-gutter" aria-hidden="true"></div>
  <div class="plan-card tool-card" class:active data-testid="plan-card">
    <!-- The copy affordance sits in the header, not in a row of its own under
         the entries: `revealOnHover` means that row was invisible but still
         claimed its height, so the card always ended in a band of dead space.
         Header-right is also where every other transcript surface puts copy,
         so this is one pattern instead of two. -->
    <div class="plan-header-row">
      <button
        type="button"
        class="plan-header"
        onclick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand plan' : 'Collapse plan'}
      >
        <span class="chevron">{collapsed ? '▸' : '▾'}</span>
        <span class="title">Plan</span>
        <span class="progress">{completedCount}/{entries.length}</span>
        {#if active}
          <span class="shimmer" data-testid="plan-shimmer">
            <StatusDot tone="info" pulse label="Plan in progress" />
          </span>
        {/if}
      </button>
      <div class="plan-copy">
        <CopyButton text={copyText} label="Copy plan" revealOnHover />
      </div>
    </div>

    {#if !collapsed}
      <ol class="plan-entries">
        {#each entries as entry, index (index)}
          <li class={entry.status}>
            <span class="checkbox" aria-hidden="true"
              >{entry.status === 'completed' ? '☑' : '☐'}</span
            >
            <span class="content">{entry.content}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</div>

<style>
  /* Gutter alignment (redesign v3 design spec §3.4): a spacer the same
     width as every other row's role/kind glyph column, so the card's left
     edge lines up with the rest of the timeline's content instead of
     starting flush at the canvas edge. */
  .plan-row {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
  }

  .plan-gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
  }

  /* Flat tier (design spec v5 §4 "one card language"): the identical
     `background`/`border`/`border-radius` recipe `ToolCard` gives
     `GenericToolRow`/`tool-widgets/*`, inlined here since Plan's own
     header/entries/actions padding would double up under that shared
     wrapper (see the class-level doc comment). Deliberately no
     `box-shadow` — that weight is reserved for `PermissionCard` alone. */
  .tool-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
  }

  .plan-card {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-small-size);
    /* Single un-staggered beat-in (redesign brief §2), mount-once same as
       MessageItem/ToolCallRow. */
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .plan-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    text-align: left;
  }

  .title {
    font-weight: 600;
    flex: 1;
  }

  .progress {
    opacity: 0.6;
    font-size: var(--text-small-size);
  }

  .shimmer {
    display: inline-flex;
    flex-shrink: 0;
  }

  .plan-entries {
    list-style: none;
    margin: 0;
    padding: var(--space-xs) var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .plan-entries li {
    display: flex;
    gap: var(--space-xs);
    align-items: baseline;
  }

  .plan-entries li .checkbox {
    color: var(--color-text-muted);
  }

  .plan-entries li.completed .checkbox {
    color: var(--color-success);
  }

  .plan-entries li.completed .content {
    opacity: 0.55;
    text-decoration: line-through;
  }

  /* Accent-for-meaning, not chrome (matches TodoWidget's identical
     in-progress marker): the one entry actually in flight gets the accent
     as a left marker, everything else stays neutral text weight. */
  .plan-entries li.in_progress {
    position: relative;
    padding-left: var(--space-sm);
  }

  .plan-entries li.in_progress::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.2em;
    bottom: 0.2em;
    width: 2px;
    border-radius: var(--radius-full);
    background: var(--color-accent);
  }

  .plan-entries li.in_progress .content {
    font-weight: 600;
  }

  /* Header-right, overlaid on the toggle's own band rather than stacked in a
     reserved row - see the markup comment for why the old `.plan-actions` row
     had to go. */
  .plan-header-row {
    display: flex;
    align-items: center;
    background: var(--color-fill-subtle);
  }

  .plan-copy {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    padding-right: var(--space-sm);
  }

  /* Copy affordance reveals on card hover/focus-within (redesign v3 §3.4
     "Copy affordances"); see CopyButton.svelte's `revealOnHover` doc
     comment for why this lives here rather than in the shared button. */
  .plan-card:hover :global(.copy-button-reveal),
  .plan-card:focus-within :global(.copy-button-reveal) {
    opacity: 1;
  }

  /* Touch-optimized plan controls (SPEC.md §7.3, issue #133): the plan
     header (its only tap target — the individual entries below are a
     read-only, agent-driven checklist, not user-interactive in v1) grows to
     a larger hit target on a coarse (touch) pointer. */
  @media (pointer: coarse) {
    .plan-header {
      min-height: 2.75rem;
      padding: var(--space-md) var(--space-lg);
    }
  }

  /* Below `--bp-mobile` the whole role column collapses (see
     `MessageItem`'s own copy of this block). This one is a pure spacer, so
     collapsing it means dropping it: the card takes the full measure like
     every other row, instead of keeping a `var(--gutter)`-wide indent
     nothing lines up with any more. */
  @media (max-width: 479px) {
    .plan-gutter {
      display: none;
    }
  }
</style>
