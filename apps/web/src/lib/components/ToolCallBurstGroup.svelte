<script lang="ts">
  /**
   * The tier-3 tool-call burst/group summary card (issue #202; SPEC.md
   * §7.24's own tier-3 bullet). `$lib/transcript/tool-call-bursts.ts`
   * decides WHICH calls belong to a group and when — this component only
   * renders the one it's handed: a single collapsed line (count, a
   * succeeded/failed/running breakdown, total elapsed time, one loudest-
   * status `StatusDot`) until expanded, at which point every real call
   * mounts through `ToolCallRow` — the exact same tier-1/2 dispatcher a
   * top-level, ungrouped call would use, no special-casing (this ticket's
   * own acceptance bullet).
   *
   * Default collapsed, same as design review `docs/design/
   * ux-review-2026-08-04/section-c-toolcalls.html` §C3's C3-3 mock: the
   * summary line's own status dot/failed-count is enough to flag a run
   * that needs attention without forcing the reader through the whole
   * expanded log. `hasAwaitingPermission` below is the one thing that
   * overrides that default — a pending permission request buried inside a
   * collapsed group would otherwise sit outside the FIFO queue's own
   * "always reachable" contract, so this locks the card open (mirrors
   * `GenericToolRow`'s own C2-1 "failed call locks open, no toggle"
   * pattern) whenever `awaitingPermissionId` names one of `calls`.
   * `forceExpandItemId` is the weaker, dismissable cousin: a
   * `TranscriptJumpTarget` (issue #740's "jump to this file's diff", or
   * #262/#263's off-window search match) landing on a call inside this
   * group opens it so that call's own row actually mounts — `data-item-id`
   * on each expanded row below is what lets `TranscriptTimeline.svelte`'s
   * `jumpItemEl` find it afterward — but unlike the permission case, the
   * reader can still collapse it back by hand.
   */
  import { formatToolCallElapsed } from '$lib/tool-widgets';
  import type { ToolCallBurstGroupItem } from '$lib/transcript/tool-call-bursts';
  import Icon from './icons/Icon.svelte';
  import ToolCallGutter from './ToolCallGutter.svelte';
  import ToolCallRow from './ToolCallRow.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import ToolCard from './tool-widgets/ToolCard.svelte';

  interface Props {
    group: ToolCallBurstGroupItem;
    /** The permission FIFO queue's actionable head call id, if any — see the file doc comment's "hasAwaitingPermission" note. */
    awaitingPermissionId: string | undefined;
    /** A `TranscriptJumpTarget`/search-match id, if any — see the file doc comment's "forceExpandItemId" note. */
    forceExpandItemId: string | undefined;
    onOpenFile?: (path: string) => void;
  }

  const { group, awaitingPermissionId, forceExpandItemId, onOpenFile }: Props = $props();

  const hasAwaitingPermission = $derived(
    awaitingPermissionId !== undefined &&
      group.calls.some((call) => call.id === awaitingPermissionId),
  );
  const hasForcedTarget = $derived(
    forceExpandItemId !== undefined && group.calls.some((call) => call.id === forceExpandItemId),
  );

  let expandedState = $state(false);
  const expanded = $derived(hasAwaitingPermission || hasForcedTarget || expandedState);
  function toggle(): void {
    if (hasAwaitingPermission) return;
    expandedState = !expandedState;
  }

  const succeeded = $derived(group.calls.filter((call) => call.status === 'completed').length);
  const failed = $derived(group.calls.filter((call) => call.status === 'failed').length);
  const running = $derived(group.calls.filter((call) => call.status === 'in_progress').length);
  const stillPending = $derived(group.calls.filter((call) => call.status === 'pending').length);
  const stillActive = $derived(running > 0 || stillPending > 0);

  const tone = $derived<StatusTone>(failed > 0 ? 'danger' : stillActive ? 'info' : 'success');
  const titleText = $derived(
    `${group.calls.length} tool call${group.calls.length === 1 ? '' : 's'}`,
  );

  /** Every non-zero status bucket, joined for the summary line — a bucket at zero is noise, not signal (mirrors `ToolCallStatus.svelte`'s own "never announce a status nobody needs" discipline). A call whose own `status` never arrived (no `AcpToolCallUpdate` seen yet) contributes to none of these, same as `ToolCallStatus` itself renders nothing for an `undefined` status — never a fabricated bucket. */
  const statsText = $derived(
    [
      succeeded > 0 ? `${succeeded} succeeded` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
      running > 0 ? `${running} running` : undefined,
      stillPending > 0 ? `${stillPending} pending` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(', '),
  );

  /** Sum of every member's own `elapsedMs`, honestly partial (see `TranscriptToolCallItem.elapsedMs`'s own doc comment: a call whose start this client never observed leaves it `undefined`) — `undefined` only when NONE of the group's calls have a known duration, never a fabricated `0`. */
  const totalElapsedMs = $derived.by(() => {
    const known = group.calls
      .map((call) => call.elapsedMs)
      .filter((value): value is number => value !== undefined);
    return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : undefined;
  });
  const elapsedLabel = $derived(
    totalElapsedMs !== undefined ? formatToolCallElapsed(totalElapsedMs) : undefined,
  );
</script>

{#snippet summaryContent()}
  <Icon name="chevron-down" class="burst-chevron" />
  <span class="burst-title">{titleText}</span>
  <span class="burst-stats">
    {statsText}{#if elapsedLabel}
      &middot; {elapsedLabel}{/if}
  </span>
  <StatusDot
    {tone}
    label={statsText ? `${titleText}, ${statsText}` : titleText}
    pulse={stillActive}
  />
{/snippet}

<div
  class="tool-call-burst-group"
  class:awaiting-permission={hasAwaitingPermission}
  data-testid="tool-call-burst-group"
>
  <ToolCallGutter icon="tool-generic" />
  <ToolCard surface={true}>
    {#if hasAwaitingPermission}
      <div
        class="burst-summary burst-summary-static"
        aria-expanded="true"
        data-testid="tool-call-burst-summary"
      >
        {@render summaryContent()}
      </div>
    {:else}
      <button
        type="button"
        class="burst-summary"
        aria-expanded={expanded}
        onclick={toggle}
        data-testid="tool-call-burst-summary"
      >
        {@render summaryContent()}
      </button>
    {/if}
    {#if expanded}
      <ol class="burst-detail" data-testid="tool-call-burst-detail">
        {#each group.calls as call (call.id)}
          <li data-item-id={call.id}>
            <ToolCallRow
              item={call}
              awaitingPermission={awaitingPermissionId !== undefined &&
                awaitingPermissionId === call.id}
              {onOpenFile}
            />
          </li>
        {/each}
      </ol>
    {/if}
  </ToolCard>
</div>

<style>
  .tool-call-burst-group {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
    font-size: var(--text-small-size);
  }

  .burst-summary {
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    gap: var(--space-sm);
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .burst-summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-radius: var(--radius-sm);
  }

  .burst-summary-static {
    cursor: default;
  }

  /* No `flex-shrink: 0` here — `Icon.svelte`'s own `.icon { flex-shrink: 0; }`
     scoped root rule already provides the identical value (issue #665's
     guard test, `primitive-override-scope.test.ts`), same as
     `GenericToolRow.svelte`'s own identical note on its `.disclosure-icon`. */
  :global(.burst-chevron) {
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .burst-summary[aria-expanded='false'] :global(.burst-chevron) {
    transform: rotate(-90deg);
  }

  .burst-title {
    flex: 0 0 auto;
    font-weight: 600;
  }

  .burst-stats {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-muted);
  }

  .burst-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    margin: var(--space-sm) 0 0;
    padding: var(--space-sm) 0 0;
    border-top: 1px solid var(--color-border-subtle);
    list-style: none;
  }

  .burst-detail li {
    min-width: 0;
  }

  /* A pending permission inside a collapsed group must stay reachable
     (see the file doc comment) — the same amber ring `ToolCallRow` itself
     draws for its own `awaiting-permission` state, applied at the group
     level since the actionable card is nested inside the expanded detail. */
  .tool-call-burst-group.awaiting-permission :global(.tool-card) {
    outline: 2px solid var(--color-warning);
    outline-offset: 2px;
    border-radius: var(--radius-lg);
  }

  /* Below `--bp-mobile` the role column collapses, mirroring every other
     tool-call row's own copy of this rule (`GenericToolRow.svelte`,
     `ToolCallGutter.svelte`) — proven at the 390px floor by
     `tests-e2e/tool-call-burst.spec.ts`. */
  @media (max-width: 479px) {
    .tool-call-burst-group {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
