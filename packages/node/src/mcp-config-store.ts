/* ---------------------------------------------------------------------
 * Node-side persistence for the MCP server configuration data model
 * (SPEC.md §7.7; issue #187): a project-level and a global-level record can
 * be created, listed, enabled, and disabled independently, and a project's
 * effective set resolves as global-plus-project-overrides via
 * `@loombox/providers-core`'s `resolveEffectiveMcpServers` — the pure merge
 * algorithm that package's own doc comment explicitly leaves storage/CRUD
 * for a node to build (this module).
 *
 * A single JSON file, mirroring `ssh/verify-and-persist.ts`'s
 * `SshTargetStore` shape: a node's MCP server list is small and changes
 * rarely (an "add MCP server" flow, not a hot path), so there's no need for
 * `TranscriptStore`'s append-log design. Every mutation re-reads then
 * rewrites the whole file — simple and correct for this access pattern.
 *
 * Projects are keyed by their absolute `projectPath` (the same string
 * `CreateNodeSessionOptions.projectPath` carries) rather than a separate
 * project-id concept: that's the one identifier a node already has for a
 * project at session-creation time, and it's what `NodeDaemon` will key its
 * `effectiveServers()`/secret-resolution calls on too.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  parseMcpServerConfig,
  resolveEffectiveMcpServers,
  type McpServerConfig,
  type McpServerConfigRecord,
} from '@loombox/providers-core';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const MCP_CONFIG_FILE_NAME = 'mcp-servers.json';
const MCP_CONFIG_SCHEMA_VERSION = 1;

interface McpConfigFileV1 {
  v: 1;
  global: McpServerConfigRecord[];
  projects: Record<string, McpServerConfigRecord[]>;
}

/** Thrown for any malformed on-disk MCP config (corrupt JSON, an invalid record) or an enable/disable/remove naming a server this store doesn't have — names the offending scope/field, never returns a partially-valid result. */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(`MCP config store: ${message}`);
    this.name = 'McpConfigError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upsert(
  list: readonly McpServerConfigRecord[],
  config: McpServerConfig,
  enabled: boolean,
): McpServerConfigRecord[] {
  return [...list.filter((record) => record.config.name !== config.name), { config, enabled }];
}

function withEnabled(
  list: readonly McpServerConfigRecord[],
  name: string,
  enabled: boolean,
  scopeLabel: string,
): McpServerConfigRecord[] {
  const index = list.findIndex((record) => record.config.name === name);
  if (index === -1) {
    throw new McpConfigError(`no ${scopeLabel} MCP server named "${name}"`);
  }
  const next = [...list];
  next[index] = { config: next[index]!.config, enabled };
  return next;
}

function validateRecord(raw: unknown, context: string): McpServerConfigRecord {
  if (typeof raw !== 'object' || raw === null) {
    throw new McpConfigError(`${context}: must be an object`);
  }
  const record = raw as { config?: unknown; enabled?: unknown };
  if (typeof record.enabled !== 'boolean') {
    throw new McpConfigError(`${context}: "enabled" must be a boolean`);
  }
  let config: McpServerConfig;
  try {
    config = parseMcpServerConfig(record.config);
  } catch (error) {
    throw new McpConfigError(`${context}: ${errorMessage(error)}`);
  }
  return { config, enabled: record.enabled };
}

function validateRecordList(raw: unknown, context: string): McpServerConfigRecord[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new McpConfigError(`${context}: expected an array of MCP server config records`);
  }
  return raw.map((entry, index) => validateRecord(entry, `${context}[${index}]`));
}

