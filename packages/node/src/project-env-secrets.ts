/* ---------------------------------------------------------------------
 * Node-side per-project env-var injection for the agent process itself
 * (SPEC.md §7.17, §8; issue #258): a persisted per-secret grant ACL for
 * direct agent-env injection, plus the resolution call a session start
 * actually needs — turning a project's declared `ProjectEnvVarDecl` list
 * into the plain `Record<string, string>` env `AgentSupervisor.start()`
 * merges into the spawned agent process, failing clearly on an
 * ungranted/missing secret before any session opens.
 *
 * `@loombox/providers-core`'s `ProjectEnvGrantStore`/`resolveProjectEnv`
 * (`project-env.ts`) are the provider-agnostic ACL and resolver this
 * module wraps with real persistence — mirroring `./mcp-secrets.ts`'s
 * identical relationship to `@loombox/providers-core`'s
 * `McpSecretGrantStore`/`resolveMcpServerConfigs` (issue #189).
 *
 * Deliberately reuses, rather than duplicates, `NodeMcpSecretManager`'s
 * existing keyring-backed secret *value* storage (issue #258's own "the
 * store... already exist and should be reused rather than duplicated"):
 * this manager holds no secret value of its own, only the distinct
 * direct-injection grant ACL (see `@loombox/providers-core`'s
 * `project-env.ts` doc comment for why that ACL is deliberately separate
 * from `McpSecretGrantStore`'s per-server one) — a secret's value is read
 * through the injected `ProjectSecretValueSource`, which
 * `NodeMcpSecretManager` already satisfies structurally via its
 * `getSecretValue` method, so a secret set once (e.g. to grant an MCP
 * server) needs no second entry to also be grantable for direct agent-env
 * injection.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  ProjectEnvGrantStore,
  requiredProjectEnvSecrets,
  resolveProjectEnv,
  type ProjectEnvVarDecl,
} from '@loombox/providers-core';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const GRANTS_FILE_NAME = 'project-env-grants.json';
const GRANTS_SCHEMA_VERSION = 1;

interface GrantsFileV1 {
  v: 1;
  /** Keyed by project path (the same string `McpConfigStore`/`NodeMcpSecretManager` key their own per-project records on); each value is the list of secret names granted for direct agent-env injection in that project. */
  projects: Record<string, string[]>;
}

/**
 * The minimal secret-value read this manager needs (issue #258) —
 * satisfied structurally by `NodeMcpSecretManager`'s existing
 * `getSecretValue`, so `NodeDaemon` wires this manager straight to the
 * same instance rather than standing up a second value store.
 */
export interface ProjectSecretValueSource {
  getSecretValue(projectPath: string, secretName: string): Promise<string | undefined>;
}

export interface NodeProjectEnvManagerOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
  /** Where this manager reads a granted secret's actual value from — see this module's doc comment for why this is injected rather than owned here. */
  secrets: ProjectSecretValueSource;
}

/**
 * Persists the per-secret direct-agent-env-injection grant ACL (SPEC.md
 * §7.17, §8; issue #258) and resolves a project's declared env-var list
 * into the plain, ready-to-spawn-with env at session start. See this
 * module's doc comment for the storage shape/rationale.
 */
export class NodeProjectEnvManager {
  private readonly grantsFilePath: string;
  private readonly secrets: ProjectSecretValueSource;

  constructor(options: NodeProjectEnvManagerOptions) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.grantsFilePath = path.join(stateDir, GRANTS_FILE_NAME);
    this.secrets = options.secrets;
  }

  /** Grants `secretName` direct agent-env-injection access within `projectPath` — a distinct, explicit action (SPEC §7.7's "never automatically", applied here to a project's own agent process); never implied by declaring an env var that references it. A no-op if already granted. */
  grant(projectPath: string, secretName: string): void {
    const file = this.readGrantsFile();
    const list = file.projects[projectPath] ?? [];
    if (!list.includes(secretName)) list.push(secretName);
    file.projects[projectPath] = list;
    this.writeGrantsFile(file);
  }

  /** Revokes `secretName`'s direct-injection grant within `projectPath`, without affecting any other project's grant on the same secret, or this project's grant on a different secret. A no-op if it wasn't granted. */
  revoke(projectPath: string, secretName: string): void {
    const file = this.readGrantsFile();
    const list = file.projects[projectPath] ?? [];
    file.projects[projectPath] = list.filter((name) => name !== secretName);
    this.writeGrantsFile(file);
  }

  /** Whether `secretName` currently holds a direct-injection grant within `projectPath`. */
  isGranted(projectPath: string, secretName: string): boolean {
    return (this.readGrantsFile().projects[projectPath] ?? []).includes(secretName);
  }

  /**
   * Resolves `decls` (a project's declared env-var list, forwarded at
   * session start — see `@loombox/protocol`'s
   * `sessionPrivateMetaV1.projectEnvDecls`) into the plain
   * `Record<string, string>` env a session's `AgentSupervisor.start()`
   * merges into the spawned agent process (issue #258): every declared
   * secret reference is substituted with its value only if both granted
   * to `projectPath` AND a value is actually stored, and this throws
   * `ProjectEnvVarMissingError` (naming the env var and the secret) on
   * the first one that isn't, before returning anything — see
   * `@loombox/providers-core`'s `resolveProjectEnv` for the exact
   * resolution/failure semantics this delegates to. Returns `{}`
   * (skipping secret resolution entirely) for an empty `decls`, the
   * common case, rather than doing pointless keyring I/O.
   */
  async resolveForSession(
    projectPath: string,
    decls: readonly ProjectEnvVarDecl[],
  ): Promise<Record<string, string>> {
    if (decls.length === 0) return {};

    const grants = new ProjectEnvGrantStore();
    for (const secretName of this.readGrantsFile().projects[projectPath] ?? []) {
      grants.grant(secretName);
    }

    const secretNames = requiredProjectEnvSecrets(decls);
    const values: Record<string, string> = {};
    for (const name of secretNames) {
      const value = await this.secrets.getSecretValue(projectPath, name);
      if (value !== undefined) values[name] = value;
    }

    return resolveProjectEnv(decls, grants, values);
  }

  private readGrantsFile(): GrantsFileV1 {
    if (!existsSync(this.grantsFilePath)) return { v: GRANTS_SCHEMA_VERSION, projects: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.grantsFilePath, 'utf8'));
    } catch {
      return { v: GRANTS_SCHEMA_VERSION, projects: {} };
    }
    const projects = (parsed as Partial<GrantsFileV1> | null)?.projects;
    return { v: GRANTS_SCHEMA_VERSION, projects: projects ?? {} };
  }

  private writeGrantsFile(file: GrantsFileV1): void {
    mkdirSync(path.dirname(this.grantsFilePath), { recursive: true });
    writeFileSync(this.grantsFilePath, JSON.stringify(file, null, 2));
  }
}
