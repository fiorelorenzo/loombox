import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * The CI check status watcher's own wire shape (SPEC §7.14 "watch CI
 * checks, surface failures back to the agent"; issue #239) — the sibling of
 * `pr.ts`'s pr_open pair, picking up right where it leaves off: once a
 * session's branch has an open pull request (`pr-open.ts`'s `openPr`,
 * issue #238), `packages/node/src/ci-check-watcher.ts` polls that PR's
 * GitHub Actions check runs and this file is what carries the result back
 * over the wire.
 *
 * One node-pushed message, no request: `ci_check_status` streams a
 * session's latest known CI state to its subscribed clients, exactly like
 * `test-runner.ts`'s `run_output`/`run_exit` stream a run's — a client
 * never asks for it, it arrives whenever the node's own poll produces a
 * fresh reading (on a fixed interval; see `CiCheckWatcher`'s own doc
 * comment) or right after a session's PR is first opened. Session-scoped
 * and envelope-sealed for the same SPEC §8 reason every other per-session
 * payload is: a check run's name/output can embed real, sometimes
 * sensitive, project content (a failing test's own output text), so the
 * relay only ever sees `sessionId` and ciphertext, never a check name or
 * conclusion.
 *
 * `CiCheckRunV1.status`/`.conclusion` are kept as free strings rather than
 * a closed zod enum on purpose: they mirror GitHub's own check-runs API
 * response fields verbatim (`status`: `queued`/`in_progress`/`completed`;
 * `conclusion`: `success`/`failure`/`neutral`/`cancelled`/`skipped`/
 * `timed_out`/`action_required`/`stale`, or `null` while still running) —
 * an external, evolving vocabulary this module only ever passes through
 * for a client to render, never branches on itself (that judgment call,
 * "which conclusions count as a failure", lives once in
 * `ci-check-watcher.ts`'s own `FAILING_CONCLUSIONS`, not duplicated here as
 * a schema constraint that would need updating in lockstep with GitHub's
 * own vocabulary).
 *
 * `CiCheckOverallStateV1` IS a closed loombox-owned vocabulary (unlike the
 * two fields above) because it is this codebase's own aggregate judgment,
 * not a passthrough of anything GitHub returns directly:
 * - `'unknown'` — no check runs reported yet for this ref (nothing pushed
 *   through Actions yet, or the credential needed to ask was unavailable).
 * - `'pending'` — at least one check run is still queued/in_progress, none
 *   has failed yet.
 * - `'passing'` — every check run completed and none failed.
 * - `'failing'` — at least one check run's conclusion is one of
 *   `ci-check-watcher.ts`'s own `FAILING_CONCLUSIONS`; surfaced
 *   immediately, without waiting for the rest to finish.
 */

export const ciCheckRunV1 = z.object({
  /** GitHub's own numeric check-run id. */
  id: z.number(),
  name: z.string(),
  /** GitHub's check-run `status` verbatim (`queued`/`in_progress`/`completed`) — see this file's own doc comment for why this is a free string, not an enum. */
  status: z.string(),
  /** GitHub's check-run `conclusion` verbatim, or `null` while still running. */
  conclusion: z.string().nullable(),
  /** GitHub's own `html_url` for this check run, when present — lets a client link straight to the failing job's log. */
  detailsUrl: z.string().optional(),
  /** A short human-readable summary of this check run's own output (GitHub's `output.summary`, falling back to `output.title`), when GitHub reported one — the "failure output attached" acceptance line (issue #239). */
  summary: z.string().optional(),
});
export type CiCheckRunV1 = z.infer<typeof ciCheckRunV1>;

export const ciCheckOverallStateV1 = z.enum(['unknown', 'pending', 'passing', 'failing']);
export type CiCheckOverallStateV1 = z.infer<typeof ciCheckOverallStateV1>;

/** One session's latest known CI state — what `ci_check_status`'s envelope decrypts to (wrapped in {@link CiCheckStatusPayloadV1}), and also `CiCheckWatcher`'s own in-memory snapshot shape (`packages/node/src/ci-check-watcher.ts`), reused as-is rather than a second parallel type. */
export const ciCheckStateV1 = z.object({
  state: ciCheckOverallStateV1,
  /** The head commit SHA every `checkRuns` entry below was reported against, when at least one check run exists — absent for `'unknown'` with zero check runs. Not itself rendered by a client; `CiCheckWatcher` uses it to tell a genuinely new failure (a fresh commit) apart from the same failure still sitting red on a later poll. */
  headSha: z.string().optional(),
  prUrl: z.string(),
  prNumber: z.number(),
  checkRuns: z.array(ciCheckRunV1),
  /** Epoch ms this reading was produced (`CiCheckWatcher`'s own `now()`, injectable for tests). */
  updatedAt: z.number(),
});
export type CiCheckStateV1 = z.infer<typeof ciCheckStateV1>;

/** The plaintext a `ci_check_status` envelope decrypts to. */
export const ciCheckStatusPayloadV1 = z.object({
  status: ciCheckStateV1,
});
export type CiCheckStatusPayloadV1 = z.infer<typeof ciCheckStatusPayloadV1>;

/** Parses and validates a decrypted `ci_check_status` payload, throwing on an invalid one. */
export function parseCiCheckStatusPayloadV1(data: unknown): CiCheckStatusPayloadV1 {
  return ciCheckStatusPayloadV1.parse(data);
}

/** Same as {@link parseCiCheckStatusPayloadV1} but never throws; returns zod's result. */
export function safeParseCiCheckStatusPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, CiCheckStatusPayloadV1> {
  return ciCheckStatusPayloadV1.safeParse(data);
}

/**
 * The owning node streams a session's latest CI check state — sent right
 * after a session's PR is first opened, and again on every subsequent poll
 * (`CiCheckWatcher`'s own fixed interval), whatever the state, exactly like
 * `run_output`/`target_status` push on every pass rather than only on
 * change. Fanned out to a session's subscribed clients exactly like
 * `run_output`/`pr_open_result`; the relay never opens the envelope.
 */
export const ciCheckStatus = z.object({
  type: z.literal('ci_check_status'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type CiCheckStatus = z.infer<typeof ciCheckStatus>;
