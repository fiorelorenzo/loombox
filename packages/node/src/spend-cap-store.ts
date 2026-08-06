/* ---------------------------------------------------------------------
 * Node-side persistence for the per-project spend cap (SPEC §7.16
 * "Spend caps"; issue #251): one JSON file, mirroring `permission-
 * policy-store.ts`'s own shape/rationale almost exactly — a project's
 * cap is small and changes rarely (an operator raising/lowering one
 * number, not a hot path), so every mutation re-reads then rewrites the
 * whole file rather than an append log. Keyed by a project's absolute
 * `projectPath`, the same identifier `permission-policy-store.ts`/
 * `mcp-config-store.ts` already key their own per-project records on.
 *
 * Unlike `PermissionPolicyStore`'s "empty policy = allow-all" default,
 * an UNCONFIGURED project has no cap at all, not a cap of zero or
 * `Infinity` — `get()` returns `undefined`, and `NodeDaemon.
 * effectiveSpendCapUsd` treats that as "nothing to enforce here,"
 * exactly like a session with no `Session.spendCapUsd` set. A cap is
 * always a positive, finite number of US dollars; there is no separate
 * "disabled" flag to keep in sync with a cap value, because `undefined`
 * (no saved entry) already means exactly that.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const SPEND_CAP_FILE_NAME = 'spend-caps.json';
const SPEND_CAP_SCHEMA_VERSION = 1;

interface SpendCapFileV1 {
  v: 1;
  projects: Record<string, number>;
}

/** Thrown for any malformed on-disk spend-cap file (corrupt JSON, a cap that isn't a positive finite number). Never returns a partially-valid result. */
export class SpendCapError extends Error {
  constructor(message: string) {
    super(`spend cap store: ${message}`);
    this.name = 'SpendCapError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateCapUsd(raw: unknown, context: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new SpendCapError(`${context}: must be a positive, finite number of US dollars`);
  }
  return raw;
}

function validateFile(parsed: unknown, filePath: string): SpendCapFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SpendCapError(`config file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { projects?: unknown };
  const projects: Record<string, number> = {};
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new SpendCapError(`config file "${filePath}": "projects" must be an object`);
    }
    for (const [projectPath, value] of Object.entries(obj.projects)) {
      projects[projectPath] = validateCapUsd(value, `${filePath} (project "${projectPath}")`);
    }
  }
  return { v: SPEND_CAP_SCHEMA_VERSION, projects };
}

export interface SpendCapStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's per-project spend cap (SPEC §7.16; issue #251)
 * across a node restart. See this module's doc comment for the storage
 * shape/rationale. The per-SESSION cap is a different, smaller-scoped
 * value that deliberately lives elsewhere: directly on `SessionManager`'s
 * own `Session.spendCapUsd`, persisted through `SessionStore` exactly
 * like the rest of a session's record — see `session-manager.ts`'s
 * `setSpendCapUsd` doc comment for why a per-session setting doesn't get
 * its own file the way a per-project one does.
 */
export class SpendCapStore {
  private readonly filePath: string;

  constructor(options: SpendCapStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, SPEND_CAP_FILE_NAME);
  }

  /** `projectPath`'s saved spend cap in USD, or `undefined` when nothing has been saved for it (no cap to enforce, never a fabricated 0). */
  get(projectPath: string): number | undefined {
    return this.readFile().projects[projectPath];
  }

  /** Creates or replaces `projectPath`'s spend cap. `capUsd: undefined` clears it (reverting to "no cap"), mirroring `remove()`'s effect without a second method. */
  save(projectPath: string, capUsd: number | undefined): void {
    const file = this.readFile();
    if (capUsd === undefined) {
      delete file.projects[projectPath];
    } else {
      validateCapUsd(capUsd, `save("${projectPath}")`);
      file.projects[projectPath] = capUsd;
    }
    this.writeFile(file);
  }

  private readFile(): SpendCapFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: SPEND_CAP_SCHEMA_VERSION, projects: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new SpendCapError(
        `config file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: SpendCapFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
