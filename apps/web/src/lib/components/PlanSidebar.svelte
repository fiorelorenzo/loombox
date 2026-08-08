<script lang="ts">
  /**
   * The persistent per-session plan sidebar (SPEC.md §7.24 "Plans, rendered
   * twice from one truth" — the sidebar portion, v2; issue #201). Depends
   * on `PlanCard.svelte` (issue #143, the inline v1 render) for its data:
   * both read the same `TranscriptState.plan` — ACP replaces a plan's
   * entire entry list wholesale on every `plan_update`, so there is exactly
   * one current plan per session at any moment, never diffed client-side —
   * and share `$lib/plan.ts`'s `planProgress`/`groupPlanEntries` rather
   * than each recomputing "N of M" or the status buckets its own way. This
   * is a second VIEW onto that one truth (grouped by status, with a
   * completion bar), not a second copy of the data.
   *
   * **Home, not a workbench tab (2026-08-07 decision).** The obvious "one
   * more session-scoped panel" home would have been a fourth
   * `WORKBENCH_TABS` entry beside Files/Config/Runner in `+page.svelte`'s
   * right sidebar — but issue #811 already tried exactly that (a
   * Checkpoints tab) and reverted it: `cockpit-shell.spec.ts`'s "the right
   * sidebar carries only the open session panels a project/session
   * actually needs" spec hard-asserts the Workbench panel radiogroup at
   * `toHaveCount(3)`, and a plan tab would also fight this issue's own
   * "persistent" wording — a tab still needs a click, and switching to it
   * hides Files/Config/Runner, which is the opposite of "stays visible
   * after the user scrolls away." Mounted instead as a docked block inside
   * `+page.svelte`'s `.canvas-transcript-view`, directly above
   * `TranscriptTimeline`: that element is already `display: flex;
   * flex-direction: column` with `TranscriptTimeline`'s own `.items` as
   * the ONLY `flex: 1; overflow-y: auto` child in the column (see that
   * component's own doc comment), so a sibling placed before it needs no
   * new flex/positioning rules at all — it simply claims its own height
   * and the transcript's scroll area shrinks to what's left, exactly the
   * way `.canvas-footer` already claims space below. That also means this
   * component is genuinely absent (not just visually collapsed) for a
   * session whose agent never emits a plan and while a file/diff/graph
   * canvas tab is open instead of the transcript: the caller only mounts
   * it inside `.canvas-transcript-view`'s own `{#if transcript &&
   * transcript.plan.length > 0}` guard, the same one `PlanCard` already
   * uses — no empty scaffold, ever.
   *
   * **No flicker, no stolen focus (this issue's other explicit
   * requirement).** `entries` only changes reference on a real
   * `plan_update` (`reducePlan`'s `{...state, plan: update.entries.slice()}`
   * is the only reducer branch that replaces `TranscriptState.plan`; every
   * other update spreads the existing array reference through unchanged),
   * so this component's derived state only recomputes when the plan itself
   * actually changed, not on every unrelated transcript tick. Within that,
   * `groupPlanEntries` tags each entry with its ORIGINAL index in the
   * wholesale array (`$lib/plan.ts`'s `KeyedPlanEntry`) and every `{#each}`
   * below keys on it, mirroring `PlanCard`'s identical `(index)` key — an
   * entry whose status (and therefore group) didn't change between two
   * `plan_update`s keeps its Svelte-tracked DOM identity and never remounts
   * or replays a mount animation. The one mount animation this component
   * does play (`beat-in`, matching `PlanCard`/`MessageItem`/`ToolCallRow`)
   * fires once, when the caller's own `{#if}` first turns true for the
   * session — never again for a later `plan_update`, since that guard
   * doesn't re-toggle just because `entries` got a new array reference.
   * Nothing here ever calls `.focus()` or renders an `autofocus` element,
   * so a plan arriving or updating mid-turn cannot move focus out of
   * wherever the user's typing.
   *
   * Collapsible, remembering collapse state for the session exactly like
   * `PlanCard` (`collapsed`/`onToggle` — the caller owns the per-session
   * map, `+page.svelte`'s `planSidebarCollapsedBySession`, a sibling of its
   * existing `planCollapsedBySession` for the card). The completion bar
   * (`.meter`/`.meter-fill.thread-draw-fill`) reuses `TargetStatusView`'s
   * own load/RAM/disk meter recipe verbatim rather than a third bespoke
   * progress-bar implementation.
   */
  import type { AcpPlanEntry } from '@loombox/providers-core/browser';
  import { groupPlanEntries, planProgress, type KeyedPlanEntry } from '$lib/plan';
  import StatusDot from './ui/StatusDot.svelte';

  interface Props {
    entries: AcpPlanEntry[];
    collapsed: boolean;
    onToggle: () => void;
  }

  const { entries, collapsed, onToggle }: Props = $props();

  const progress = $derived(planProgress(entries));
  const groups = $derived(groupPlanEntries(entries));
  const active = $derived(entries.some((entry) => entry.status !== 'completed'));
  const percentComplete = $derived(
    progress.total === 0 ? 0 : Math.round((progress.completed / progress.total) * 100),
  );

  interface StatusGroup {
    key: 'pending' | 'in_progress' | 'completed';
    label: string;
    entries: readonly KeyedPlanEntry[];
  }

  // Literal issue #201 order ("grouped pending/in-progress/completed"): a
  // still-to-do/doing-now/done reading top to bottom. A status with no
  // entries renders no group at all, rather than an empty section.
  const visibleGroups = $derived(
    (
      [
        { key: 'pending', label: 'Pending', entries: groups.pending },
        { key: 'in_progress', label: 'In progress', entries: groups.inProgress },
        { key: 'completed', label: 'Completed', entries: groups.completed },
      ] satisfies StatusGroup[]
    ).filter((group) => group.entries.length > 0),
  );
