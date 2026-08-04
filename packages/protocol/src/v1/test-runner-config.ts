import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Per-project test/lint/build command configuration (SPEC §7.15; issue
 * #245). Exactly like `terminal.ts`'s PTY bytes, a project's configured
 * commands and this node's auto-detected suggestions are PRIVATE session
 * content (SPEC §8's metadata boundary) — even though a shell command
 * string is not a secret, it can reveal a project's internal script/build
 * layout, so it travels the same way everything else project-scoped does:
 * only inside an `encryptedEnvelope`, never in the clear. Every wire
 * message below carries only clear ROUTING metadata — `sessionId` (the
 * node resolves that session's `projectPath` itself, exactly like
 * `PermissionPolicyStore.get()` already does off `bridge.session.projectPath`)
 * plus `requestId` — never a command string.
 *
 * Four request/reply pairs, all routed to the owning node exactly like
 * `fs_list_request`/`fs_list_response` (`relay.ts`'s `routeToOwningNode`/
 * `fanOutDirect`):
 * - `test_runner_config_get` / `test_runner_config_result` — read the
 *   saved config (`{}` for a project with nothing saved yet — SPEC §7.15's
 *   "or auto-detected", never a guessed default).
 * - `test_runner_config_set` / `test_runner_config_result` — save an
 *   explicit override, in full per command key (SPEC §7.15's "the user
 *   sets/override the test/lint/build commands explicitly"). Reuses the
 *   same `test_runner_config_result` reply as `_get` so a client's "read
 *   back what I just saved" and "read the current value" are one code
 *   path.
 * - `test_runner_config_detect` / `test_runner_config_detected` — ask this
 *   node to inspect the project (on whichever target — `local` or `ssh:`
 *   — this session runs on) and propose commands, never silently applied
 *   (issue #245's "shown to the user for confirmation before being
 *   saved"): a caller gets `test_runner_config_detected`'s `suggestions`
 *   and must send a follow-up `test_runner_config_set` itself to persist
 *   any of them.
 *
 * Node-side persistence is `TestRunnerConfigStore` (`@loombox/node`'s
 * `test-runner-config-store.ts`), mirroring `McpConfigStore`/
 * `PermissionPolicyStore`'s own per-project JSON-file pattern — the node
 * is what actually spawns the configured command (SPEC §7.15/§16's test
 * runner), so it is what owns the config that decides what to spawn.
 */

/** A project's test/lint/build commands, each an opaque shell command line (e.g. `pnpm test`) run via the project's target — `undefined` means "not configured", never a guessed default. */
export const testRunnerCommandsV1 = z.object({
  test: z.string().min(1).optional(),
  lint: z.string().min(1).optional(),
  build: z.string().min(1).optional(),
});
export type TestRunnerCommandsV1 = z.infer<typeof testRunnerCommandsV1>;

/** The plaintext a `test_runner_config_result` envelope decrypts to. */
export const testRunnerConfigResultPayloadV1 = z.object({
  commands: testRunnerCommandsV1,
});
export type TestRunnerConfigResultPayloadV1 = z.infer<typeof testRunnerConfigResultPayloadV1>;

/** The plaintext a `test_runner_config_set` envelope decrypts to. */
export const testRunnerConfigSetPayloadV1 = z.object({
  commands: testRunnerCommandsV1,
});
export type TestRunnerConfigSetPayloadV1 = z.infer<typeof testRunnerConfigSetPayloadV1>;

/** The plaintext a `test_runner_config_detected` envelope decrypts to. */
export const testRunnerConfigDetectedPayloadV1 = z.object({
  suggestions: testRunnerCommandsV1,
});
export type TestRunnerConfigDetectedPayloadV1 = z.infer<typeof testRunnerConfigDetectedPayloadV1>;

/** Parses and validates a decrypted `test_runner_config_result` payload, throwing on an invalid one. */
export function parseTestRunnerConfigResultPayloadV1(
  data: unknown,
): TestRunnerConfigResultPayloadV1 {
  return testRunnerConfigResultPayloadV1.parse(data);
}

/** Same as {@link parseTestRunnerConfigResultPayloadV1} but never throws; returns zod's result. */
export function safeParseTestRunnerConfigResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TestRunnerConfigResultPayloadV1> {
  return testRunnerConfigResultPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `test_runner_config_set` payload, throwing on an invalid one. */
export function parseTestRunnerConfigSetPayloadV1(data: unknown): TestRunnerConfigSetPayloadV1 {
  return testRunnerConfigSetPayloadV1.parse(data);
}

/** Same as {@link parseTestRunnerConfigSetPayloadV1} but never throws; returns zod's result. */
export function safeParseTestRunnerConfigSetPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TestRunnerConfigSetPayloadV1> {
  return testRunnerConfigSetPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `test_runner_config_detected` payload, throwing on an invalid one. */
export function parseTestRunnerConfigDetectedPayloadV1(
  data: unknown,
): TestRunnerConfigDetectedPayloadV1 {
  return testRunnerConfigDetectedPayloadV1.parse(data);
}

/** Same as {@link parseTestRunnerConfigDetectedPayloadV1} but never throws; returns zod's result. */
export function safeParseTestRunnerConfigDetectedPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TestRunnerConfigDetectedPayloadV1> {
  return testRunnerConfigDetectedPayloadV1.safeParse(data);
}

/** A client asks the owning node for a session's project's saved test/lint/build commands. No envelope: the request itself carries no content, only which session/project to ask about. */
export const testRunnerConfigGet = z.object({
  type: z.literal('test_runner_config_get'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type TestRunnerConfigGet = z.infer<typeof testRunnerConfigGet>;

/** A client asks the owning node to save (fully replace) a session's project's test/lint/build commands. */
export const testRunnerConfigSet = z.object({
  type: z.literal('test_runner_config_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TestRunnerConfigSet = z.infer<typeof testRunnerConfigSet>;

/** The owning node's reply to `test_runner_config_get`/`test_runner_config_set` — the project's current saved commands. Fanned out to a session's subscribed clients exactly like `fs_list_response`. */
export const testRunnerConfigResult = z.object({
  type: z.literal('test_runner_config_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TestRunnerConfigResult = z.infer<typeof testRunnerConfigResult>;

/** A client asks the owning node to auto-detect test/lint/build commands for a session's project (SPEC §7.15). No envelope, same reasoning as `test_runner_config_get`. */
export const testRunnerConfigDetect = z.object({
  type: z.literal('test_runner_config_detect'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type TestRunnerConfigDetect = z.infer<typeof testRunnerConfigDetect>;

/** The owning node's reply to `test_runner_config_detect` — a SUGGESTION, not yet saved (issue #245's "shown ... for confirmation before being saved, not silently applied"). Fanned out exactly like `test_runner_config_result`. */
export const testRunnerConfigDetected = z.object({
  type: z.literal('test_runner_config_detected'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TestRunnerConfigDetected = z.infer<typeof testRunnerConfigDetected>;
