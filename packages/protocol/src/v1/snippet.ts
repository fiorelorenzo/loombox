import { z } from 'zod';

import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for `@loombox/node`'s named prompt/snippet catalog (SPEC
 * §7.18's "reusable prompt/snippet library" clause; issue #261, epic #29).
 *
 * A snippet is genuinely distinct from every composer mechanism it sits
 * next to, not a fourth parallel one:
 * - `session-template.ts`'s `SessionTemplateV1` (issue #259) carries the
 *   session-*creation* choices (target, provider, agent, worktree, an
 *   optional default session `title`) — it has no field for arbitrary
 *   prompt text at all, so a snippet cannot be "the difference" folded
 *   into that type; it fills a gap templates never covered.
 * - The `/`-command picker (issue #743) is the connected AGENT's own
 *   declared catalogue (`available_commands_update`), never persisted by
 *   loombox and never user-authored — a snippet is the opposite: a plain
 *   user-authored catalogue, persisted here, inserted verbatim.
 * - `@`-mentions (issue #742) resolve to a live reference (a file,
 *   directory, session, tracker item) rendered as a pill, never literal
 *   text in the draft. A snippet is exactly the opposite: it inserts its
 *   own `text`, byte for byte, into the composer's plain-text draft —
 *   there is nothing for it to resolve or go stale against.
 *
 * One catalog request/reply pair, following `agent-profile.ts`'s own
 * catalog half precedent (itself following `permission-policy.ts`'s) —
 * no per-session "active" half like that file's `agent_profile_session_*`
 * pair, since a snippet has no notion of being "active" for a session, only
 * inserted on demand:
 * - `snippet_list_get` / `snippet_list_result` — read the full saved
 *   catalog (`[]` for a node with nothing saved yet, mirroring
 *   `SnippetStore.list()`'s own default). No envelope on the request —
 *   same "nothing to hide about which session is asking" reasoning
 *   `agent_profile_list_get` already documents.
 * - `snippet_list_set` / `snippet_list_result` — save the whole catalog
 *   (never a partial patch — mirrors `SnippetStore.saveAll()`'s own
 *   "creates or replaces... in full" contract). Reuses the same
 *   `snippet_list_result` reply as `_get`.
 *
 * `_set` is envelope-sealed (a saved prompt is conversation-adjacent
 * content, opaque to the relay for the same reason an agent profile's own
 * name/rules are); `_get` carries nothing sealed, same as every other
 * catalog `_get` in this package.
 *
 * Addressed by `sessionId` (the node resolves the owning account itself)
 * exactly like `agent_profile_list_get`'s own doc comment documents — the
 * composer this catalog is read from and written from always has a live
 * session open, unlike `session-template.ts`'s `NewSessionDialog` context,
 * which predates any session and so needs `nodeId`+`targetId` instead.
 */

/** One saved prompt/snippet. */
export const snippetV1 = z.object({
  id: z.string().min(1),
  /** The snippet's own display name/label, shown in the picker and searched alongside `text`. */
  name: z.string().trim().min(1),
  /** The literal prompt text inserted into the composer verbatim — never trimmed, since leading/trailing whitespace (e.g. a trailing newline) can be part of the authored prompt. */
  text: z.string().min(1),
});
export type SnippetV1 = z.infer<typeof snippetV1>;

/** The plaintext a `snippet_list_result` envelope decrypts to. */
export const snippetListResultPayloadV1 = z.object({
  snippets: z.array(snippetV1),
});
export type SnippetListResultPayloadV1 = z.infer<typeof snippetListResultPayloadV1>;

/** The plaintext a `snippet_list_set` envelope decrypts to. */
export const snippetListSetPayloadV1 = z.object({
  snippets: z.array(snippetV1),
});
export type SnippetListSetPayloadV1 = z.infer<typeof snippetListSetPayloadV1>;

/** Parses and validates a decrypted `snippet_list_result` payload, throwing on an invalid one. */
export function parseSnippetListResultPayloadV1(data: unknown): SnippetListResultPayloadV1 {
  return snippetListResultPayloadV1.parse(data);
}

/** Same as {@link parseSnippetListResultPayloadV1} but never throws; returns zod's result. */
export function safeParseSnippetListResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SnippetListResultPayloadV1> {
  return snippetListResultPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `snippet_list_set` payload, throwing on an invalid one. */
export function parseSnippetListSetPayloadV1(data: unknown): SnippetListSetPayloadV1 {
  return snippetListSetPayloadV1.parse(data);
}

/** Same as {@link parseSnippetListSetPayloadV1} but never throws; returns zod's result. */
export function safeParseSnippetListSetPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SnippetListSetPayloadV1> {
  return snippetListSetPayloadV1.safeParse(data);
}

/** A client asks the owning node for its account's saved snippet catalog. No envelope — see this file's doc comment. */
export const snippetListGet = z.object({
  type: z.literal('snippet_list_get'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type SnippetListGet = z.infer<typeof snippetListGet>;

/** A client asks the owning node to save (fully replace) its account's snippet catalog. */
export const snippetListSet = z.object({
  type: z.literal('snippet_list_set'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SnippetListSet = z.infer<typeof snippetListSet>;

/** The owning node's reply to `snippet_list_get`/`snippet_list_set` — the account's current saved catalog. */
export const snippetListResult = z.object({
  type: z.literal('snippet_list_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SnippetListResult = z.infer<typeof snippetListResult>;
