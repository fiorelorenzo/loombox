import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * The `mcp_prompt_get_request`/`mcp_prompt_get_response` pair (Zed-parity
 * decision D5-2, issue #754): once a session's `mcp_server_prompts`
 * lifecycle event (`session-events.ts`) has told a client which MCP
 * servers declared which prompts, selecting one still needs the server's
 * own rendered message text — `prompts/list`'s catalogue is metadata only,
 * the actual content is a live `prompts/get` round trip (MCP's own split,
 * unrelated to ACP). The node is the only thing that can make that round
 * trip (it already resolved this session's MCP server configs — secrets
 * included — to launch them in the first place), so this is a real
 * request/response pair, not a fire-and-forget event.
 *
 * Modeled directly on `fs.ts`'s `fs_list_request`/`fs_list_response`: same
 * `sessionId` + `requestId` + single `envelope` field sealed under the
 * session's derived key, same relay treatment (`relay.ts` routes the
 * request to the owning node via `routeToOwningNode` and fans the response
 * out to the session's subscribed clients via `fanOutDirect`, opening
 * neither envelope — SPEC §8's metadata boundary: which server/prompt a
 * user invoked, and what it rendered, are both private).
 */

/**
 * The plaintext an `mcp_prompt_get_request` envelope decrypts to: which
 * server + prompt to render, and the argument values to substitute.
 * `arguments` is already resolved client-side against that prompt's own
 * declared argument names (`@loombox/providers-core`'s
 * `AcpAvailableCommand.mcpArguments`, carried by the same
 * `mcp_server_prompts` push this request follows) — the node never parses
 * free-form text into named arguments itself, the same "the client owns
 * its own argument semantics" convention `available_commands_update`'s
 * agent-declared commands already follow (issue #743's `SlashCommandPicker`
 * doc comment: "never parsed, validated, or inserted as literal text").
 * Omitted/`{}` for a prompt that declares no arguments at all.
 */
export const mcpPromptGetRequestPayloadV1 = z.object({
  serverName: z.string().min(1),
  promptName: z.string().min(1),
  arguments: z.record(z.string(), z.string()).optional(),
});
export type McpPromptGetRequestPayloadV1 = z.infer<typeof mcpPromptGetRequestPayloadV1>;

/** The successful outcome: the server's own rendered prompt text, ready to send as an ordinary user turn. */
export const mcpPromptGetResultV1 = z.object({
  outcome: z.literal('ok'),
  text: z.string(),
});
export type McpPromptGetResultV1 = z.infer<typeof mcpPromptGetResultV1>;

/**
 * A failed render — the server is unreachable, rejected the call (e.g. a
 * required argument this client didn't supply), or no longer matches
 * `mcpServersBySession`'s resolved config (a node restart between the
 * catalogue push and this request). A caller falls back to sending the
 * user's raw typed text rather than blocking the send outright — see
 * `+page.svelte`'s `resolveMcpPromptSend` doc comment.
 */
export const mcpPromptGetErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
export type McpPromptGetErrorV1 = z.infer<typeof mcpPromptGetErrorV1>;

/** The plaintext an `mcp_prompt_get_response` envelope decrypts to. */
export const mcpPromptGetResponsePayloadV1 = z.discriminatedUnion('outcome', [
  mcpPromptGetResultV1,
  mcpPromptGetErrorV1,
]);
export type McpPromptGetResponsePayloadV1 = z.infer<typeof mcpPromptGetResponsePayloadV1>;

/** Parses and validates a decrypted `mcp_prompt_get_request` payload, throwing on an invalid one. */
export function parseMcpPromptGetRequestPayloadV1(data: unknown): McpPromptGetRequestPayloadV1 {
  return mcpPromptGetRequestPayloadV1.parse(data);
}

/** Same as {@link parseMcpPromptGetRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseMcpPromptGetRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, McpPromptGetRequestPayloadV1> {
  return mcpPromptGetRequestPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `mcp_prompt_get_response` payload, throwing on an invalid one. */
export function parseMcpPromptGetResponsePayloadV1(data: unknown): McpPromptGetResponsePayloadV1 {
  return mcpPromptGetResponsePayloadV1.parse(data);
}

/** Same as {@link parseMcpPromptGetResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseMcpPromptGetResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, McpPromptGetResponsePayloadV1> {
  return mcpPromptGetResponsePayloadV1.safeParse(data);
}

/**
 * A client asks the owning node to render one MCP server's declared
 * prompt (SPEC §7.7/§7.24; issue #754). Routed exactly like
 * `fs_list_request` (`relay.ts`'s `routeToOwningNode`) — `sessionId` alone
 * is enough to find the owning node.
 */
export const mcpPromptGetRequest = z.object({
  type: z.literal('mcp_prompt_get_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type McpPromptGetRequest = z.infer<typeof mcpPromptGetRequest>;

/**
 * The owning node's reply. Fanned out to a session's subscribed clients
 * exactly like `fs_list_response` (`relay.ts`'s `fanOutDirect`) — a
 * requesting client matches its own pending request by `requestId`; any
 * other subscribed client simply has no pending request with that id and
 * ignores it.
 */
export const mcpPromptGetResponse = z.object({
  type: z.literal('mcp_prompt_get_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type McpPromptGetResponse = z.infer<typeof mcpPromptGetResponse>;
