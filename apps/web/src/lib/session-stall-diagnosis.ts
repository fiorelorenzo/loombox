import type { SessionStatusV1 } from '@loombox/protocol';

/**
 * Turns a session's own live state into a specific, honest answer to "why
 * does this look stalled" (SPEC §7.21; issue #271) — pairs with issue
 * #255's load/concurrency-limits UI and #269's node/target health view
 * rather than adding a third surface: every input here is data one of
 * those two already computes or exposes (`RelayClient.statusFor`/
 * `statusReasonFor`, `target-concurrency.ts#queuePositionReasons`,
 * `+page.svelte`'s own `classifyTargetHealth` — the SAME "is this target's
 * node reachable, is its latest resource sample healthy" classification
 * `TargetStatusView.svelte`'s `healthState` and the status bar's target
 * dots already use, never re-derived from `TargetHealth`'s raw fields
 * here so this module can't quietly disagree with either of them).
 *
 * The four causes the issue names — the agent is thinking, the agent is
 * wedged, the node is out of capacity and queued, or the target is
 * unreachable — collapse to exactly the state a node can actually tell
 * apart: `'queued_at_capacity'` (the session's own status already says
 * so) and `'target_unreachable'` (an independent resource-sampler/
 * connectivity reading) are real, distinguishable signals; a confirmed-gone
 * agent process (`'exited'`/`'error'`/`'disconnected'`) is `'agent_unavailable'`.
 * "Thinking" vs. "wedged" has NO node-side signal to tell them apart at
 * all — no per-turn heartbeat exists — so that pair, and anything else
 * left over once the real signals are checked, is honestly `'unknown'`,
 * never guessed at as one or the other.
 */
export type StallCause =
  'queued_at_capacity' | 'agent_unavailable' | 'target_unreachable' | 'unknown';

export interface StallDiagnosis {
  cause: StallCause;
  /** Ready to show directly (a sentence fragment, lowercase-led, matching `sessionStatusLabelWithReason`'s existing `"${label}: ${reason}"` convention) or to log/inspect for `'unknown'`. */
  message: string;
}

/** `SessionStatusV1` values that mean the agent process behind this session is confirmed not running — see this module's own doc comment. */
const AGENT_UNAVAILABLE_STATUSES: Partial<Record<SessionStatusV1, true>> = {
  exited: true,
  error: true,
  disconnected: true,
};

export interface StallDiagnosisInput {
  status: SessionStatusV1 | undefined;
  /** The node-sent `RelayClient.statusReasonFor` value, when this status carries one (a spawn failure, a spend cap, or — since issue #271 — a mid-session exit code; see `@loombox/protocol`'s `sessionStatusEventV1.reason` doc comment). */
  statusReason: string | undefined;
  /** `target-concurrency.ts#queuePositionReasons`' own wording for this session, when `status` is `'queued'` — always defined in real use (that helper never returns `undefined` for an actually-queued session), kept optional here only so a caller/test can exercise the fallback below. */
  queueReason: string | undefined;
  /**
   * Whether this session's target is currently unreachable — the SAME
   * classification `+page.svelte`'s `classifyTargetHealth`/
   * `TargetStatusView.svelte`'s `healthState` already compute (the
   * owning node has no live relay connection, OR its latest
   * resource-sampler reading came back `healthy: false`). `undefined`
   * when this session's target has never been seen in a `target_list`
   * reply at all — "we don't know" that this function must NOT read as
   * "reachable".
   */
  targetUnreachable: boolean | undefined;
  /** The target's own `TargetHealth.sampledAt` (epoch ms), for an honest "as of" — `undefined` when {@link targetUnreachable} came from the owning node having no live connection at all rather than a failed resource sample (no sample was ever taken to time-stamp). */
  targetHealthSampledAt: number | undefined;
  /** Injectable for a deterministic test; defaults to `Date.now`. */
  now?: () => number;
}

export function diagnoseSessionStall(input: StallDiagnosisInput): StallDiagnosis {
  if (input.status === 'queued') {
    return {
      cause: 'queued_at_capacity',
      message: input.queueReason ?? 'queued: waiting for a concurrency slot on its target',
    };
  }
  if (input.status !== undefined && AGENT_UNAVAILABLE_STATUSES[input.status]) {
    return {
      cause: 'agent_unavailable',
      message: input.statusReason ?? agentUnavailableFallback(input.status),
    };
  }
  if (input.targetUnreachable === true) {
    return {
      cause: 'target_unreachable',
      message:
        input.targetHealthSampledAt !== undefined
          ? `target unreachable — last checked ${formatRelativeAge(input.targetHealthSampledAt, input.now?.() ?? Date.now())}`
          : 'target unreachable — its node has no live connection to the relay',
    };
  }
  return {
    cause: 'unknown',
    message:
      "no target or capacity problem is indicated — can't tell whether the agent is still working or genuinely stuck",
  };
}

function agentUnavailableFallback(status: SessionStatusV1): string {
  return status === 'disconnected'
    ? "the node restarted and this session's agent process did not survive — resume it to continue"
    : 'the agent process is no longer running, with no further detail from the node';
}

/** Mirrors `TargetStatusView.svelte`'s own `formatRelativeAge` bucketing (that one is component-local/unexported — this module keeps its own copy rather than reaching into it, the same small-duplication convention `+page.svelte`'s `formatSessionActivity` already documents for the identical reason). */
function formatRelativeAge(sampledAt: number, now: number): string {
  const ageMs = Math.max(0, now - sampledAt);
  if (ageMs < 1_000) return 'just now';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / 3_600_000)}h ago`;
}
