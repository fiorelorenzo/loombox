<script lang="ts">
  /**
   * The tool-call dispatcher (SPEC.md §7.24 "Tool calls, two tiers in v1";
   * issues #139/#140): picks the bespoke widget for the handful of tools
   * worth custom rendering, falling back to the generic `ToolKind`-driven
   * row for everything else — and never both at once, including mid-stream
   * before the bespoke widget's first paint (issue #140's acceptance),
   * since `resolveToolWidgetKind` is a single synchronous decision made
   * once per render from the item's current fields, not a two-step
   * "try bespoke, then also render generic" pipeline.
   *
   * Each bespoke widget is wrapped in its own `<svelte:boundary>` (native
   * Svelte 5 error boundary) so a widget that throws while rendering falls
   * back to the generic row instead of taking down the rest of the
   * transcript (issue #139's acceptance, tested by forcing a throw).
   *
   * Warp Deck restyle (`docs/design/redesign.md` §6, issue #432): this row
   * is a thin dispatcher, not its own card. Redesign v3
   * (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md` §3.4 "One
   * tool-call anatomy"): the gutter-plus-content row anatomy lives on
   * whichever child actually renders (`GenericToolRow` / the bespoke
   * widgets), so this wrapper stays unboxed and only adds two things at
   * the row level: a single un-staggered `beat-in` on mount (same
   * mount-once CSS-`animation` technique as `MessageItem`), and a
   * one-time `thread-draw` top-edge pulse (accent fading to neutral,
   * `--duration-weave`, never looping — distinct from `StatusDot`'s
   * continuous `working` weave) the instant a streaming tool call settles
   * into `completed`.
   */
  import { untrack } from 'svelte';
  import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
  import { resolveToolWidgetKind } from '$lib/tool-widgets';
  import EditWriteWidget from './tool-widgets/EditWriteWidget.svelte';
  import BashWidget from './tool-widgets/BashWidget.svelte';
  import TodoWidget from './tool-widgets/TodoWidget.svelte';
  import GenericToolRow from './GenericToolRow.svelte';

  interface Props {
    item: TranscriptToolCallItem;
    /** True while this tool call's own permission request is the actionable FIFO head (SPEC.md §7.24 nested-visibility hook, issue #146). */
    awaitingPermission?: boolean;
    /** Opens a file in the canvas tab strip (issue #737) — forwarded to `EditWriteWidget`'s own `onOpenFile`. Omitted renders no "Open" affordance on any edit/write card this row mounts. */
    onOpenFile?: (path: string) => void;
  }

  const { item, awaitingPermission = false, onOpenFile }: Props = $props();
  const widgetKind = $derived(resolveToolWidgetKind(item));
  // A bespoke widget that throws falls back to the generic row for this
  // render (`bespokeFailed`); tracked by item id so a fresh item id (a new
  // tool call) always gets a clean attempt at its own bespoke widget.
  let bespokeFailedFor = $state<string | undefined>(undefined);

  // The one-time "done" pulse (redesign brief §2/§6): fires only on a
  // genuine in-flight -> completed transition, never on first paint of an
  // already-completed (replayed history) item. `previousStatus` is a plain,
  // non-reactive local (mirroring `MessageItem`'s `mountedAt` pattern), so
  // it survives re-renders of this same instance without itself
  // retriggering the effect.
  let previousStatus = untrack(() => item.status);
  let settling = $state(false);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const current = item.status;
    if (
      current === 'completed' &&
      previousStatus !== undefined &&
      previousStatus !== 'completed' &&
      previousStatus !== 'failed'
    ) {
      settling = true;
      clearTimeout(settleTimer);
      // --duration-weave (640ms) for the sweep to fully draw, plus
      // --duration-fast (140ms) for the accent -> neutral crossfade that
      // follows it, matching tokens.css's own values.
      settleTimer = setTimeout(() => {
        settling = false;
      }, 780);
    }
    previousStatus = current;
  });

  $effect(() => () => clearTimeout(settleTimer));
</script>

<div
  class="tool-call-row"
  class:awaiting-permission={awaitingPermission}
  data-testid="tool-call-row"
>
  <span
    class="settle-pulse thread-draw-fill"
    class:settle-pulse-active={settling}
    aria-hidden="true"
  ></span>
  {#if widgetKind !== 'generic' && bespokeFailedFor !== item.id}
    <svelte:boundary onerror={() => (bespokeFailedFor = item.id)}>
      {#if widgetKind === 'edit-write'}
        <EditWriteWidget {item} {onOpenFile} />
      {:else if widgetKind === 'bash'}
        <BashWidget {item} />
      {:else if widgetKind === 'todo'}
        <TodoWidget {item} />
      {/if}
      {#snippet failed()}
        <GenericToolRow {item} />
      {/snippet}
    </svelte:boundary>
  {:else}
    <GenericToolRow {item} />
  {/if}
</div>

<style>
  .tool-call-row {
    position: relative;
    /* Single un-staggered beat-in (redesign brief §2): plays once when
       this instance first mounts into the keyed transcript list, never
       again on the in-place updates a streaming tool call receives. */
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

  .tool-call-row.awaiting-permission {
    outline: 2px solid var(--color-warning);
    outline-offset: 2px;
    border-radius: var(--radius-lg);
  }

  /* thread-draw settle pulse (redesign brief §2 table): a thin top-edge
     sweep, accent fading to neutral, drawn once via the shared
     `.thread-draw-fill` utility (`$lib/styles/motion.css`) rather than a
     bespoke sweep implementation. */
  .settle-pulse {
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--color-accent);
    pointer-events: none;
    opacity: 0;
  }

  .settle-pulse-active {
    opacity: 1;
    --thread-draw-progress: 100%;
    transition:
      clip-path var(--duration-weave) var(--ease-tension),
      background-color var(--duration-fast) var(--ease-beat) var(--duration-weave);
    background: var(--color-border-strong);
  }
</style>
