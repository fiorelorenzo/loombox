/* ---------------------------------------------------------------------
 * Node-side persistence for the aggregate spend-over-time view (SPEC
 * §7.9's "shows spend over time per project/provider"; issue #249): one
 * JSON file, mirroring `spend-cap-store.ts`'s own shape/conventions —
 * sync `node:fs`, an injectable `stateDir` defaulting to
 * `defaultNodeStateDir()`, every mutation re-reads then rewrites the
 * whole file. A node's own spend history is a handful of small rows per
 * project/provider/day, not a high-frequency write path (one write per
 * `usage_update` that actually reports a cost increase, and those arrive
 * at most a few times a minute even mid-turn).
 *
 * One row per (date, projectPath, provider) — `recordDelta` accumulates
 * into it rather than appending a new row per `usage_update`, so the file
 * stays small regardless of how chatty a session's usage reporting is.
 * `date` is a UTC calendar date (`YYYY-MM-DD`): the wall-clock day the
 * cost increase was OBSERVED, not any date embedded in agent-reported
 * data (ACP's `usage_update` carries no such timestamp — see
 * `NodeDaemon.recordUsageCost`'s own doc comment for the full reasoning).
 *
 * This store never computes a cost itself. `recordDelta`'s caller
 * (`NodeDaemon.recordUsageCost`) is the one place that turns a
 * `usage_update.costUsd` into a delta, the exact same computation that
 * also updates `SessionBridge.spendCumulativeCostUsd` for SPEC §7.16's
 * spend-cap enforcement — one source, never two divergent tallies of "how
 * much did this session actually cost." See `spend-aggregation.ts` for
 * the pure grouping logic this store's rows feed into.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const SPEND_LEDGER_FILE_NAME = 'spend-ledger.json';
const SPEND_LEDGER_SCHEMA_VERSION = 1;

/** One persisted row: the total cost recorded for one project+provider on one UTC calendar date. */
export interface SpendLedgerRow {
  /** UTC calendar date, `YYYY-MM-DD`. */
  date: string;
  projectPath: string;
  provider: string;
  /** Always > 0 — a row only exists because at least one positive delta was recorded into it. */
  costUsd: number;
}

interface SpendLedgerFileV1 {
  v: 1;
  rows: SpendLedgerRow[];
}

/** Thrown for any malformed on-disk spend-ledger file (corrupt JSON, a row missing/mistyping a required field) — mirrors `SpendCapError`'s "name the offending part, never return a partially-valid result" contract. */
export class SpendLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendLedgerError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateRow(raw: unknown, context: string): SpendLedgerRow {
  if (typeof raw !== 'object' || raw === null) {
    throw new SpendLedgerError(`${context}: row must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.date !== 'string' || !DATE_PATTERN.test(obj.date)) {
    throw new SpendLedgerError(`${context}: "date" must be a YYYY-MM-DD string`);
  }
  if (typeof obj.projectPath !== 'string' || obj.projectPath.length === 0) {
    throw new SpendLedgerError(`${context}: "projectPath" must be a non-empty string`);
  }
  if (typeof obj.provider !== 'string' || obj.provider.length === 0) {
    throw new SpendLedgerError(`${context}: "provider" must be a non-empty string`);
  }
  if (typeof obj.costUsd !== 'number' || !Number.isFinite(obj.costUsd) || obj.costUsd <= 0) {
    throw new SpendLedgerError(`${context}: "costUsd" must be a positive finite number`);
  }
  return { date: obj.date, projectPath: obj.projectPath, provider: obj.provider, costUsd: obj.costUsd };
}

function validateFile(parsed: unknown, filePath: string): SpendLedgerFileV1 {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SpendLedgerError(`config file "${filePath}": must be an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.rows)) {
    throw new SpendLedgerError(`config file "${filePath}": "rows" must be an array`);
  }
  const rows = obj.rows.map((row, index) => validateRow(row, `${filePath} (row ${index})`));
  return { v: SPEND_LEDGER_SCHEMA_VERSION, rows };
}

export interface SpendLedgerStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's spend-over-time ledger (SPEC §7.9; issue #249)
 * across a node restart. See this module's doc comment for the storage
 * shape/rationale and the "one source, never two divergent tallies"
 * relationship to SPEC §7.16's spend cap.
 */
export class SpendLedgerStore {
  private readonly filePath: string;

  constructor(options: SpendLedgerStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, SPEND_LEDGER_FILE_NAME);
  }

  /**
   * Adds `deltaUsd` (must be a positive finite number — a delta of zero
   * or less is never a real spend increase, and this method is the only
   * writer this store has) to the row for `(date, projectPath,
   * provider)`, creating it if this is the first delta recorded for that
   * combination.
   */
  recordDelta(date: string, projectPath: string, provider: string, deltaUsd: number): void {
    if (!DATE_PATTERN.test(date)) {
      throw new SpendLedgerError(`recordDelta: "date" must be a YYYY-MM-DD string, got "${date}"`);
    }
    if (!(Number.isFinite(deltaUsd) && deltaUsd > 0)) {
      throw new SpendLedgerError(`recordDelta: "deltaUsd" must be a positive finite number, got ${deltaUsd}`);
    }
    const file = this.readFile();
    const existing = file.rows.find(
      (row) => row.date === date && row.projectPath === projectPath && row.provider === provider,
    );
    if (existing) {
      existing.costUsd += deltaUsd;
    } else {
      file.rows.push({ date, projectPath, provider, costUsd: deltaUsd });
    }
    this.writeFile(file);
  }

  /** Every persisted row, in no particular order — callers (`spend-aggregation.ts`) filter/group as needed. A defensive copy: mutating the result never reaches this store's own state. */
  all(): SpendLedgerRow[] {
    return this.readFile().rows.map((row) => ({ ...row }));
  }

  private readFile(): SpendLedgerFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: SPEND_LEDGER_SCHEMA_VERSION, rows: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new SpendLedgerError(
        `config file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: SpendLedgerFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
