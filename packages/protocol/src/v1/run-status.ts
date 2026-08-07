import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';
import { runExitOutcomeV1, testRunnerKindV1 } from './test-runner';

/**
 * The node's own durable memory of each configured test/lint/build kind's
 * LATEST completed outcome for a session (SPEC §7.14/§7.15; issue #247) —
 * the runner's sibling of `ci-check.ts`'s own `ci_check_status`, carrying
 * the same "one node-pushed message, no request" shape: a client never
 * asks for this, it arrives whenever `NodeDaemon`'s own `RunStatusTracker`
 * (`packages/node/src/run-status-tracker.ts`) records a fresh `run_exit`.
 *
 * Unlike `ci_check_status`, this is event-driven, not polled — there is no
 * `'pending'` overall state to report, since `run_start`/`run_output`/
 * `run_exit` already stream a run's own live progress (issue #244). This
 * message exists purely so a freshly-connecting (or freshly-reconnected)
 * client learns a session's last KNOWN verdict per kind without having
 * re-run anything itself — exactly what makes the `'ci_failure'`
 * attention-inbox item durable across a reload; this file's own
 * `'run_failure'` counterpart (`@loombox/web`'s `RelayClient`) needs the
 * same durability so a local runner failure and a remote CI failure share
 * a shape, not two disconnected stories (issue #247's own acceptance).
 *
 * Session-scoped and envelope-sealed for the same SPEC §8 reason
 * `ci_check_status` is: a build/test/lint failure's own `reason` can embed
 * real project content, so the relay only ever sees `sessionId` and
 * ciphertext, never which kind ran or why it failed.
 *
 * `RunStatusOverallStateV1` mirrors `CiCheckOverallStateV1`'s own aggregate
 * judgment, minus `'pending'` (nothing to report between `run_start` and
 * `run_exit` here — that is `run_output`'s job): `'unknown'` — no kind has
 * ever completed a run for this session yet; `'passing'` — every kind that
 * HAS completed at least once is currently `'pass'`; `'failing'` — at
 * least one kind's latest completed outcome is `'fail'`/`'could_not_start'`
 * (`@loombox/shared`'s `isFailingRunOutcome`, the runner's own
 * `isFailingCiConclusion` sibling).
 */

/** One configured kind's latest completed run — never a still-running one (`run_output`/`run_exit` already cover that live half). */
export const runStatusEntryV1 = z.object({
  kind: testRunnerKindV1,
  outcome: runExitOutcomeV1,
  /** The `runId` this outcome came from — lets a client's "re-run" action target the exact same kind without a second lookup. */
  runId: z.string().min(1),
  /** Set only for `outcome: 'could_not_start'` — mirrors `RunExitPayloadV1.reason`. */
  reason: z.string().optional(),
  /** Epoch ms this outcome was recorded (`RunStatusTracker`'s own `now()`, injectable for tests). */
  updatedAt: z.number(),
});
export type RunStatusEntryV1 = z.infer<typeof runStatusEntryV1>;

export const runStatusOverallStateV1 = z.enum(['unknown', 'passing', 'failing']);
export type RunStatusOverallStateV1 = z.infer<typeof runStatusOverallStateV1>;

/** One session's latest known run status across every configured kind — what `run_status`'s envelope decrypts to (wrapped in {@link RunStatusPayloadV1}), and also `RunStatusTracker`'s own in-memory snapshot shape (`packages/node/src/run-status-tracker.ts`), reused as-is rather than a second parallel type — mirrors `ci-check.ts`'s own `CiCheckStateV1` doing the same for `CiCheckWatcher`. */
export const runStatusStateV1 = z.object({
  state: runStatusOverallStateV1,
  entries: z.array(runStatusEntryV1),
  /** Epoch ms this snapshot was produced. */
  updatedAt: z.number(),
});
export type RunStatusStateV1 = z.infer<typeof runStatusStateV1>;

/** The plaintext a `run_status` envelope decrypts to. */
export const runStatusPayloadV1 = z.object({
  status: runStatusStateV1,
});
export type RunStatusPayloadV1 = z.infer<typeof runStatusPayloadV1>;

/** Parses and validates a decrypted `run_status` payload, throwing on an invalid one. */
export function parseRunStatusPayloadV1(data: unknown): RunStatusPayloadV1 {
  return runStatusPayloadV1.parse(data);
}

/** Same as {@link parseRunStatusPayloadV1} but never throws; returns zod's result. */
export function safeParseRunStatusPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, RunStatusPayloadV1> {
  return runStatusPayloadV1.safeParse(data);
}

/**
 * The owning node streams a session's latest run status — sent right
 * after `RunStatusTracker` records a fresh `run_exit` (SPEC §7.14/§7.15;
 * issue #247). Fanned out to a session's subscribed clients exactly like
 * `ci_check_status`; the relay never opens the envelope.
 */
export const runStatus = z.object({
  type: z.literal('run_status'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type RunStatus = z.infer<typeof runStatus>;
