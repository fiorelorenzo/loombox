/* ---------------------------------------------------------------------
 * Node-side persistence for the per-project, per-capability account pin
 * map (SPEC §7.26; issue #227): one JSON file, mirroring
 * `permission-policy-store.ts`/`mcp-config-store.ts`'s own shape almost
 * exactly — keyed by a project's absolute `projectPath`, the same
 * identifier those two stores already key their own per-project records
 * on. A pin changes about as rarely as a permission policy (an operator
 * picking which connected account a project uses), so this re-reads then
 * rewrites the whole file per mutation rather than an append log.
 *
 * **The tri-state is the entire point (see `account-pin.ts`'s doc
 * comment), and this file exists to survive it through a JSON round
 * trip.** `setPin`/`unsetPin` below are deliberately two different
 * operations, not `setPin(path, capability, value | undefined)`: JSON has
 * no way to represent "this property is present with value `undefined`"
 * (`JSON.stringify` drops it, indistinguishable on reload from a key that
 * was never set), so collapsing "opt out" and "unset" onto one call with an
 * `undefined` branch would silently re-introduce exactly the bug this
 * module's tests guard against. `setPin(path, capability, null)` writes an
 * explicit opt-out; `unsetPin(path, capability)` deletes the key entirely,
 * reverting to unconfigured.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AccountPinMap } from './account-pin';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

const ACCOUNT_PIN_FILE_NAME = 'account-pins.json';
const ACCOUNT_PIN_SCHEMA_VERSION = 1;

interface AccountPinFileV1 {
  v: 1;
  projects: Record<string, AccountPinMap>;
}

/** Thrown for any malformed on-disk pin map (corrupt JSON, a pin value that isn't a string or `null`). Never returns a partially-valid result. */
export class AccountPinStoreError extends Error {
  constructor(message: string) {
    super(`account pin store: ${message}`);
    this.name = 'AccountPinStoreError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validates one project's raw pin record. Each value must be a `string` (a pinned account id) or `null` (opted out) — an absent key never reaches here at all, since `Object.entries` on parsed JSON only yields keys that were actually present in the file, which is exactly the property this store relies on to keep "absent" and "explicit null" distinguishable through a round trip. */
function validatePins(raw: unknown, context: string): AccountPinMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AccountPinStoreError(`${context}: must be an object`);
  }
  const pins: AccountPinMap = {};
  for (const [capability, value] of Object.entries(raw)) {
    if (value !== null && typeof value !== 'string') {
      throw new AccountPinStoreError(
        `${context}.${capability}: must be a string (a pinned account id) or null (opted out), got ${typeof value}`,
      );
    }
    pins[capability] = value;
  }
  return pins;
}

function validateFile(parsed: unknown, filePath: string): AccountPinFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AccountPinStoreError(`config file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { projects?: unknown };
  const projects: Record<string, AccountPinMap> = {};
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new AccountPinStoreError(`config file "${filePath}": "projects" must be an object`);
    }
    for (const [projectPath, value] of Object.entries(obj.projects)) {
      projects[projectPath] = validatePins(value, `${filePath} (project "${projectPath}")`);
    }
  }
  return { v: ACCOUNT_PIN_SCHEMA_VERSION, projects };
}

export interface AccountPinStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's per-project, per-capability account pin map (SPEC
 * §7.26; issue #227) across a node restart. See this module's doc comment
 * for the storage shape/rationale and why `setPin`/`unsetPin` are separate
 * operations.
 */
export class AccountPinStore {
  private readonly filePath: string;

  constructor(options: AccountPinStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, ACCOUNT_PIN_FILE_NAME);
  }

  /** `projectPath`'s full pin map — `{}` (every capability unconfigured) for a project with nothing saved. */
  get(projectPath: string): AccountPinMap {
    return { ...(this.readFile().projects[projectPath] ?? {}) };
  }

  /** Every project this node has ever recorded a pin for, keyed by `projectPath`, each value the same shape {@link get} returns for one — issue #229's scan-and-warn reads this (via `account-pin.ts`'s pure `scanPinsForAccount`) to find every project/capability still pinned to an account about to be disconnected, without needing a caller-supplied list of "known projects" (this store's own on-disk file already is that list, scoped to projects that actually have a pin). A shallow clone per project, same defensive copy {@link get} already makes, so a caller can never mutate this store's cached state by holding onto the result. */
  allProjectPins(): Record<string, AccountPinMap> {
    const { projects } = this.readFile();
    const result: Record<string, AccountPinMap> = {};
    for (const [projectPath, pins] of Object.entries(projects)) {
      result[projectPath] = { ...pins };
    }
    return result;
  }

  /** `projectPath`'s pin for `capability` — `undefined` (unconfigured), `null` (opted out), or the pinned account id, matching {@link AccountPinMap}'s own tri-state exactly. */
  getPin(projectPath: string, capability: string): string | null | undefined {
    return this.get(projectPath)[capability];
  }

  /** Sets `capability`'s pin to `accountId`, or to `null` for an explicit opt-out — every other capability already saved for `projectPath` is left untouched. To revert to "unconfigured" (remove the key entirely, not `null`), use {@link unsetPin}. */
  setPin(projectPath: string, capability: string, accountId: string | null): void {
    const file = this.readFile();
    const pins = { ...(file.projects[projectPath] ?? {}) };
    pins[capability] = accountId;
    file.projects[projectPath] = pins;
    this.writeFile(file);
  }

  /** Deletes `capability`'s pin for `projectPath` entirely, reverting it to "unconfigured" (an absent key, distinct from the explicit `null` {@link setPin} writes for "opted out"). A no-op if it had none. */
  unsetPin(projectPath: string, capability: string): void {
    const file = this.readFile();
    const pins = { ...(file.projects[projectPath] ?? {}) };
    delete pins[capability];
    file.projects[projectPath] = pins;
    this.writeFile(file);
  }

  /** Removes every pin for `projectPath`. A no-op if it had none. */
  remove(projectPath: string): void {
    const file = this.readFile();
    delete file.projects[projectPath];
    this.writeFile(file);
  }

  private readFile(): AccountPinFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: ACCOUNT_PIN_SCHEMA_VERSION, projects: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new AccountPinStoreError(
        `config file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: AccountPinFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