</script>

<section class="plan-sidebar" data-testid="plan-sidebar" aria-label="Plan">
  <button
    type="button"
    class="plan-sidebar-header"
    onclick={onToggle}
    aria-expanded={!collapsed}
    aria-label={collapsed ? 'Expand plan' : 'Collapse plan'}
  >
    <span class="chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
    <span class="title">Plan</span>
    <span class="progress" data-testid="plan-sidebar-progress"
      >{progress.completed}/{progress.total}</span
    >
    {#if active}
      <span class="shimmer" data-testid="plan-sidebar-shimmer">
        <StatusDot tone="info" pulse label="Plan in progress" />
      </span>
    {/if}
  </button>

  <div
    class="meter"
    data-testid="plan-sidebar-meter"
    role="progressbar"
    aria-valuenow={percentComplete}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label="Plan completion"
  >
    <div
      class="meter-fill thread-draw-fill"
      style={`--thread-draw-progress: ${percentComplete}%`}
    ></div>
  </div>

  {#if !collapsed}
    <div class="plan-sidebar-groups">
      {#each visibleGroups as group (group.key)}
        <div class="plan-sidebar-group" data-testid={`plan-sidebar-group-${group.key}`}>
          <p class="group-label">{group.label} · {group.entries.length}</p>
          <ol class="group-entries">
            {#each group.entries as keyed (keyed.key)}
              <li class={keyed.entry.status}>
                <span class="checkbox" aria-hidden="true"
                  >{keyed.entry.status === 'completed' ? '☑' : '☐'}</span
                >
                <span class="content">{keyed.entry.content}</span>
              </li>
            {/each}
          </ol>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .plan-sidebar {
    width: 100%;
    max-width: var(--measure);
    margin-inline: auto;
    flex-shrink: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    font-size: var(--text-small-size);
    overflow: hidden;
    /* Single un-staggered beat-in, played once when the caller's own
       `{#if transcript.plan.length > 0}` first mounts this component for
       the session — see the file doc comment's "no flicker" section for
       why a later plan_update never replays it. */
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .plan-sidebar-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-fill-subtle);
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

  /* The completion bar — `TargetStatusView.svelte`'s own load/RAM/disk
     meter recipe, verbatim, not a third bespoke progress-bar. */
  .meter {
    height: var(--space-xs);
    margin: 0 var(--space-md);
    border-radius: var(--radius-full);
    background: var(--color-fill);
    overflow: hidden;
  }

  .meter-fill {
    width: 100%;
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--color-accent);
  }

  .plan-sidebar-groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md) var(--space-md);
    /* This is a docked panel, not a scroll region of its own — a very long
       plan still degrades gracefully (min-width: 0 down the flex chain,
       overflow-wrap below) rather than growing without bound and pushing
       the transcript's own scroll area to nothing, but nothing here forces
       a second nested scrollbar either. */
    min-width: 0;
  }

  .group-label {
    margin: 0 0 var(--space-2xs);
    font-size: var(--text-caption-size);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--text-caption-tracking);
    opacity: 0.6;
  }

  .group-entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .group-entries li {
    display: flex;
    gap: var(--space-xs);
    align-items: baseline;
    min-width: 0;
  }

  .group-entries li .content {
    min-width: 0;
    overflow-wrap: break-word;
  }

  .group-entries li .checkbox {
    color: var(--color-text-muted);
  }

  .group-entries li.completed .checkbox {
    color: var(--color-success);
  }

  .group-entries li.completed .content {
    opacity: 0.55;
    text-decoration: line-through;
  }

  /* Accent-for-meaning, matching PlanCard/TodoWidget's identical
     in-progress marker convention. */
  .group-entries li.in_progress {
    position: relative;
    padding-left: var(--space-sm);
  }

  .group-entries li.in_progress::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.2em;
    bottom: 0.2em;
    width: 2px;
    border-radius: var(--radius-full);
    background: var(--color-accent);
  }

  .group-entries li.in_progress .content {
    font-weight: 600;
  }

  /* Touch-optimized header (SPEC.md §7.3, issue #133), matching
     PlanCard's identical rule. */
  @media (pointer: coarse) {
    .plan-sidebar-header {
      min-height: var(--touch-target-min);
      padding: var(--space-md) var(--space-lg);
    }
  }
</style>
