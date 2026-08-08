/* ---------------------------------------------------------------------
 * Node-side persistence for named agent profiles (design spec
 * `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752): a small,
 * account-scoped catalog, not project-scoped like `PermissionPolicyStore`
 * or global-plus-project like `McpConfigStore` — this node serves exactly
 * one account (`resolve-account-id.ts`), so "per account" collapses to
 * "one list, no scoping key", the same shape `McpConfigStore`'s own
 * `listGlobal()` half already uses.
 *
 * A single JSON file, mirroring `mcp-config-store.ts`'s own shape and
 * rationale: a node's profile catalog is small and changes rarely (an
 * infrequent settings edit, not a hot path), so every mutation re-reads
 * then rewrites the whole file rather than an append-log design.
 * --------------------------------------------------------------------- */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AgentProfile } from './agent-profile';
import { loadJsonFile } from './json-store';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

const AGENT_PROFILE_FILE_NAME = 'agent-profiles.json';
const AGENT_PROFILE_SCHEMA_VERSION = 1;

interface AgentProfileFileV1 {
  v: typeof AGENT_PROFILE_SCHEMA_VERSION;
  profiles: AgentProfile[];
}

/** Thrown for any malformed on-disk profile catalog (corrupt JSON, a non-string-array field). Never returns a partially-valid result. */
export class AgentProfileError extends Error {
  constructor(message: string) {
    super(`agent profile store: ${message}`);
    this.name = 'AgentProfileError';
  }
}

function validateStringArray(raw: unknown, context: string): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new AgentProfileError(`${context} must be an array of strings`);
  }
  return raw as string[];
}

function validateProfile(raw: unknown, context: string): AgentProfile {
  if (typeof raw !== 'object' || raw === null) {
    throw new AgentProfileError(`${context} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new AgentProfileError(`${context}.id must be a non-empty string`);
  }
  if (typeof record.name !== 'string' || record.name.length === 0) {
    throw new AgentProfileError(`${context}.name must be a non-empty string`);
  }
  // Values are opaque, unvalidated strings past this point (issue #752's
  // "a profile that references a tool the current agent does not declare
  // degrades quietly" — validating them against a known kind/name space
  // here would be the wrong layer for that; see `agent-profile.ts`'s own
  // doc comment). `deniedToolKinds` is cast once, to a named local, from
  // the plain `string[]` this layer actually validates to the richer
  // `AcpToolKind[]` `AgentProfile` declares — this store deliberately
  // never narrows against the real enum (that would defeat the "quiet
  // degrade" contract for a future ACP kind this build doesn't know yet).
  const deniedToolKinds = validateStringArray(
    record.deniedToolKinds,
    `${context}.deniedToolKinds`,
  ) as AgentProfile['deniedToolKinds'];
  return {
    id: record.id,
    name: record.name,
    deniedToolKinds,
    deniedToolNamePatterns: validateStringArray(
      record.deniedToolNamePatterns,
      `${context}.deniedToolNamePatterns`,
    ),
    deniedMcpServers: validateStringArray(record.deniedMcpServers, `${context}.deniedMcpServers`),
  };
}

function validateFile(parsed: unknown, filePath: string): AgentProfileFileV1 {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AgentProfileError(`file "${filePath}" is not a valid agent-profile catalog`);
  }
  const file = parsed as { profiles?: unknown };
  if (!Array.isArray(file.profiles)) {
    throw new AgentProfileError(`file "${filePath}" is not a valid agent-profile catalog`);
  }
  const profiles = file.profiles.map((entry, index) =>
    validateProfile(entry, `profiles[${index}]`),
  );
  return { v: AGENT_PROFILE_SCHEMA_VERSION, profiles };
}

export interface AgentProfileStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's named agent-profile catalog across a node restart.
 * See this module's doc comment for the storage shape/rationale.
 */
export class AgentProfileStore {
  private readonly filePath: string;

  constructor(options: AgentProfileStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, AGENT_PROFILE_FILE_NAME);
  }

  /** Every saved profile. `[]` for a node with none configured yet. */
  list(): AgentProfile[] {
    return this.readFile().profiles;
  }

  /** One profile by id, or `undefined` if it doesn't exist (a deleted/never-created id — the caller's own "quiet degrade" case, never this store's to throw on). */
  get(id: string): AgentProfile | undefined {
    return this.readFile().profiles.find((profile) => profile.id === id);
  }

  /** Creates or replaces (by `profile.id`) the full catalog with `profiles` — mirrors `PermissionPolicyStore.save()`'s own "whole value, never a partial patch" contract. */
  saveAll(profiles: readonly AgentProfile[]): void {
    this.writeFile({ v: AGENT_PROFILE_SCHEMA_VERSION, profiles: [...profiles] });
  }

  private readFile(): AgentProfileFileV1 {
    return loadJsonFile(
      this.filePath,
      { v: AGENT_PROFILE_SCHEMA_VERSION, profiles: [] },
      validateFile,
      (message) => new AgentProfileError(message),
    );
  }

  private writeFile(file: AgentProfileFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
