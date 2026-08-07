import type { TargetHealthDotState } from './components/StatusBar.svelte';
import type { TargetListEntry } from './relay-client';

/**
 * The load/mem/disk percent (of `TargetHealth`'s clamped `[0, 100]` figures)
 * at or above which a reachable, healthy-sampled target still counts as
 * `'overloaded'` — the single threshold every consumer of
 * {@link classifyTargetHealth} shares, so "is this target under pressure"
 * never has two different answers for the same reading.
 */
export const TARGET_OVERLOAD_PERCENT = 90;

/**
 * A `TargetListEntry` reduced to the shared health vocabulary
 * (`StatusBar.svelte`'s own `TargetHealthDotState`) — extracted from
 * `+page.svelte` (issue #736's original home for this classification) so
 * the attention inbox's target-health context (issue #204,
 * `inbox-target-health.ts`) reads the exact same judgment the status bar's
 * target dots and `+page.svelte`'s own `sessionStallReasons` already use,
 * rather than a third copy quietly drifting from either. `TargetStatusView`'s
 * own local `healthState()` stays a deliberately separate, purely
 * presentational classification (its own doc comment) — not unified here,
 * out of this issue's scope.
 */
export function classifyTargetHealth(target: TargetListEntry): TargetHealthDotState {
  if (!target.reachable) return 'unreachable';
  if (!target.health) return 'no-data';
  if (!target.health.healthy) return 'unreachable';
  // `loadPercent`, never the deprecated `cpuPercent` those two used to
  // share: same number, but the old name claimed it was utilisation when
  // it has always been a load-average proxy (v5 design spec §3). A peer
  // that predates the field reports no load at all, which must not read as
  // a healthy zero - `TargetStatusView` shows an em dash for exactly this,
  // so the dot abstains here too rather than inventing good news.
  const { loadPercent, memPercent, diskPercent } = target.health;
  if (loadPercent === undefined) return 'no-data';
  if (
    loadPercent >= TARGET_OVERLOAD_PERCENT ||
    memPercent >= TARGET_OVERLOAD_PERCENT ||
    diskPercent >= TARGET_OVERLOAD_PERCENT
  ) {
    return 'overloaded';
  }
  return 'healthy';
}
