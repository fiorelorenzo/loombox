/* ---------------------------------------------------------------------
 * Per-project env-var injection for the agent process itself (SPEC.md
 * §7.17, §8; issue #258): a project declares which env vars the spawned
 * agent/test process should receive, each either a literal value or a
 * reference to a node-local secret by name — never a secret value inline.
 *
 * Deliberately mirrors `./mcp-secret-grants.ts`'s (issue #189) grant/
 * resolve shape — same `{name, value}` / `{name, secret}` var-decl union
 * (`McpServerVarDecl`), same "grant is a distinct, explicit action, never
 * implied" ACL, same fail-fast-before-anything-starts resolver contract —
 * but for a single implicit consumer (the agent process this project's
 * session spawns) rather than one ACL entry per MCP server. Where
 * `McpSecretGrantStore` keys a grant on `(serverName, secretName)`, this
 * module's `ProjectEnvGrantStore` keys on `secretName` alone: granting a
 * secret to a project's own agent process is a strictly more powerful,
 * genuinely distinct trust boundary from granting it to one sandboxed MCP
 * server (§7.7's "output is treated as untrusted input") — so a secret
 * granted to an MCP server is never implicitly usable for direct env
 * injection, and vice versa; a caller wanting both grants a secret twice,
 * once in each store.
 *
 * Secret *values* are intentionally out of scope here, same as
 * `mcp-secret-grants.ts`: this module is provider/storage-agnostic and
 * does no I/O of its own. `@loombox/node`'s `NodeProjectEnvManager`
 * (`project-env-secrets.ts`) is the node-side caller that supplies
 * `secretValues` from this node's local secret storage — reusing
 * `NodeMcpSecretManager`'s existing keyring-backed value store rather than
 * standing up a second one, so a secret set once is usable by both an MCP
 * server grant and a project env-injection grant.
 * --------------------------------------------------------------------- */

import type { McpServerVarDecl } from './mcp-config';

/** One declared project env var: mirrors `McpServerVarDecl` exactly — `name` is the env var name the agent process sees, and exactly one of `value` (a literal, non-secret default) or `secret` (a node-local secret reference) is present. */
export type ProjectEnvVarDecl = McpServerVarDecl;

/**
 * Thrown when a project's declared env var names a secret that either
 * isn't granted for direct agent-env injection, or is granted but has no
 * stored value on this node — session start fails clearly and up front
 * with this error (naming the env var and the secret) rather than
 * spawning an agent quietly missing a credential it asked for (issue
 * #258's own acceptance line, mirroring `McpServerSecretMissingError`'s
 * identical rationale for MCP servers). No child process is ever spawned
 * in this case.
 */
export class ProjectEnvVarMissingError extends Error {
  constructor(
    readonly variableName: string,
    readonly secretName: string,
  ) {
    super(
      `Project env var "${variableName}" is missing a required secret grant for "${secretName}" ` +
        `— grant it for direct env injection before starting a session.`,
    );
    this.name = 'ProjectEnvVarMissingError';
  }
}

/**
 * The explicit per-secret grant ACL for direct agent-env injection. Starts
 * empty: no secret is ever usable here on creation, only through a
 * deliberate `grant()` call (§7.7's "never automatically", applied one
 * dimension flatter than `McpSecretGrantStore` — see this module's doc
 * comment for why there is no per-server axis here).
 */
export class ProjectEnvGrantStore {
  private readonly granted = new Set<string>();

  /** Grants direct agent-env injection access to `secretName`. A distinct, explicit action; never implied by declaring an env var that references it. */
  grant(secretName: string): void {
    this.granted.add(secretName);
  }

  /** Revokes `secretName`'s direct-injection grant, if any. A no-op if it wasn't granted. */
  revoke(secretName: string): void {
    this.granted.delete(secretName);
  }

  /** Whether `secretName` currently holds a direct-injection grant. */
  isGranted(secretName: string): boolean {
    return this.granted.has(secretName);
  }
}

