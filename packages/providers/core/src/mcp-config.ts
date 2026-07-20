/* ---------------------------------------------------------------------
 * The MCP server configuration data model (SPEC.md §7.7; issue #187): how
 * a user *declares* an MCP server, decoupled from where that declaration
 * is stored. A node loads a raw config (JSON from disk, a database row,
 * whatever it uses — out of scope here) and hands it to
 * `parseMcpServerConfigList` to get back the typed, validated
 * `McpServerConfig[]` this module and `resolveMcpServerConfigs` (see
 * `./mcp-secret-grants.ts`, issue #189) understand.
 *
 * Deliberately *not* modeled on any single CLI's own MCP config file
 * format (SPEC.md §7.7's "generalized across providers through the ACP
 * layer"): the shape here is a declaration-time superset of ACP's own
 * `McpServer` union (`./types.ts`'s `AcpMcpServerConfig`, grounded in
 * agentclientprotocol.com/protocol/schema) — the one addition is that an
 * env var / header can name a required *secret* instead of carrying a
 * literal value, so a config can be committed to a project/global store
 * without any secret value ever living inside it. `resolveMcpServerConfigs`
 * is what turns a `McpServerConfig` into the plain `AcpMcpServerConfig`
 * `AcpClient.newSession` actually consumes.
 * --------------------------------------------------------------------- */

/**
 * One declared env var (`stdio`) or HTTP header (`http`/`sse`): either a
 * literal, non-secret `value`, or a `secret` naming the project/global
 * secret this variable must be granted before it can resolve (issue #189).
 * Exactly one of the two is present — never both, never neither — so a
 * parsed config can never accidentally ship a secret name and a literal
 * value for the same variable.
 */
export type McpServerVarDecl = { name: string; value: string } | { name: string; secret: string };

interface McpServerConfigBase {
  name: string;
}

/** The `stdio` transport — the one every ACP agent must support. */
export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: 'stdio';
  command: string;
  args: string[];
  env: McpServerVarDecl[];
}

/** The `http` transport — gated at session time on the agent's `mcpCapabilities.http`. */
export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: 'http';
  url: string;
  headers: McpServerVarDecl[];
}

/** The `sse` transport — gated at session time on the agent's `mcpCapabilities.sse`. */
export interface McpSseServerConfig extends McpServerConfigBase {
  transport: 'sse';
  url: string;
  headers: McpServerVarDecl[];
}

/** One declared MCP server config entry, in any of the three ACP transports. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

/** A stored config record: the declared server plus whether it's currently enabled (SPEC.md §7.7's "add and enable MCP servers"). */
export interface McpServerConfigRecord {
  config: McpServerConfig;
  enabled: boolean;
}

/** Thrown by `parseMcpServerConfig`/`parseMcpServerConfigList` for a malformed raw config entry — always names the offending field, and the entry's index + server name when available. */
export class McpServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpServerConfigError';
  }
}

