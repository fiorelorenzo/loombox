import type { TargetHealthDotState } from './components/StatusBar.svelte';
import { classifyTargetHealth, TARGET_OVERLOAD_PERCENT } from './target-health';
import type { TargetListEntry } from './relay-client';

/**
 * Target-health context for a "stalled/errored" attention-inbox row (issue
 * #204, SPEC §7.13/§7.21): "no relevant context" is `undefined`, never a
 * `'healthy'` entry — a row with nothing to add stays exactly as plain as
 * it was before this feature. {@link classifyTargetHealth}'s `'healthy'`
 * state is therefore the one member of {@link TargetHealthDotState} this
 * module's own state never carries.
 */
export type InboxTargetHealthState = Exclude<TargetHealthDotState, 'healthy'>;

export interface InboxTargetHealthContext {
  readonly state: InboxTargetHealthState;
  /** Ready to show directly next to the row — lowercase-led, matching `session-stall-diagnosis.ts`'s `StallDiagnosis.message` convention. */
  readonly message: string;
}

/** Mirrors `session-stall-diagnosis.ts`'s own `formatRelativeAge` bucketing (that one is module-private — this module keeps its own copy rather than reaching into it, the same small-duplication convention `+page.svelte`'s `formatSessionActivity` already documents). */
function formatRelativeAge(sampledAt: number, now: number): string {
  const ageMs = Math.max(0, now - sampledAt);
  if (ageMs < 1_000) return 'just now';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / 3_600_000)}h ago`;
}

/**
 * The resource(s) actually over {@link TARGET_OVERLOAD_PERCENT} on an
 * `'overloaded'` reading, named rather than left as a bare state — "target
 * overloaded" alone would be as uninformative as the boolean
 * `diagnoseSessionStall` deliberately avoids for the identical reason (that
 * module's own doc comment). Always non-empty for a target
 * {@link classifyTargetHealth} actually classified `'overloaded'`: that
 * classification is reached only when at least one of these three crossed
 * the threshold.
 */
function overloadedResources(health: TargetListEntry['health']): string[] {
  const resources: string[] = [];
  if (health === undefined) return resources;
  if (health.loadPercent !== undefined && health.loadPercent >= TARGET_OVERLOAD_PERCENT) {
    resources.push(`load ${Math.round(health.loadPercent)}%`);
  }
  if (health.memPercent >= TARGET_OVERLOAD_PERCENT) {
    resources.push(`memory ${Math.round(health.memPercent)}%`);
  }
  if (health.diskPercent >= TARGET_OVERLOAD_PERCENT) {
    resources.push(`disk ${Math.round(health.diskPercent)}%`);
  }
  return resources;
}

/**
 * Turns one session's target into the attention inbox's own honest answer
 * to "does this stalled/errored row have a target-health explanation"
 * (issue #204's acceptance: additive to, not a rework of, the v1 inbox —
 * this never touches `AttentionInboxItem`/`RelayClient.attentionInbox()`
 * itself; a caller joins it in by `sessionId` alongside the unmodified item
 * list, exactly like `+page.svelte`'s existing `sessionStallReasons`
 * join). `target` is `undefined` both when this session's target has never
 * been seen in a `target_list` reply at all AND when its target has no
 * health sample yet — both read as "we don't know" here, the identical
 * `'no-data'` outcome {@link classifyTargetHealth} already gives a known
 * target with an absent/stale-peer sample, so a genuinely unmeasured target
 * is never rendered as though it were fine (issue #204's "a class with no
 * data says so rather than showing zero as if it were measured").
 */
export function inboxTargetHealthContext(
  target: TargetListEntry | undefined,
  now: number = Date.now(),
): InboxTargetHealthContext | undefined {
  if (!target) return { state: 'no-data', message: 'target health: no data yet' };
  const state = classifyTargetHealth(target);
  switch (state) {
    case 'healthy':
      return undefined;
    case 'no-data':
      return { state, message: 'target health: no data yet' };
    case 'unreachable':
      return {
        state,
        message:
          target.health?.sampledAt !== undefined
            ? `target unreachable — last checked ${formatRelativeAge(target.health.sampledAt, now)}`
            : 'target unreachable — its node has no live connection to the relay',
      };
    case 'overloaded':
      return {
        state,
        message: `target overloaded — ${overloadedResources(target.health).join(', ')}`,
      };
  }
}