function resolveVar(
  decl: ProjectEnvVarDecl,
  grants: ProjectEnvGrantStore,
  secretValues: Readonly<Record<string, string>>,
): [string, string] {
  if ('value' in decl) return [decl.name, decl.value];

  if (!grants.isGranted(decl.secret)) {
    throw new ProjectEnvVarMissingError(decl.name, decl.secret);
  }
  const value = secretValues[decl.secret];
  if (value === undefined) {
    throw new ProjectEnvVarMissingError(decl.name, decl.secret);
  }
  return [decl.name, value];
}

/**
 * Resolves a project's declared `ProjectEnvVarDecl` list into the plain
 * `Record<string, string>` env `AcpSpawnConfig.env` (`./types.ts`) actually
 * carries into the spawned agent process (issue #258): every declared
 * secret reference is substituted with its value only if both granted AND
 * a value is actually stored, throwing `ProjectEnvVarMissingError` on the
 * first one that isn't — before this returns anything, so a caller never
 * gets a partially-resolved env (mirrors `resolveMcpServerConfigs`'s
 * identical fail-fast contract). A duplicate `name` across the list has
 * the later entry win, same as a plain object literal would.
 */
export function resolveProjectEnv(
  decls: readonly ProjectEnvVarDecl[],
  grants: ProjectEnvGrantStore,
  secretValues: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const decl of decls) {
    const [name, value] = resolveVar(decl, grants, secretValues);
    env[name] = value;
  }
  return env;
}

/** The distinct named secrets a project's declared env-var list references (issue #258) — the set `NodeProjectEnvManager.resolveForSession` needs to read from local secret storage before resolving. */
export function requiredProjectEnvSecrets(decls: readonly ProjectEnvVarDecl[]): string[] {
  const names = new Set<string>();
  for (const decl of decls) {
    if ('secret' in decl) names.add(decl.secret);
  }
  return [...names];
}

/** Thrown by `parseProjectEnvVarDecl`/`parseProjectEnvVarDeclList` for a malformed raw decl entry — always names the offending field, and the entry's index when available. Same shape/rationale as `mcp-config.ts`'s `McpServerConfigError`, kept as its own class rather than reused: a project env-var decl and an MCP server's var decl are genuinely separate data models that happen to share a shape (see this module's doc comment). */
export class ProjectEnvDeclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectEnvDeclError';
  }
}

function fail(context: string, message: string): never {
  throw new ProjectEnvDeclError(`Project env var decl${context}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates one raw project env-var decl entry into a typed
 * `ProjectEnvVarDecl`, throwing `ProjectEnvDeclError` with a clear,
 * actionable message for a malformed entry. `index`, when given (from
 * `parseProjectEnvVarDeclList`), is folded into the error context so a
 * caller can tell exactly which entry in a list failed.
 */
export function parseProjectEnvVarDecl(raw: unknown, index?: number): ProjectEnvVarDecl {
  const context = index === undefined ? '' : `[${index}]`;
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

/**
 * Parses and validates a raw project env-var decl list (e.g. a project's
 * client-side declared list, SPEC.md §7.17/§8; issue #258) into a typed
 * `ProjectEnvVarDecl[]`. Rejects a non-array top-level value, any
 * malformed entry (see `parseProjectEnvVarDecl`), and a duplicate `name`
 * within the list, all with `ProjectEnvDeclError`.
 */
export function parseProjectEnvVarDeclList(raw: unknown): ProjectEnvVarDecl[] {
  if (!Array.isArray(raw)) fail('', 'expected an array of project env-var decl entries');

  const parsed = raw.map((entry, i) => parseProjectEnvVarDecl(entry, i));

  const seen = new Set<string>();
  for (const decl of parsed) {
    if (seen.has(decl.name)) fail('', `duplicate env var name "${decl.name}"`);
    seen.add(decl.name);
  }
  return parsed;
}
