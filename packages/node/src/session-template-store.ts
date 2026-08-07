/* ---------------------------------------------------------------------
 * Node-side persistence for named session templates (issue #259, epic
 * #29): a small, account-scoped catalog, mirroring `agent-profile-
 * store.ts`'s own shape and rationale exactly — this node serves exactly
 * one account (`resolve-account-id.ts`), so "per account" collapses to
 * "one list, no scoping key".
 *
 * Unlike `AgentProfile` (`agent-profile.ts`'s own node type, distinct from
 * its ACP-typed wire counterpart `AgentProfileV1`), a session template has
 * no ACP-specific field to narrow: `@loombox/protocol`'s `SessionTemplateV1`
 * IS this store's value type, and `sessionTemplateV1.safeParse` IS its
 * on-disk validation — there is no second, hand-rolled schema to keep in
 * sync with the wire one.
 *
 * A single JSON file, mirroring `mcp-config-store.ts`'s own shape and
 * rationale: a node's template catalog is small and changes rarely (an
 * infrequent "save this workflow" action, not a hot path), so every
 * mutation re-reads then rewrites the whole file rather than an
 * append-log design.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sessionTemplateV1, type SessionTemplateV1 } from '@loombox/protocol';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const SESSION_TEMPLATE_FILE_NAME = 'session-templates.json';
const SESSION_TEMPLATE_SCHEMA_VERSION = 1;

interface SessionTemplateFileV1 {
  v: typeof SESSION_TEMPLATE_SCHEMA_VERSION;
  templates: SessionTemplateV1[];
}

/** Thrown for any malformed on-disk template catalog (corrupt JSON, a template failing `sessionTemplateV1`'s own schema). Never returns a partially-valid result. */
export class SessionTemplateError extends Error {
  constructor(message: string) {
    super(`session template store: ${message}`);
    this.name = 'SessionTemplateError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateFile(parsed: unknown, filePath: string): SessionTemplateFileV1 {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SessionTemplateError(`file "${filePath}" is not a valid session-template catalog`);
  }
  const file = parsed as { templates?: unknown };
  if (!Array.isArray(file.templates)) {
    throw new SessionTemplateError(`file "${filePath}" is not a valid session-template catalog`);
  }
  const templates = file.templates.map((entry, index) => {
    const result = sessionTemplateV1.safeParse(entry);
    if (!result.success) {
      throw new SessionTemplateError(
        `templates[${index}] in "${filePath}" is invalid: ${result.error.message}`,
      );
    }
    return result.data;
  });
  return { v: SESSION_TEMPLATE_SCHEMA_VERSION, templates };
}

export interface SessionTemplateStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's named session-template catalog across a node
 * restart (issue #259's "survives a restart" acceptance). See this
 * module's doc comment for the storage shape/rationale.
 */
export class SessionTemplateStore {
  private readonly filePath: string;

  constructor(options: SessionTemplateStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, SESSION_TEMPLATE_FILE_NAME);
  }

  /** Every saved template. `[]` for a node with none configured yet. */
  list(): SessionTemplateV1[] {
    return this.readFile().templates;
  }

  /** One template by id, or `undefined` if it doesn't exist (a deleted/never-created id — the caller's own "quiet degrade" case, never this store's to throw on). */
  get(id: string): SessionTemplateV1 | undefined {
    return this.readFile().templates.find((template) => template.id === id);
  }

  /** Creates or replaces (by `template.id`) the full catalog with `templates` — mirrors `AgentProfileStore.saveAll()`'s own "whole value, never a partial patch" contract. */
  saveAll(templates: readonly SessionTemplateV1[]): void {
    this.writeFile({ v: SESSION_TEMPLATE_SCHEMA_VERSION, templates: [...templates] });
  }

  private readFile(): SessionTemplateFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: SESSION_TEMPLATE_SCHEMA_VERSION, templates: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new SessionTemplateError(
        `file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: SessionTemplateFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
