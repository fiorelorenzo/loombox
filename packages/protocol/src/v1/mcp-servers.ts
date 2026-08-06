import { z } from 'zod';

/* ---------------------------------------------------------------------
 * The wire shape of one client-declared MCP server config (issue #750,
 * D2-2), carried inside `sessions.ts`'s `sessionPrivateMetaV1.mcpServerConfigs`
 * — never in the clear, always inside the session's encrypted private
 * envelope, same boundary `title`/`projectPath` already cross.
 *
 * Deliberately mirrors `@loombox/providers-core`'s `McpServerConfig`
 * union (`mcp-config.ts`) field-for-field rather than importing it:
 * `@loombox/protocol` has no dependencies beyond `zod` (see this
 * package's own `package.json`) and `@loombox/providers-core` isn't one
 * of them, the same reason `session-events.ts`'s `acpConfigOptionV1`
 * already mirrors that package's `AcpConfigOption` instead of importing
 * it. `@loombox/node` is the one place both types exist together
 * (`mcp-config-store.ts`'s `McpConfigStore` + this schema's parsed
 * output); it re-validates a wire config through
 * `parseMcpServerConfig`/`parseMcpServerConfigList` before treating it as
 * a real `McpServerConfig` — this schema's job is only to reject a
 * structurally malformed entry before that domain-level parse ever sees
 * it, and to give every peer a shared, versioned wire contract for the
 * shape in the meantime.
 *
 * This is one half of "the two config stores stop being two: one
 * resolution path" (issue #750's acceptance): the client's per-project
 * `localStorage` list (`apps/web`'s `mcp-server-store.ts`) travels here at
 * `session_create` time, and `NodeDaemon.resolveMcpServers` merges it with
 * this node's own persisted `McpConfigStore` (global + project) into the
 * one effective, deduplicated list a session's `AcpClient.newSession`
 * actually receives — see that method's own doc comment for the merge
 * direction and why.
 * --------------------------------------------------------------------- */

/** One declared env var (`stdio`) or HTTP header (`http`/`sse`) — mirrors `McpServerVarDecl`. Exactly one of `value`/`secret` is present; a secret's actual value never travels here, only the name of the secret this variable needs granted node-side (SPEC §7.17). */
export const mcpServerVarDeclV1 = z.union([
  z.object({ name: z.string().min(1), value: z.string() }).strict(),
  z.object({ name: z.string().min(1), secret: z.string().min(1) }).strict(),
]);
export type McpServerVarDeclV1 = z.infer<typeof mcpServerVarDeclV1>;

/** The `stdio` transport — mirrors `McpStdioServerConfig`. */
export const mcpStdioServerConfigV1 = z.object({
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.array(mcpServerVarDeclV1),
});
export type McpStdioServerConfigV1 = z.infer<typeof mcpStdioServerConfigV1>;

/** The `http` transport — mirrors `McpHttpServerConfig`. */
export const mcpHttpServerConfigV1 = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.string().min(1),
  headers: z.array(mcpServerVarDeclV1),
});
export type McpHttpServerConfigV1 = z.infer<typeof mcpHttpServerConfigV1>;

/** The `sse` transport — mirrors `McpSseServerConfig`. */
export const mcpSseServerConfigV1 = z.object({
  name: z.string().min(1),
  transport: z.literal('sse'),
  url: z.string().min(1),
  headers: z.array(mcpServerVarDeclV1),
});
export type McpSseServerConfigV1 = z.infer<typeof mcpSseServerConfigV1>;

/** One declared MCP server config entry, in any of the three ACP transports — mirrors `McpServerConfig`. */
export const mcpServerConfigV1 = z.discriminatedUnion('transport', [
  mcpStdioServerConfigV1,
  mcpHttpServerConfigV1,
  mcpSseServerConfigV1,
]);
export type McpServerConfigV1 = z.infer<typeof mcpServerConfigV1>;

/** Parses and validates a decrypted `mcpServerConfigs` list entry-by-entry, throwing on the first malformed one. */
export function parseMcpServerConfigV1(data: unknown): McpServerConfigV1 {
  return mcpServerConfigV1.parse(data);
}

/** Same as {@link parseMcpServerConfigV1} but never throws; returns zod's result. */
export function safeParseMcpServerConfigV1(
  data: unknown,
): z.SafeParseReturnType<unknown, McpServerConfigV1> {
  return mcpServerConfigV1.safeParse(data);
}
