import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for `@loombox/node`'s per-project `PermissionPolicy`
 * (SPEC §7.17; issue #256's `permission-policy.ts`) — the command/network
 * allow/deny glob lists that already exist and already enforce node-side,
 * with no client anywhere that could read or edit them until now (issue
 * #751, D3-4's "rules" half). `packages/node/src/permission-policy.ts`
 * owns the actual matching semantics (anchored `*`/`?` glob, deny always
 * wins, empty policy = allow-all — see that module's own doc comment);
 * this file only carries the same shape across the wire, plus one extra
 * `min(1)`-after-trim check per pattern so a blank rule is rejected at
 * entry (issue #751's "an invalid glob is rejected at entry, not at
 * enforcement time") rather than silently saved as a rule that can never
 * usefully match anything and, worse, turns an allow list into an
 * unsatisfiable strict allowlist the moment it's non-empty.
 *
 * There is no separate "default approval mode" field. `permission-policy.ts`'s
 * own semantics already define one per dimension — empty `allow` means
 * allow-all, a non-empty `allow` means "only these run" — so the default
 * is *derived* from the very same `allow`/`deny` lists this file carries,
 * never a second, independently-settable value that could drift from what
 * the node actually enforces. `PermissionPolicyPanel.svelte` computes and
 * shows it; it is not part of the wire payload.
 *
 * Two request/reply pairs plus one live notification, following the shape
 * `tracker.ts` (get/set/one shared response, all addressed by a stable
 * key) and `test-runner-config.ts` (session-routed, envelope-sealed
 * because the content is project-private) already use, rather than
 * inventing a third convention:
 * - `permission_policy_get` / `permission_policy_result` — read the
 *   saved policy ({@link EMPTY_PERMISSION_POLICY_V1} for a project with
 *   nothing saved yet, mirroring `PermissionPolicyStore.get()`'s own
 *   default). No envelope on the request: asking "which session's project"
 *   carries nothing to hide, same reasoning as `testRunnerConfigGet`.
 * - `permission_policy_set` / `permission_policy_result` — save the whole
 *   policy (never a partial patch — mirrors `PermissionPolicyStore.save()`'s
 *   own "creates or replaces... in full" contract, unlike
 *   `test_runner_config_set`'s per-key merge). Reuses the same
 *   `permission_policy_result` reply as `_get`.
 * - `permission_policy_violation` — node-to-client only, no request half
 *   (mirrors `run_output`/`terminal_output`): fired the instant a live
 *   command/terminal-line is actually denied, so a client can name the
 *   rule without scraping a terminal's ANSI banner or a run's free-text
 *   `run_exit.reason`. Carries {@link ToolRefusalReasonV1}, a
 *   discriminated union with exactly one member today
 *   (`kind: 'permission_policy'`) — the seam D3-4's "the UI must say
 *   which of the three layers refused it" needs: the profiles half
 *   (issue #752) adds its own `kind: 'profile'` member alongside this one
 *   rather than this file growing a second, parallel "why" field.
 *
 * Addressed by `sessionId` (the node resolves that session's `projectPath`
 * itself, exactly like `test-runner-config.ts`'s own doc comment already
 * documents `PermissionPolicyStore.get()` doing off
 * `bridge.session.projectPath`) rather than by `nodeId`+`projectPath` the
 * way `tracker.ts` addresses its per-project value — this config is only
 * ever edited from the Config panel inside an open session (SPEC §7.7),
 * which already has a `sessionId` at hand, and the policy itself never
 * needs to be read before any session on the project exists.
 */

/** A single glob pattern, `packages/node/src/permission-policy.ts`'s own anchored `*`/`?` language. Trimmed and rejected if blank — see this file's own doc comment. */
const globPattern = z.string().trim().min(1, 'a rule cannot be blank');

/** One dimension's allow/deny lists — `command` or `network`, mirrors `PermissionRuleSet`. */
export const permissionRuleSetV1 = z.object({
  allow: z.array(globPattern),
  deny: z.array(globPattern),
});
export type PermissionRuleSetV1 = z.infer<typeof permissionRuleSetV1>;

/** A project's full policy — mirrors `PermissionPolicy`. */
export const permissionPolicyV1 = z.object({
  command: permissionRuleSetV1,
  network: permissionRuleSetV1,
});
export type PermissionPolicyV1 = z.infer<typeof permissionPolicyV1>;

/** The documented default for a project with no saved policy — mirrors `EMPTY_PERMISSION_POLICY`. */
export const EMPTY_PERMISSION_POLICY_V1: PermissionPolicyV1 = {
  command: { allow: [], deny: [] },
  network: { allow: [], deny: [] },
};

/** The plaintext a `permission_policy_result` envelope decrypts to. */
export const permissionPolicyResultPayloadV1 = z.object({
  policy: permissionPolicyV1,
});
export type PermissionPolicyResultPayloadV1 = z.infer<typeof permissionPolicyResultPayloadV1>;

/** The plaintext a `permission_policy_set` envelope decrypts to. */
export const permissionPolicySetPayloadV1 = z.object({
  policy: permissionPolicyV1,
});
export type PermissionPolicySetPayloadV1 = z.infer<typeof permissionPolicySetPayloadV1>;

/** Parses and validates a decrypted `permission_policy_result` payload, throwing on an invalid one. */
export function parsePermissionPolicyResultPayloadV1(
  data: unknown,
): PermissionPolicyResultPayloadV1 {
  return permissionPolicyResultPayloadV1.parse(data);
}

/** Same as {@link parsePermissionPolicyResultPayloadV1} but never throws; returns zod's result. */
export function safeParsePermissionPolicyResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PermissionPolicyResultPayloadV1> {
  return permissionPolicyResultPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `permission_policy_set` payload, throwing on an invalid one. */
export function parsePermissionPolicySetPayloadV1(data: unknown): PermissionPolicySetPayloadV1 {
  return permissionPolicySetPayloadV1.parse(data);
}

/** Same as {@link parsePermissionPolicySetPayloadV1} but never throws; returns zod's result. */
export function safeParsePermissionPolicySetPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PermissionPolicySetPayloadV1> {
  return permissionPolicySetPayloadV1.safeParse(data);
}

/** A client asks the owning node for a session's project's saved permission policy. No envelope — see this file's doc comment. */
export const permissionPolicyGet = z.object({
  type: z.literal('permission_policy_get'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type PermissionPolicyGet = z.infer<typeof permissionPolicyGet>;

/** A client asks the owning node to save (fully replace) a session's project's permission policy. */
export const permissionPolicySet = z.object({
  type: z.literal('permission_policy_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PermissionPolicySet = z.infer<typeof permissionPolicySet>;

/** The owning node's reply to `permission_policy_get`/`permission_policy_set` — the project's current saved policy. Fanned out to a session's subscribed clients exactly like `test_runner_config_result`. */
export const permissionPolicyResult = z.object({
  type: z.literal('permission_policy_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PermissionPolicyResult = z.infer<typeof permissionPolicyResult>;

/**
 * Why a live tool call was refused (D3-4's "the UI must say which of the
 * three layers refused it" — see this file's own doc comment). A
 * discriminated union with exactly one member today rather than a bare
 * string, so the profiles half (issue #752) can add a `kind: 'profile'`
 * member alongside this one without reshaping it; a request-time
 * `reject_always` answer needs no member here at all, since that is
 * already a real, rendered ACP `permission_response`, never routed
 * through this type.
 */
export const toolRefusalReasonV1 = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission_policy'),
    dimension: z.enum(['command', 'network']),
    /** The glob pattern that decided this — mirrors `PolicyViolation.rule`. */
    rule: z.string().min(1),
    /** The specific candidate string the rule matched against — mirrors `PolicyViolation.matched`. */
    matched: z.string(),
  }),
]);
export type ToolRefusalReasonV1 = z.infer<typeof toolRefusalReasonV1>;

/** The plaintext a `permission_policy_violation` envelope decrypts to — one denied command/line, reported live. Mirrors `PolicyViolation`, minus `projectPath` (already implied by `sessionId`). */
export const permissionPolicyViolationPayloadV1 = z.object({
  reason: toolRefusalReasonV1,
  /** Which real chokepoint produced this — mirrors `PolicyViolation.surface`. */
  surface: z.enum(['exec', 'terminal']),
  /** The full original command/line, for the same reason `PolicyViolation.command` carries it node-side. */
  command: z.string(),
  timestamp: z.string(),
});
export type PermissionPolicyViolationPayloadV1 = z.infer<typeof permissionPolicyViolationPayloadV1>;

/** Parses and validates a decrypted `permission_policy_violation` payload, throwing on an invalid one. */
export function parsePermissionPolicyViolationPayloadV1(
  data: unknown,
): PermissionPolicyViolationPayloadV1 {
  return permissionPolicyViolationPayloadV1.parse(data);
}

/** Same as {@link parsePermissionPolicyViolationPayloadV1} but never throws; returns zod's result. */
export function safeParsePermissionPolicyViolationPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PermissionPolicyViolationPayloadV1> {
  return permissionPolicyViolationPayloadV1.safeParse(data);
}

/** The owning node reports one live policy denial (SPEC §7.17; issue #751). Fanned out to a session's subscribed clients exactly like `terminal_output`/`run_output` — no client-initiated counterpart, since nothing asks for this, it is pushed the instant it happens. */
export const permissionPolicyViolation = z.object({
  type: z.literal('permission_policy_violation'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PermissionPolicyViolation = z.infer<typeof permissionPolicyViolation>;