function fail(context: string, message: string): never {
  throw new McpServerConfigError(`MCP server config${context}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVarDecl(raw: unknown, listContext: string, index: number): McpServerVarDecl {
  const context = `${listContext}[${index}]`;
  if (!isPlainObject(raw)) fail(context, 'must be an object');

  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) {
    fail(context, 'missing required field "name"');
  }

  const hasValue = 'value' in raw;
  const hasSecret = 'secret' in raw;
  if (hasValue === hasSecret) {
    fail(context, `"${name}" must declare exactly one of "value" or "secret"`);
  }

  if (hasValue) {
    if (typeof raw.value !== 'string') fail(context, `"${name}".value must be a string`);
    return { name, value: raw.value };
  }

  if (typeof raw.secret !== 'string' || raw.secret.length === 0) {
    fail(context, `"${name}".secret must be a non-empty string naming the required secret`);
  }
  return { name, secret: raw.secret };
}

function parseVarDeclList(raw: unknown, listContext: string, field: string): McpServerVarDecl[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(listContext, `"${field}" must be an array`);
  return raw.map((entry, i) => parseVarDecl(entry, `${listContext}.${field}`, i));
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses and validates one raw MCP server config entry into a typed
 * `McpServerConfig`, throwing `McpServerConfigError` with a clear,
 * actionable message for a malformed entry. `index`, when given (from
 * `parseMcpServerConfigList`), is folded into the error context so a
 * caller can tell exactly which entry in a list failed.
 */
export function parseMcpServerConfig(raw: unknown, index?: number): McpServerConfig {
  const listPosition = index === undefined ? '' : `[${index}]`;
  if (!isPlainObject(raw)) fail(listPosition, 'must be an object');

  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) {
    fail(listPosition, 'missing required field "name"');
  }
  const context = `${listPosition} ("${name}")`;

  const transport = raw.transport;
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    fail(
      context,
      `"transport" must be one of "stdio" | "http" | "sse", got ${JSON.stringify(transport ?? null)}`,
    );
  }

  if (transport === 'stdio') {
    const command = raw.command;
    if (typeof command !== 'string' || command.length === 0) {
      fail(context, 'missing required field "command" for transport "stdio"');
    }
    const argsRaw = raw.args;
    if (
      argsRaw !== undefined &&
      (!Array.isArray(argsRaw) || !argsRaw.every((a) => typeof a === 'string'))
    ) {
      fail(context, '"args" must be an array of strings');
    }
    const env = parseVarDeclList(raw.env, context, 'env');
    return {
      name,
      transport: 'stdio',
      command,
      args: argsRaw === undefined ? [] : [...argsRaw],
      env,
    };
  }

  // http | sse share the same shape.
  const url = raw.url;
  if (typeof url !== 'string' || url.length === 0) {
    fail(context, `missing required field "url" for transport "${transport}"`);
  }
  if (!isValidUrl(url)) {
    fail(context, `"url" is not a valid URL: ${JSON.stringify(url)}`);
  }
  const headers = parseVarDeclList(raw.headers, context, 'headers');
  return { name, transport, url, headers };
}

/**
 * Parses and validates a raw MCP server config list (e.g. a project's or
 * the global "add MCP server" list, SPEC.md §7.7) into a typed
 * `McpServerConfig[]`. Rejects a non-array top-level value, any malformed
 * entry (see `parseMcpServerConfig`), and a duplicate server name within
 * the list, all with `McpServerConfigError`.
 */
export function parseMcpServerConfigList(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) fail('', 'expected an array of MCP server config entries');

  const parsed = raw.map((entry, i) => parseMcpServerConfig(entry, i));

  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.name)) fail('', `duplicate MCP server name "${entry.name}"`);
    seen.add(entry.name);
  }
  return parsed;
}

/** The distinct named secrets one server's env vars/headers declare it needs (issue #187/#189). */
export function requiredSecrets(config: McpServerConfig): string[] {
  const vars = config.transport === 'stdio' ? config.env : config.headers;
  const names = new Set<string>();
  for (const v of vars) {
    if ('secret' in v) names.add(v.secret);
  }
  return [...names];
}

/** The union of every distinct named secret required across a whole config list. */
export function requiredSecretsForList(configs: readonly McpServerConfig[]): string[] {
  const names = new Set<string>();
  for (const config of configs) {
    for (const secret of requiredSecrets(config)) names.add(secret);
  }
  return [...names];
}

/**
 * Resolves a project's *effective* MCP server set as global-plus-project-
 * overrides (SPEC.md §7.7 / issue #187's second acceptance bullet): every
 * enabled global server is included, except a project record for the same
 * `name` always wins outright (whether that's a project's own server, a
 * project override of a global server's config, or a project record with
 * `enabled: false` disabling an inherited global one). Only `enabled`
 * records make it into the result, in insertion order (globals first, then
 * project additions).
 *
 * Storage/CRUD for these records (create/list/enable/disable, persistence
 * across a node restart) is a `packages/node` concern (issue #187, out of
 * scope in this provider-agnostic package) — this function is the pure
 * merge algorithm a node calls over whatever it loaded.
 */
export function resolveEffectiveMcpServers(
  global: readonly McpServerConfigRecord[],
  project: readonly McpServerConfigRecord[],
): McpServerConfig[] {
  const byName = new Map<string, McpServerConfigRecord>();
  for (const record of global) byName.set(record.config.name, record);
  for (const record of project) byName.set(record.config.name, record);
  return [...byName.values()].filter((record) => record.enabled).map((record) => record.config);
}
