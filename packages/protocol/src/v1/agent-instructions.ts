import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Per-project agent instructions (SPEC §7.18; issue #260): surfaces and
 * edits a project's own `AGENTS.md`/`CLAUDE.md` — the file itself, read
 * from and written back to the session's real worktree, not a new store.
 * Two request/reply pairs, shaped after this package's existing
 * "read a real file"/"mutate a real file" precedents:
 *
 * - `agent_instructions_get_request`/`_response` mirrors `fs_read_request`/
 *   `fs_read_response` (`fs.ts`) — envelope-less request (asking carries no
 *   content, same reasoning `git_diff_request` documents), enveloped reply
 *   since the file's own text is real project content.
 * - `agent_instructions_set_request`/`_response` mirrors
 *   `git_hunk_action_request`/`_response` (`git-hunks.ts`) — enveloped on
 *   BOTH sides, since the request itself carries real content (the new
 *   text) rather than merely asking a question.
 *
 * `AGENTS.md`/`CLAUDE.md` both live at a project's worktree root
 * (`AGENTS.md` the emerging cross-tool convention, `CLAUDE.md` Claude
 * Code's own — this repo's own root carries both, the latter a one-line
 * `@AGENTS.md` import). `agent_instructions_get_response`'s `files` array
 * reports every one that actually exists right now (0, 1, or both) — the
 * client decides "offer to create" vs "let the user pick" from this
 * list's length, never a separate flag.
 *
 * The write side is optimistic-concurrency, not last-write-wins: every
 * `AgentInstructionsFileStateV1` carries a `hash` (this pair's own sha256
 * of `content` — `@loombox/node`'s `hashAgentInstructionsContent`), and a
 * `agent_instructions_set_request`'s `baseHash` must equal the file's
 * CURRENT hash (or be `null`, for a genuinely new file) or the node
 * refuses the write with a `'conflict'` outcome instead of clobbering
 * whatever changed underneath — this issue's own "never overwrite
 * blindly" acceptance line. `outcome: 'conflict'` carries `current`
 * (`null` if the file was deleted entirely) so a caller can show the user
 * what's actually on disk now rather than just "try again".
 */

export const agentInstructionsFileNameV1 = z.enum(['AGENTS.md', 'CLAUDE.md']);
export type AgentInstructionsFileNameV1 = z.infer<typeof agentInstructionsFileNameV1>;

/** One instructions file's current state as read from the project worktree root. `hash` is this pair's own optimistic-concurrency token — never a git blob hash or mtime, since a `local` and an `ssh:` target expose neither uniformly through `ExecutionTarget`. */
export const agentInstructionsFileStateV1 = z.object({
  fileName: agentInstructionsFileNameV1,
  content: z.string(),
  hash: z.string().min(1),
});
export type AgentInstructionsFileStateV1 = z.infer<typeof agentInstructionsFileStateV1>;

/** The successful outcome: every `AGENTS.md`/`CLAUDE.md` that exists at the project root right now. `[]` for a project with neither — never an error; the client's job to offer creating one. */
const agentInstructionsGetResultV1 = z.object({
  outcome: z.literal('ok'),
  files: z.array(agentInstructionsFileStateV1),
});

/** A failed read (the worktree itself isn't reachable, a transport failure against an `ssh:` target, ...) — carried as a payload variant rather than simply never replying, exactly like `fsReadErrorV1`. */
const agentInstructionsGetErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});

/** The plaintext an `agent_instructions_get_response` envelope decrypts to. */
export const agentInstructionsGetResponsePayloadV1 = z.discriminatedUnion('outcome', [
  agentInstructionsGetResultV1,
  agentInstructionsGetErrorV1,
]);
export type AgentInstructionsGetResponsePayloadV1 = z.infer<
  typeof agentInstructionsGetResponsePayloadV1
>;

/** Parses and validates a decrypted `agent_instructions_get_response` payload, throwing on an invalid one. */
export function parseAgentInstructionsGetResponsePayloadV1(
  data: unknown,
): AgentInstructionsGetResponsePayloadV1 {
  return agentInstructionsGetResponsePayloadV1.parse(data);
}

/** Same as {@link parseAgentInstructionsGetResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseAgentInstructionsGetResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, AgentInstructionsGetResponsePayloadV1> {
  return agentInstructionsGetResponsePayloadV1.safeParse(data);
}

/** A client asks the owning node for its session's project's current `AGENTS.md`/`CLAUDE.md` state. No envelope — see the file doc comment; routed to the owning node by `sessionId` alone, same as `git_diff_request`. */
export const agentInstructionsGetRequest = z.object({
  type: z.literal('agent_instructions_get_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type AgentInstructionsGetRequest = z.infer<typeof agentInstructionsGetRequest>;

/** The owning node's reply. Fanned out to a session's subscribed clients exactly like `fs_read_response` — a requesting client filters on `requestId`; any other subscribed client simply has no pending request with that id. */
export const agentInstructionsGetResponse = z.object({
  type: z.literal('agent_instructions_get_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type AgentInstructionsGetResponse = z.infer<typeof agentInstructionsGetResponse>;

/**
 * The plaintext an `agent_instructions_set_request` envelope decrypts to —
 * real project content, so unlike the get side, this request itself
 * travels sealed (mirrors `git_hunk_action_request`'s own enveloped-request
 * shape). `baseHash` is the `hash` this write's `content` was edited FROM:
 * the exact hash a prior `agent_instructions_get_response`/
 * `agent_instructions_set_response` last reported for `fileName`, or
 * `null` when `fileName` did not exist at the time editing started (a
 * create). The node re-reads `fileName` immediately before writing and
 * compares — a mismatch (including "it exists now but `baseHash: null`
 * expected none" or "it's gone but a hash was expected") means the file
 * changed underneath the edit, and the write is refused rather than
 * clobbering it.
 */
export const agentInstructionsSetRequestPayloadV1 = z.object({
  fileName: agentInstructionsFileNameV1,
  content: z.string(),
  baseHash: z.string().min(1).nullable(),
});
export type AgentInstructionsSetRequestPayloadV1 = z.infer<
  typeof agentInstructionsSetRequestPayloadV1
>;

/** Parses and validates a decrypted `agent_instructions_set_request` payload, throwing on an invalid one. */
export function parseAgentInstructionsSetRequestPayloadV1(
  data: unknown,
): AgentInstructionsSetRequestPayloadV1 {
  return agentInstructionsSetRequestPayloadV1.parse(data);
}

/** Same as {@link parseAgentInstructionsSetRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseAgentInstructionsSetRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, AgentInstructionsSetRequestPayloadV1> {
  return agentInstructionsSetRequestPayloadV1.safeParse(data);
}

/** The successful outcome: the write applied. `hash` is the new post-write hash — a caller uses it as the next `baseHash`, exactly like `agent_instructions_get_response`'s own per-file `hash`. */
const agentInstructionsSetResultV1 = z.object({
  outcome: z.literal('ok'),
  fileName: agentInstructionsFileNameV1,
  content: z.string(),
  hash: z.string().min(1),
});

/** The file changed underneath this write (or was deleted, or was created where `baseHash: null` expected none) — see the file doc comment. `current` is what is on disk RIGHT NOW, `null` if `fileName` no longer exists at all. */
const agentInstructionsSetConflictV1 = z.object({
  outcome: z.literal('conflict'),
  fileName: agentInstructionsFileNameV1,
  current: agentInstructionsFileStateV1.nullable(),
});

/** A failed write (the worktree isn't reachable, a permission error, a transport failure against an `ssh:` target, ...) — distinct from `'conflict'`, which is a legitimate business outcome, not a failure. */
const agentInstructionsSetErrorV1 = z.object({
  outcome: z.literal('error'),
  fileName: agentInstructionsFileNameV1,
  message: z.string().min(1),
});

/** The plaintext an `agent_instructions_set_response` envelope decrypts to. */
export const agentInstructionsSetResponsePayloadV1 = z.discriminatedUnion('outcome', [
  agentInstructionsSetResultV1,
  agentInstructionsSetConflictV1,
  agentInstructionsSetErrorV1,
]);
export type AgentInstructionsSetResponsePayloadV1 = z.infer<
  typeof agentInstructionsSetResponsePayloadV1
>;

/** Parses and validates a decrypted `agent_instructions_set_response` payload, throwing on an invalid one. */
export function parseAgentInstructionsSetResponsePayloadV1(
  data: unknown,
): AgentInstructionsSetResponsePayloadV1 {
  return agentInstructionsSetResponsePayloadV1.parse(data);
}

/** Same as {@link parseAgentInstructionsSetResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseAgentInstructionsSetResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, AgentInstructionsSetResponsePayloadV1> {
  return agentInstructionsSetResponsePayloadV1.safeParse(data);
}

/** A client asks the owning node to save (fully replace) one `AGENTS.md`/`CLAUDE.md` file inside one of its sessions' projects. Routed to the owning node exactly like `git_hunk_action_request` — the relay only ever sees `sessionId`/`requestId` plus this opaque `EncryptedEnvelope`; the file's new content, and which file, never reach the relay in the clear (SPEC §8's metadata boundary). */
export const agentInstructionsSetRequest = z.object({
  type: z.literal('agent_instructions_set_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type AgentInstructionsSetRequest = z.infer<typeof agentInstructionsSetRequest>;

/** The owning node's reply. Fanned out to a session's subscribed clients exactly like `agent_instructions_get_response` above. */
export const agentInstructionsSetResponse = z.object({
  type: z.literal('agent_instructions_set_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type AgentInstructionsSetResponse = z.infer<typeof agentInstructionsSetResponse>;
