/* ---------------------------------------------------------------------
 * Quick-add MCP server presets (SPEC.md §7.7's "quick-add presets"; issue
 * #188). A small starter catalog of common MCP servers, each a literal
 * `McpServerConfig` (name, command/args or a remote URL, plus any declared
 * required secrets) — the same raw shape a hand-entered server would use.
 *
 * Deliberately *not* a special downstream code path: `instantiateMcpPreset`
 * does nothing but hand `preset.config` to `parseMcpServerConfig`, the
 * exact validator a hand-typed raw config object goes through on its way
 * into a `McpServerConfigRecord`. So "adding a preset produces the same
 * config record shape a hand-entered server would" isn't a convention this
 * module has to maintain by hand — it's enforced structurally: there is no
 * `McpServerConfig`-shaped-but-different preset type, and the catalog
 * itself is asserted (in `mcp-presets.test.ts`) to parse cleanly through
 * that same validator.
 *
 * A preset that declares a required secret (`McpServerVarDecl`'s `{ name,
 * secret }` arm) can never carry a literal `value` for that same variable —
 * that's a property of the discriminated union in `./mcp-config.ts`, not
 * something this module enforces itself — so a secret-requiring preset is
 * structurally incapable of pre-filling a secret value. Once added, such a
 * server's env var/header stays unresolved until it's granted through the
 * ordinary per-server secret-grant mechanism (`./mcp-secret-grants.ts`,
 * issue #189); this module has no opinion on grants at all.
 *
 * The catalog cites real, publicly documented MCP servers (the reference
 * servers under github.com/modelcontextprotocol/servers, plus Context7's
 * hosted remote server this very repo's tooling uses) so the commands/URLs
 * are illustrative of a real add, not placeholders — but loombox does not
 * vendor or execute any of their code itself; a preset is only ever a
 * config *declaration* a user chooses to add.
 * --------------------------------------------------------------------- */

import { parseMcpServerConfig, type McpServerConfig } from './mcp-config';

/**
 * One quick-add catalog entry: a human-readable blurb for the UI, plus the
 * literal `McpServerConfig` it expands to. `config` is not a preset-only
 * type — it's the exact same `McpServerConfig` a manual "add server" form
 * produces, which is what lets `instantiateMcpPreset` be a one-liner.
 */
export interface McpServerPreset {
  /** Short blurb shown next to the preset's name in the quick-add UI. */
  description: string;
  /** The literal server config this preset adds, verbatim (see module doc). */
  config: McpServerConfig;
}

/**
 * The starter catalog (SPEC.md §7.7). Small and deliberately unopinionated
 * about a project's actual filesystem paths or endpoints — each preset's
 * `args`/`url` are the documented defaults for that server; a user can
 * still hand-edit the resulting record after adding it, the same as any
 * manually entered one.
 */
export const MCP_SERVER_PRESET_CATALOG: readonly McpServerPreset[] = [
  {
    description:
      'Read/write access to a local directory tree, via the reference filesystem server.',
    config: {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: [],
    },
  },
  {
    description: 'Fetch and convert web pages to markdown for the agent to read.',
    config: {
      name: 'fetch',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      env: [],
    },
  },
  {
    description: 'Inspect and operate on a local git repository (log, diff, status, commit).',
    config: {
      name: 'git',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git'],
      env: [],
    },
  },
  {
    description:
      'GitHub issues, PRs, and repo content via the reference GitHub server. Needs a personal access token.',
    config: {
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', secret: 'github-personal-access-token' }],
    },
  },
  {
    description: 'Read-only queries against a Postgres database. Needs a connection string.',
    config: {
      name: 'postgres',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: [{ name: 'DATABASE_URL', secret: 'postgres-database-url' }],
    },
  },
  {
    description:
      "Context7's hosted remote server: up-to-date library/framework docs. Needs an API key.",
    config: {
      name: 'context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: [{ name: 'CONTEXT7_API_KEY', secret: 'context7-api-key' }],
    },
  },
];

/**
 * Expands a preset into a fresh `McpServerConfig`, by routing it through
 * `parseMcpServerConfig` — the exact same validator a hand-entered raw
 * config object goes through. This is the whole mechanism: presets are not
 * a special downstream code path, only a pre-filled starting point for the
 * ordinary add-server flow (a caller still wraps the result in a
 * `McpServerConfigRecord` and, if it declares a required secret, still
 * routes through the ordinary per-server secret-grant prompt before that
 * secret resolves).
 */
export function instantiateMcpPreset(preset: McpServerPreset): McpServerConfig {
  return parseMcpServerConfig(JSON.parse(JSON.stringify(preset.config)));
}
