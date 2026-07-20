/* ---------------------------------------------------------------------
 * Per-project and global agent plugin/extension configuration (SPEC.md
 * §7.7's "manage agent plugins/extensions"; issue #191). Mirrors
 * `./mcp-config.ts`'s shape and merge algorithm on purpose — a
 * `PluginConfigRecord` list resolves global-plus-project-overrides exactly
 * the way an `McpServerConfigRecord` list does — but is a genuinely
 * separate data model with its own type, its own store, and its own
 * resolver function. A project's plugin list and its MCP-server list are
 * two independent lists that happen to share a merge shape, never one
 * registry keyed only by name: a plugin and an MCP server can even declare
 * the same `name` without either one seeing or affecting the other (see
 * `plugin-config.test.ts`'s isolation test).
 *
 * Provider-agnostic on purpose, per §7.7: ACP itself has no `plugin`
 * concept distinct from the config it already carries into `session/new`
 * (MCP servers, permission modes, config options) — there is no ACP method
 * or field named "plugin" to model this against. Concretely, as of v1:
 *
 *   - **Claude Code**: the closest native concept is its own CLI
 *     plugin/marketplace mechanism, which loombox's ACP layer does not
 *     drive (ACP talks to the agent over stdio JSON-RPC, not the CLI's own
 *     plugin-install flow) — so today, "adding a plugin" here does not
 *     cause Claude Code to load anything extra; it's a config record
 *     loombox stores and resolves.
 *   - **Codex**: has no publicly documented plugin/extension mechanism at
 *     all beyond the MCP servers it already supports through ACP.
 *
 * So this module is a **forward-looking config surface**: it lets a
 * project's plugin/extension list be declared, viewed, added, removed, and
 * resolved (global + per-project) the same way MCP server config is, ready
 * for the day a provider's ACP adapter actually consumes it (the same way
 * `resolveMcpServerConfigs` feeds `AcpClient.newSession`, issue #190) —
 * but no such wiring exists yet, and this module makes no claim that it
 * does. A `PluginConfig`'s `source` is deliberately a free-form string
 * (a package name, a marketplace slug, a local path, a URL) rather than a
 * provider-specific shape, for the same "not modeled on any single CLI's
 * own format" reason `./mcp-config.ts` gives for MCP servers.
 * --------------------------------------------------------------------- */

/** One declared plugin/extension: a name plus where it comes from (a package name, marketplace slug, local path, or URL — deliberately free-form, see module doc). */
export interface PluginConfig {
  name: string;
  source: string;
}

/** A stored config record: the declared plugin plus whether it's currently enabled — same "record wraps config + enabled" shape as `McpServerConfigRecord`. */
export interface PluginConfigRecord {
  config: PluginConfig;
  enabled: boolean;
}

/** Thrown by `parsePluginConfig`/`parsePluginConfigList` for a malformed raw config entry — always names the offending field, and the entry's index when available. */
export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

function fail(context: string, message: string): never {
  throw new PluginConfigError(`Plugin config${context}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates one raw plugin config entry into a typed
 * `PluginConfig`, throwing `PluginConfigError` with a clear, actionable
 * message for a malformed entry. `index`, when given (from
 * `parsePluginConfigList`), is folded into the error context so a caller
 * can tell exactly which entry in a list failed.
 */
export function parsePluginConfig(raw: unknown, index?: number): PluginConfig {
  const listPosition = index === undefined ? '' : `[${index}]`;
  if (!isPlainObject(raw)) fail(listPosition, 'must be an object');

  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) {
    fail(listPosition, 'missing required field "name"');
  }
  const context = `${listPosition} ("${name}")`;

  const source = raw.source;
  if (typeof source !== 'string' || source.length === 0) {
    fail(context, 'missing required field "source"');
  }

  return { name, source };
}

/**
 * Parses and validates a raw plugin config list (e.g. a project's or the
 * global "add plugin" list, SPEC.md §7.7) into a typed `PluginConfig[]`.
 * Rejects a non-array top-level value, any malformed entry (see
 * `parsePluginConfig`), and a duplicate plugin name within the list, all
 * with `PluginConfigError`.
 */
export function parsePluginConfigList(raw: unknown): PluginConfig[] {
  if (!Array.isArray(raw)) fail('', 'expected an array of plugin config entries');

  const parsed = raw.map((entry, i) => parsePluginConfig(entry, i));

  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.name)) fail('', `duplicate plugin name "${entry.name}"`);
    seen.add(entry.name);
  }
  return parsed;
}

/**
 * Resolves a project's *effective* plugin/extension set as
 * global-plus-project-overrides — the same merge algorithm as
 * `resolveEffectiveMcpServers` (`./mcp-config.ts`), independently
 * implemented over `PluginConfigRecord` so the plugin list and the
 * MCP-server list never share a map or a resolution pass: every enabled
 * global plugin is included, except a project record for the same `name`
 * always wins outright (a project's own plugin, a project override of a
 * global plugin's source, or a project record with `enabled: false`
 * disabling an inherited global one). Only `enabled` records make it into
 * the result, in insertion order (globals first, then project additions).
 *
 * Storage/CRUD for these records is out of scope here, same as for MCP
 * server records — this is the pure merge algorithm a node (or, for now,
 * the web client's local config surface) calls over whatever it loaded.
 */
export function resolveEffectivePlugins(
  global: readonly PluginConfigRecord[],
  project: readonly PluginConfigRecord[],
): PluginConfig[] {
  const byName = new Map<string, PluginConfigRecord>();
  for (const record of global) byName.set(record.config.name, record);
  for (const record of project) byName.set(record.config.name, record);
  return [...byName.values()].filter((record) => record.enabled).map((record) => record.config);
}
