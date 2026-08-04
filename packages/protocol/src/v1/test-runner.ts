import { z } from 'zod';
import { base64String, encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Streaming test/lint/build runs (SPEC §7.15; issue #244) — the sibling of
 * `test-runner-config.ts` (issue #245), which only carries the command
 * strings a project has configured. This file is what actually runs one of
 * them and streams its output live, modeled closely on `terminal.ts`'s own
 * open/data/close vocabulary: run output is exactly as PRIVATE as terminal
 * bytes (SPEC §8's metadata boundary) — a build log can contain source
 * excerpts, file paths, stack traces — so every wire message below carries
 * only clear ROUTING metadata (`sessionId` + `runId`, and for `run_start`
 * `targetId` + `requestId`, mirroring `terminalOpen`'s own convention);
 * never a byte of output or even *which* of test/lint/build ran travels
 * outside an `encryptedEnvelope`. `packages/relay/src/relay.ts` routes a
 * client's `run_start`/`run_cancel` to the owning node exactly like
 * `terminal_open`/`terminal_close`, and fans a node's `run_started`/
 * `run_output`/`run_exit` out to a session's subscribed clients exactly
 * like `terminal_opened`/`terminal_output`/`terminal_closed` — it never
 * inspects any of these envelopes' plaintext.
 *
 * Keyed by `sessionId` + `runId` throughout, `runId` a client-generated
 * opaque id (mirrors `terminalId`) scoped to its session — a session can
 * have more than one run in flight at once (e.g. test and lint started
 * back to back), each tracked independently.
 *
 * One request/reply pair (`run_start`/`run_started`) begins a run,
 * `run_output` streams its combined stdout+stderr as it's produced,
 * `run_exit` reports its terminal state once, and `run_cancel` asks the
 * node to stop an in-flight run (whose eventual `run_exit` carries
 * `cancelled: true`). `run_started`'s `outcome: 'error'` covers only "this
 * project has no saved command for the requested kind" (SPEC §16
 * grounding: message shape modeled clean-room on hapi's `terminal.ts`
 * create/write/close vocabulary, AGPL, design reference only, no code
 * copied) — a permission-policy denial or a real "command not found" both
 * happen only after a run has already been accepted (`run_started`'s
 * `outcome: 'ok'`), so both surface later as `run_exit`'s
 * `outcome: 'could_not_start'` instead; see that field's own doc comment.
 */

/** Which configured command a run executes — the same three keys `TestRunnerCommandsV1` (`./test-runner-config.ts`, issue #245) already defines. */
export const testRunnerKindV1 = z.enum(['test', 'lint', 'build']);
export type TestRunnerKindV1 = z.infer<typeof testRunnerKindV1>;

/** The plaintext a `run_start` envelope decrypts to: which configured command to run — no real secret (`test`/`lint`/`build`), but still travels encrypted for the same reason `terminalOpenPayloadV1`'s non-secret cols/rows do (this file's own doc comment). */
export const runStartPayloadV1 = z.object({
  kind: testRunnerKindV1,
});
export type RunStartPayloadV1 = z.infer<typeof runStartPayloadV1>;

/** A successful `run_start`: this project has a saved command for the requested kind, and tracking (`run_output`/`run_exit`) begins under the `runId` the request itself named. Whether the process then actually spawns (vs. immediately failing a permission-policy check, or exiting 127 for a missing binary) is reported later via `run_exit` — this "ok" is only "there is something to run", exactly like `terminalOpenOkV1` does not itself guarantee the shell keeps running. */
export const runStartedOkV1 = z.object({
  outcome: z.literal('ok'),
});
export type RunStartedOkV1 = z.infer<typeof runStartedOkV1>;

/** A failed `run_start`: no command is saved for the requested kind (or the request itself couldn't be decrypted/handled) — there is nothing to run, so no tracking begins. Mirrors `terminalOpenErrorV1`. */
export const runStartedErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
export type RunStartedErrorV1 = z.infer<typeof runStartedErrorV1>;

/** The plaintext a `run_started` envelope decrypts to. */
export const runStartedResultPayloadV1 = z.discriminatedUnion('outcome', [
  runStartedOkV1,
  runStartedErrorV1,
]);
export type RunStartedResultPayloadV1 = z.infer<typeof runStartedResultPayloadV1>;

/** The plaintext a `run_output` envelope decrypts to: one streamed chunk of the run's combined stdout+stderr (the same 2>&1-style merge a real terminal shows), base64-carried exactly like `terminalDataPayloadV1` — arbitrary bytes, not guaranteed valid UTF-8 at a chunk boundary. */
export const runOutputPayloadV1 = z.object({
  data: base64String,
});
export type RunOutputPayloadV1 = z.infer<typeof runOutputPayloadV1>;

/**
 * Why a run reached its terminal state (`run_exit`):
 * - `'pass'` — the command ran to completion and exited 0.
 * - `'fail'` — the command ran to completion and exited non-zero (and
 *   wasn't 127 — see below).
 * - `'could_not_start'` — the command never meaningfully ran. Two distinct
 *   causes share this one outcome (both are "could not start" from the
 *   user's point of view, see `reason`): a permission-policy denial (the
 *   process was never spawned at all — `exitCode` is `null`), and a real
 *   POSIX 127 ("command not found") from the `sh -c` shell every run goes
 *   through, on both `local` and `ssh:` (`exitCode` is `127`) — one wire
 *   outcome instead of a client having to special-case ENOENT vs. a
 *   remote shell's own "not found" text.
 */
export const runExitOutcomeV1 = z.enum(['pass', 'fail', 'could_not_start']);
export type RunExitOutcomeV1 = z.infer<typeof runExitOutcomeV1>;

/** The plaintext a `run_exit` envelope decrypts to. `exitCode` is the real POSIX exit code whenever one exists (including 127) and `null` only when the process never actually spawned (a permission-policy denial). `reason` is set for `outcome: 'could_not_start'`, naming which of the two causes above. `cancelled` is set when this exit was the direct result of a client's `run_cancel`, so a client can label an intentionally-stopped run distinctly from a real failure without a fourth `outcome` value. */
export const runExitPayloadV1 = z.object({
  outcome: runExitOutcomeV1,
  exitCode: z.number().int().nullable(),
  reason: z.string().optional(),
  cancelled: z.boolean().optional(),
});
export type RunExitPayloadV1 = z.infer<typeof runExitPayloadV1>;

/** Parses and validates a decrypted `run_start` payload, throwing on an invalid one. */
export function parseRunStartPayloadV1(data: unknown): RunStartPayloadV1 {
  return runStartPayloadV1.parse(data);
}

/** Same as {@link parseRunStartPayloadV1} but never throws; returns zod's result. */
export function safeParseRunStartPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, RunStartPayloadV1> {
  return runStartPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `run_started` payload, throwing on an invalid one. */
export function parseRunStartedResultPayloadV1(data: unknown): RunStartedResultPayloadV1 {
  return runStartedResultPayloadV1.parse(data);
}

/** Same as {@link parseRunStartedResultPayloadV1} but never throws; returns zod's result. */
export function safeParseRunStartedResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, RunStartedResultPayloadV1> {
  return runStartedResultPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `run_output` payload, throwing on an invalid one. */
export function parseRunOutputPayloadV1(data: unknown): RunOutputPayloadV1 {
  return runOutputPayloadV1.parse(data);
}

/** Same as {@link parseRunOutputPayloadV1} but never throws; returns zod's result. */
export function safeParseRunOutputPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, RunOutputPayloadV1> {
  return runOutputPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `run_exit` payload, throwing on an invalid one. */
export function parseRunExitPayloadV1(data: unknown): RunExitPayloadV1 {
  return runExitPayloadV1.parse(data);
}

/** Same as {@link parseRunExitPayloadV1} but never throws; returns zod's result. */
export function safeParseRunExitPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, RunExitPayloadV1> {
  return runExitPayloadV1.safeParse(data);
}

/**
 * A client asks the owning node to run a session's project's configured
 * `kind` command (SPEC §7.15; issue #244) on one of its targets. `runId` is
 * client-generated (mirrors `terminalOpen`'s `terminalId`) so a session can
 * have more than one run tracked at once; `requestId` correlates this
 * specific start attempt's `run_started` reply, same as `terminalOpen`.
 */
export const runStart = z.object({
  type: z.literal('run_start'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  targetId: z.string().min(1),
  runId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type RunStart = z.infer<typeof runStart>;

/**
 * The owning node's reply to `run_start`. Fanned out to a session's
 * subscribed clients exactly like `terminal_opened` — a requesting client
 * matches its own pending request by `requestId`; any other subscribed
 * client simply has no pending request with that id.
 */
export const runStarted = z.object({
  type: z.literal('run_started'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type RunStarted = z.infer<typeof runStarted>;

/** The owning node streams one chunk of a run's combined output. Fanned out to a session's subscribed clients exactly like `terminal_output`. */
export const runOutput = z.object({
  type: z.literal('run_output'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type RunOutput = z.infer<typeof runOutput>;

/** The owning node reports a run's terminal state, exactly once per run. Fanned out exactly like `terminal_closed`. */
export const runExit = z.object({
  type: z.literal('run_exit'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type RunExit = z.infer<typeof runExit>;

/** A client asks the owning node to cancel an in-flight run. No envelope: cancelling carries no content, only the id of what to cancel — mirroring `terminalClose`'s own envelope-less shape. A silent no-op (the node's own `TestRunnerConfigGet`-style guard) if `runId` is already exited or unknown. */
export const runCancel = z.object({
  type: z.literal('run_cancel'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
});
export type RunCancel = z.infer<typeof runCancel>;
