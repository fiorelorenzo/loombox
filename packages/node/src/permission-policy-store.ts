/* ---------------------------------------------------------------------
 * Node-side persistence for the per-project permission policy (SPEC
 * §7.17; issue #256): one JSON file, mirroring `mcp-config-store.ts`'s own
 * shape/rationale almost exactly — a project's policy is small and changes
 * rarely (an operator editing allow/deny rules, not a hot path), so every
 * mutation re-reads then rewrites the whole file rather than an append
 * log. Keyed by a project's absolute `projectPath`, the same identifier
 * `mcp-config-store.ts` already keys its own per-project records on.
 *
 * Unlike MCP servers (`McpConfigStore`'s global-plus-per-project-override
 * shape, SPEC §7.7), there is no "global" tier here: SPEC §7.17 names this
 * a *per-project* policy, and a global fallback would blur the "empty
 * policy = allow-all, and that's the operator's explicit choice for this
 * project" contract `permission-policy.ts`'s own doc comment documents —
 * a global default could silently apply restrictions (or their absence)
 * an operator looking at one project's settings never asked for.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  EMPTY_PERMISSION_POLICY,
  type PermissionPolicy,
  type PermissionRuleSet,
} from './permission-policy';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

const PERMISSION_POLICY_FILE_NAME = 'permission-policy.json';
const PERMISSION_POLICY_SCHEMA_VERSION = 1;

interface PermissionPolicyFileV1 {
  v: 1;
  projects: Record<string, PermissionPolicy>;
}

/** Thrown for any malformed on-disk permission policy (corrupt JSON, a non-string-array rule list). Never returns a partially-valid result. */
export class PermissionPolicyError extends Error {
  constructor(message: string) {
    super(`permission policy store: ${message}`);
    this.name = 'PermissionPolicyError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateStringArray(raw: unknown, context: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
    throw new PermissionPolicyError(`${context}: expected an array of glob-pattern strings`);
  }
  return [...raw];
}

function validateRuleSet(raw: unknown, context: string): PermissionRuleSet {
  if (raw === undefined) return { allow: [], deny: [] };
  if (typeof raw !== 'object' || raw === null) {
    throw new PermissionPolicyError(`${context}: must be an object`);
  }
  const obj = raw as { allow?: unknown; deny?: unknown };
  return {
    allow: validateStringArray(obj.allow, `${context}.allow`),
    deny: validateStringArray(obj.deny, `${context}.deny`),
  };
}

function validatePolicy(raw: unknown, context: string): PermissionPolicy {
  if (typeof raw !== 'object' || raw === null) {
    throw new PermissionPolicyError(`${context}: must be an object`);
  }
  const obj = raw as { command?: unknown; network?: unknown };
  return {
    command: validateRuleSet(obj.command, `${context}.command`),
    network: validateRuleSet(obj.network, `${context}.network`),
  };
}

function validateFile(parsed: unknown, filePath: string): PermissionPolicyFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PermissionPolicyError(`config file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { projects?: unknown };
  const projects: Record<string, PermissionPolicy> = {};
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new PermissionPolicyError(`config file "${filePath}": "projects" must be an object`);
    }
    for (const [projectPath, value] of Object.entries(obj.projects)) {
      projects[projectPath] = validatePolicy(value, `${filePath} (project "${projectPath}")`);
    }
  }
  return { v: PERMISSION_POLICY_SCHEMA_VERSION, projects };
}

export interface PermissionPolicyStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's per-project permission policy (SPEC §7.17; issue
 * #256) across a node restart. See this module's doc comment for the
 * storage shape/rationale.
 */
export class PermissionPolicyStore {
  private readonly filePath: string;

  constructor(options: PermissionPolicyStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, PERMISSION_POLICY_FILE_NAME);
  }

  /** `projectPath`'s saved policy, or {@link EMPTY_PERMISSION_POLICY} (allow-all — see `permission-policy.ts`'s doc comment) when nothing has been saved for it. */
  get(projectPath: string): PermissionPolicy {
    return this.readFile().projects[projectPath] ?? EMPTY_PERMISSION_POLICY;
  }

  /** Creates or replaces `projectPath`'s policy in full (never a partial patch — mirrors how an operator editing allow/deny rules would submit the whole form). */
  save(projectPath: string, policy: PermissionPolicy): void {
    const file = this.readFile();
    file.projects[projectPath] = policy;
    this.writeFile(file);
  }

  /** Removes `projectPath`'s saved policy, reverting it to the {@link EMPTY_PERMISSION_POLICY} default. A no-op if it had none. */
  remove(projectPath: string): void {
    const file = this.readFile();
    delete file.projects[projectPath];
    this.writeFile(file);
  }

  private readFile(): PermissionPolicyFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: PERMISSION_POLICY_SCHEMA_VERSION, projects: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new PermissionPolicyError(
        `config file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: PermissionPolicyFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
