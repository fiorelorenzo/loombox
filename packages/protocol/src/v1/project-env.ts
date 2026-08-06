import { z } from 'zod';

/* ---------------------------------------------------------------------
 * The wire shape of one client-declared project env-var injection (issue
 * #258), carried inside `sessions.ts`'s `sessionPrivateMetaV1.projectEnvDecls`
 * — never in the clear, always inside the session's encrypted private
 * envelope, same boundary `title`/`projectPath`/`mcpServerConfigs` already
 * cross.
 *
 * Deliberately identical in shape to `mcp-servers.ts`'s `mcpServerVarDeclV1`
 * (mirrors `@loombox/providers-core`'s `McpServerVarDecl`/`ProjectEnvVarDecl`
 * field-for-field rather than importing it — same "no dependency beyond zod"
 * reason `mcpServerVarDeclV1`'s own doc comment gives), not reused directly:
 * a project env-var declaration and an MCP server's env/header declaration
 * are genuinely separate wire concepts that happen to share a shape, the
 * same "two independent lists, one merge shape" split `plugin-config.ts`
 * draws against `mcp-config.ts`.
 *
 * `@loombox/node`'s `NodeDaemon` re-validates a wire decl through
 * `@loombox/providers-core`'s `ProjectEnvVarDecl` before treating it as
 * domain data (mirrors `parseClientDeclaredMcpServers`'s identical
 * degrade-one-entry convention) and resolves it via `NodeProjectEnvManager`
 * — this schema's job is only to reject a structurally malformed entry
 * before that resolution ever sees it.
 * --------------------------------------------------------------------- */

/** One declared project env var — mirrors `ProjectEnvVarDecl`. Exactly one of `value`/`secret` is present; a secret's actual value never travels here, only the name of the secret this var needs granted node-side for direct agent-env injection (SPEC §7.17, §8). */
export const projectEnvVarDeclV1 = z.union([
  z.object({ name: z.string().min(1), value: z.string() }).strict(),
  z.object({ name: z.string().min(1), secret: z.string().min(1) }).strict(),
]);
export type ProjectEnvVarDeclV1 = z.infer<typeof projectEnvVarDeclV1>;

/** Parses and validates a decrypted `projectEnvDecls` list entry-by-entry, throwing on the first malformed one. */
export function parseProjectEnvVarDeclV1(data: unknown): ProjectEnvVarDeclV1 {
  return projectEnvVarDeclV1.parse(data);
}

/** Same as {@link parseProjectEnvVarDeclV1} but never throws; returns zod's result. */
export function safeParseProjectEnvVarDeclV1(
  data: unknown,
): z.SafeParseReturnType<unknown, ProjectEnvVarDeclV1> {
  return projectEnvVarDeclV1.safeParse(data);
}
