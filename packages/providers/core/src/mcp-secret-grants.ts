/* ---------------------------------------------------------------------
 * Per-server MCP secret grants (SPEC.md §7.7, §7.17; issue #189). Novel:
 * SPEC.md §16 flags this as "no reference implementation to copy — define
 * ACL/approval semantics fresh."
 *
 * "An added MCP server receives project secrets only by explicit per-server
 * grant, never automatically" (§7.7) — `McpSecretGrantStore` is that ACL: a
 * server gets a secret only through a deliberate `grant()` call, keyed by
 * (server name, secret name), so revoking one grant can never affect
 * another server's grant on the same secret, or the same server's grant on
 * a different secret.
 *
 * `resolveMcpServerConfigs` is where a grant actually takes effect: it
 * turns a declared `McpServerConfig` list (`./mcp-config.ts`) into the
 * plain `AcpMcpServerConfig` list `AcpClient.newSession` consumes,
 * substituting each `{ secret }` variable with its granted value and
 * failing fast — before any session opens — the moment a referenced secret
 * isn't both granted and available.
 *
 * §7.17's node-local-secrets rule ("secret/env injection... that never
 * reaches the relay or clients") is why this function's `secretValues`
 * parameter must only ever be sourced from, and called with, the executing
 * node's own local secret storage: this module does no network I/O and
 * never logs a resolved value, so that property holds as long as the
 * caller keeps `secretValues` node-local too.
 *
 * Once a session is running, an MCP server's tool output is still
 * untrusted *input* (§7.7, §7.17), never an operator instruction — the same
 * rule tracker/issue content is held to (§7.17's "Untrusted content").
 * Nothing about being granted a secret changes that.
 * --------------------------------------------------------------------- */

import type { McpServerConfig, McpServerVarDecl } from './mcp-config';
import type { AcpMcpKeyValue, AcpMcpServerConfig } from './types';

/**
 * Thrown when a configured MCP server declares an env var (`stdio`) or header
 * (`http`/`sse`) whose per-server secret grant (issue #189) hasn't resolved yet
 * (`value: undefined`) — session creation fails up front with this clear,
 * actionable error instead of starting the agent silently without the secret it
 * asked for (SPEC.md §7.7's second acceptance bullet). No `session/new` request
 * is ever sent in this case.
 *
 * Lives here, beside the grant logic that raises it, rather than in `client.ts`
 * where it started: this module is browser-safe and `client.ts` is not (it
 * spawns the agent), so importing the class back out of `client.ts` dragged the
 * whole Node-only graph — `node:child_process`, and fatally
 * `node:events` — into any client bundle that touched secret grants. `AcpClient`
 * still throws it, now importing it from here.
 */
export class McpServerSecretMissingError extends Error {
  constructor(
    readonly serverName: string,
    readonly variableName: string,
  ) {
    super(
      `AcpClient.newSession: MCP server "${serverName}" is missing a required secret grant ` +
        `for "${variableName}" — grant it before starting a session.`,
    );
    this.name = 'McpServerSecretMissingError';
  }
}

function grantKey(serverName: string, secretName: string): string {
  return `${serverName} ${secretName}`;
}

/**
 * The explicit per-(server, secret) grant ACL. Starts empty: no server is
 * ever granted a secret on creation. Intentionally project-agnostic — the
 * caller (a node, out of scope in this package) is expected to hold one
 * store per project, the same way it holds one `McpServerConfig` list per
 * project, so SPEC.md's (project, server, secret) tuple becomes (server,
 * secret) here.
 */
export class McpSecretGrantStore {
  private readonly granted = new Set<string>();

  /** Grants `serverName` access to `secretName`. A distinct, explicit action; never implied by config creation. */
  grant(serverName: string, secretName: string): void {
    this.granted.add(grantKey(serverName, secretName));
  }

  /** Revokes `serverName`'s access to `secretName`, if granted. Never touches any other (server, secret) grant. A no-op if it wasn't granted. */
  revoke(serverName: string, secretName: string): void {
    this.granted.delete(grantKey(serverName, secretName));
  }

  /** Whether `serverName` currently holds a grant for `secretName`. */
  isGranted(serverName: string, secretName: string): boolean {
    return this.granted.has(grantKey(serverName, secretName));
  }
}

function resolveVar(
  serverName: string,
  decl: McpServerVarDecl,
  grants: McpSecretGrantStore,
  secretValues: Readonly<Record<string, string>>,
): AcpMcpKeyValue {
  if ('value' in decl) return { name: decl.name, value: decl.value };

  if (!grants.isGranted(serverName, decl.secret)) {
    throw new McpServerSecretMissingError(serverName, decl.name);
  }
  const value = secretValues[decl.secret];
  if (value === undefined) {
    throw new McpServerSecretMissingError(serverName, decl.name);
  }
  return { name: decl.name, value };
}

function resolveOne(
  config: McpServerConfig,
  grants: McpSecretGrantStore,
  secretValues: Readonly<Record<string, string>>,
): AcpMcpServerConfig {
  if (config.transport === 'stdio') {
    return {
      name: config.name,
      command: config.command,
      args: config.args,
      env: config.env.map((v) => resolveVar(config.name, v, grants, secretValues)),
    };
  }
  return {
    type: config.transport,
    name: config.name,
    url: config.url,
    headers: config.headers.map((v) => resolveVar(config.name, v, grants, secretValues)),
  };
}

/**
 * Resolves a declared `McpServerConfig` list into the `AcpMcpServerConfig`
 * list `AcpClient.newSession` consumes, per issue #189's "resolved at
 * session start; an ungranted/missing secret fails clearly before the
 * session opens": the very first ungranted-or-missing secret throws
 * `McpServerSecretMissingError` (naming the server and the env-var/header
 * name) before this function returns anything, so a caller never gets a
 * partially-resolved list to accidentally hand to `newSession`.
 *
 * See the module doc comment above for the node-local-secrets requirement
 * on `secretValues`.
 */
export function resolveMcpServerConfigs(
  configs: readonly McpServerConfig[],
  grants: McpSecretGrantStore,
  secretValues: Readonly<Record<string, string>>,
): AcpMcpServerConfig[] {
  return configs.map((config) => resolveOne(config, grants, secretValues));
}