function validateFile(parsed: unknown, filePath: string): McpConfigFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpConfigError(`config file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { global?: unknown; projects?: unknown };
  const global = validateRecordList(obj.global, `${filePath} (global)`);

  const projects: Record<string, McpServerConfigRecord[]> = {};
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new McpConfigError(`config file "${filePath}": "projects" must be an object`);
    }
    for (const [projectPath, list] of Object.entries(obj.projects)) {
      projects[projectPath] = validateRecordList(list, `${filePath} (project "${projectPath}")`);
    }
  }

  return { v: MCP_CONFIG_SCHEMA_VERSION, global, projects };
}

export interface McpConfigStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's MCP server configuration — global and per-project
 * (SPEC.md §7.7; issue #187) — across a node restart. See this module's
 * doc comment for the storage shape/rationale.
 */
export class McpConfigStore {
  private readonly filePath: string;

  constructor(options: McpConfigStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, MCP_CONFIG_FILE_NAME);
  }

  /** Every global MCP server record, enabled and disabled alike. */
  listGlobal(): McpServerConfigRecord[] {
    return this.readFile().global;
  }

  /** Every MCP server record scoped to `projectPath`, enabled and disabled alike — never includes an inherited global record (see {@link effectiveServers} for the merged view). */
  listProject(projectPath: string): McpServerConfigRecord[] {
    return this.readFile().projects[projectPath] ?? [];
  }

  /** Creates or replaces the global record for `config.name`. `enabled` defaults to `true`, matching SPEC §7.7's "add and enable MCP servers". */
  saveGlobal(config: McpServerConfig, enabled = true): void {
    const file = this.readFile();
    file.global = upsert(file.global, config, enabled);
    this.writeFile(file);
  }

  /** Creates or replaces `projectPath`'s record for `config.name` — either a project's own server, or a project-scoped override of a same-named global one. `enabled` defaults to `true`. */
  saveProject(projectPath: string, config: McpServerConfig, enabled = true): void {
    const file = this.readFile();
    file.projects[projectPath] = upsert(file.projects[projectPath] ?? [], config, enabled);
    this.writeFile(file);
  }

  /** Enables/disables an existing global record without touching its config. Throws {@link McpConfigError} if no global record has that name. */
  setGlobalEnabled(name: string, enabled: boolean): void {
    const file = this.readFile();
    file.global = withEnabled(file.global, name, enabled, 'global');
    this.writeFile(file);
  }

  /** Enables/disables an existing project record without touching its config. Throws {@link McpConfigError} if `projectPath` has no record with that name (an inherited-but-not-yet-overridden global server has no project record to toggle — use {@link saveProject} with `enabled: false` to disable it for this project instead). */
  setProjectEnabled(projectPath: string, name: string, enabled: boolean): void {
    const file = this.readFile();
    file.projects[projectPath] = withEnabled(
      file.projects[projectPath] ?? [],
      name,
      enabled,
      `project "${projectPath}"`,
    );
    this.writeFile(file);
  }

  /** Removes a global record. A no-op if `name` isn't present. */
  removeGlobal(name: string): void {
    const file = this.readFile();
    file.global = file.global.filter((record) => record.config.name !== name);
    this.writeFile(file);
  }

  /** Removes a project record. A no-op if `name` isn't present. */
  removeProject(projectPath: string, name: string): void {
    const file = this.readFile();
    file.projects[projectPath] = (file.projects[projectPath] ?? []).filter(
      (record) => record.config.name !== name,
    );
    this.writeFile(file);
  }

  /**
   * `projectPath`'s effective, enabled MCP server set: every enabled global
   * server, except a project record for the same name always wins outright
   * (SPEC.md §7.7's global-plus-project-overrides; see
   * `@loombox/providers-core`'s `resolveEffectiveMcpServers` for the exact
   * merge semantics). What a session's `NewSessionOptions.mcpServers`
   * ultimately derives from, once secrets are resolved (`mcp-secrets.ts`,
   * issue #189).
   */
  effectiveServers(projectPath: string): McpServerConfig[] {
    return resolveEffectiveMcpServers(this.listGlobal(), this.listProject(projectPath));
  }

  private readFile(): McpConfigFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: MCP_CONFIG_SCHEMA_VERSION, global: [], projects: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new McpConfigError(
        `config file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: McpConfigFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
