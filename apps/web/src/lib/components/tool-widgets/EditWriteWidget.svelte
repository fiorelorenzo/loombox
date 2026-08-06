<script lang="ts">
  /**
   * The bespoke Edit/Write widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's Edit/Write and Codex's patch/diff all resolve here
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`) since they share
   * ACP v1's one `Diff` shape. Reuses `DiffViewer` verbatim - the same
   * component the working-tree diff viewer (§7.4) uses - rather than
   * re-rendering the diff itself.
   *
   * One level of card chrome (design spec `2026-08-03-cockpit-v6-design.md`
   * §3.4, issue #576): `DiffViewer` keeps its own raised, bordered card
   * unchanged — a diff earns its surface — so `ToolCard` renders `surface=
   * {false}` here rather than wrapping that in a second, redundant bordered
   * frame. The header row (icon, title, status, disclosure) stays plain
   * text directly above it. Status renders via the shared
   * `ToolCallStatus` (a failed edit is louder than a completed one; see
   * that component's own doc comment).
   *
   * Resting state and its one override (v7 decisions §3, issue #668):
   * C1-1 — a completed call rests collapsed to this header's single line
   * (title plus outcome); the diff body waits behind the disclosure. C2-1
   * — a failed call always renders its diff in full, disclosure locked
   * open (no button, just static text) so it cannot be collapsed by
   * accident — this overrides C1-1's resting default rather than
   * competing with it. A still-running call keeps the old always-open
   * behaviour. The body div is `hidden`, never `{#if}`-removed, so
   * `DiffViewer` still mounts and computes its line diff the instant this
   * widget renders regardless of collapsed state — a mid-stream/malformed
   * diff still throws into `ToolCallRow`'s error boundary exactly as
   * before, `hidden` only strips it from layout/paint (issue #139).
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the header draws the shared `tool-edit` glyph next to the title,
   * the same convention `BashWidget`/`TodoWidget` use.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
  import DiffViewer from '../DiffViewer.svelte';
  import ToolCallGutter from '../ToolCallGutter.svelte';
  import ToolCallMeta from '../ToolCallMeta.svelte';
  import ToolCallStatus from '../ToolCallStatus.svelte';
  import Icon from '../icons/Icon.svelte';
  import ToolCard from './ToolCard.svelte';

  interface Props {
    item: TranscriptToolCallItem;
    /** Opens this call's own diff `path` in the canvas tab strip (issue #737) — forwarded to `DiffViewer`'s own `onOpen`. Omitted renders no "Open" affordance on this card. */
    onOpenFile?: (path: string) => void;
  }

  const { item, onOpenFile }: Props = $props();
  // resolveToolWidgetKind only routes here when `diff` is present.
  const diff = $derived(item.diff!);

  // See the file doc comment's "Resting state and its one override" note.
  // Only the mount-time status matters here (a live status change never
  // auto-collapses/-expands an already-rendered row): `locked` picks up
  // `failed` reactively regardless.
  // svelte-ignore state_referenced_locally
  let expandedState = $state(item.status !== 'completed');
  const locked = $derived(item.status === 'failed');
  const expanded = $derived(locked || expandedState);
  function toggleExpanded() {
    if (locked) return;
    expandedState = !expandedState;
  }
</script>

<div class="edit-write-widget" data-testid="edit-write-widget">
  <ToolCallGutter icon="tool-edit" />
  {#snippet headerContent()}
    <span class="title font-mono">{item.title ?? 'Edit'}</span>
    <ToolCallMeta elapsedMs={item.elapsedMs} attributedCostUsd={item.attributedCostUsd} />
    <ToolCallStatus status={item.status} />
  {/snippet}
  <ToolCard surface={false}>
    {#if locked}
      <div class="row-header row-header-static" data-testid="row-header">
        {@render headerContent()}
      </div>
    {:else}
      <button
        type="button"
        class="row-header"
        onclick={toggleExpanded}
        aria-expanded={expanded}
        data-testid="row-header"
      >
        <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
        {@render headerContent()}
      </button>
    {/if}
    <div class="body" hidden={!expanded}>
      <DiffViewer
        path={diff.path}
        oldText={diff.oldText}
        newText={diff.newText}
        onOpen={onOpenFile ? () => onOpenFile(diff.path) : undefined}
      />
    </div>
  </ToolCard>
</div>

<style>
  .edit-write-widget {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .row-header:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-radius: var(--radius-sm);
  }

  /* `flex-shrink: 0` used to sit here too, but `Icon`'s own
     `.icon { flex-shrink: 0; }` scoped root rule already provides the
     identical value (issue #665's guard-test scan) — redundant dead CSS,
     dropped rather than kept. */
  :global(.disclosure-icon) {
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .row-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  /* C2-1 (issue #668): the locked/failed header renders as plain text,
     not a button — there is nothing to disclose, so no click affordance
     (and no misleading focus outline) should suggest otherwise. */
  .row-header-static {
    cursor: default;
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    margin-top: var(--space-xs);
    min-width: 0;
  }

  /* Below `--bp-mobile` the role column collapses, so this row stacks its
     `ToolCallGutter` caption above the card — see that component's own copy
     of this block, and `MessageItem`'s for the measurement. */
  @media (max-width: 479px) {
    .edit-write-widget {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
