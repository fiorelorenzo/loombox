/* ---------------------------------------------------------------------
 * Node-side persistence for a project's `TrackerMode` (SPEC §7.10; issue
 * #631): the exact sibling of `account-pin-store.ts` — one JSON file
 * under `stateDir`, keyed by a project's absolute `projectPath`, the same
 * identifier `AccountPinStore`/`permission-policy-store.ts`/
 * `mcp-config-store.ts` already key their own per-project records on.
 *
 * `TrackerMode` used to live only in the browser's `localStorage`
 * (`apps/web/src/lib/tracker-mode-store.ts`), which made the node
 * structurally unable to honour it — `NodeDaemon.readTrackerSnapshot`
 * read the native store unconditionally because the native store was the
 * only thing it had. This store is the fix's node-side half: `nodeId`'s
 * own persisted answer to "how does this project track work", read and
 * written over the wire via `tracker_mode_get/set_request` (see
 * `node-daemon.ts`'s handlers) rather than trusted from whatever browser
 * last touched it.
 *
 * **Validation discipline diverges from `AccountPinStore` on purpose.**
 * `AccountPinStore` throws `AccountPinStoreError` for a pin value that
 * doesn't fit its tri-state — a deliberate "never guess" for a value with
 * no safe fallback. A `TrackerMode` already HAS a safe fallback baked into
 * its own wire contract: `trackerModeResponse.mode` is optional, and
 * "never chosen" is a real, already-modeled state a caller must already
 * handle. So an on-disk value that no longer validates against
 * `@loombox/protocol`'s `safeParseTrackerMode` (hand-edited file, a
 * future protocol version this node doesn't understand yet, ...) reads
 * back as `undefined` — the same "never chosen" state, never repaired
 * into a guessed `{kind:'native'}` — exactly the discipline the browser
 * store's own doc comment already describes, just enforced here instead.
 * A structurally corrupt FILE (unparsable JSON, not even an object) is a
 * different failure — that still throws `TrackerModeStoreError`, the same
 * as `AccountPinStore`, since there is no single project's value to
 * degrade in isolation.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { safeParseTrackerMode, type TrackerMode } from '@loombox/protocol';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const TRACKER_MODE_FILE_NAME = 'tracker-modes.json';
const TRACKER_MODE_SCHEMA_VERSION = 1;

interface TrackerModeFileV1 {
  v: 1;
  /** Raw, NOT pre-validated — each value is re-validated on every {@link TrackerModeStore.get} through `safeParseTrackerMode` rather than once at load time, so a value that was valid when written but no longer fits a newer schema degrades to absent on its own, without this store needing to notice a version change. */
  projects: Record<string, unknown>;
}

/** Thrown only for a structurally corrupt on-disk file (unparsable JSON, or JSON that isn't an object) — never for a single project's `TrackerMode` value failing schema validation, which {@link TrackerModeStore.get} degrades to `undefined` instead (see this module's doc comment). */
export class TrackerModeStoreError extends Error {
  constructor(message: string) {
    super(`tracker mode store: ${message}`);
    this.name = 'TrackerModeStoreError';
  }
}

function validateFile(parsed: unknown, filePath: string): TrackerModeFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TrackerModeStoreError(`config file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { projects?: unknown };
  const projects: Record<string, unknown> = {};
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new TrackerModeStoreError(`config file "${filePath}": "projects" must be an object`);
    }
    for (const [projectPath, value] of Object.entries(obj.projects)) {
      projects[projectPath] = value;
    }
  }
  return { v: TRACKER_MODE_SCHEMA_VERSION, projects };
}

export interface TrackerModeStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's per-project `TrackerMode` (SPEC §7.10; issue #631)
 * across a node restart. See this module's doc comment for the storage
 * shape and why an invalid on-disk value degrades to `undefined` rather
 * than throwing.
 */
export class TrackerModeStore {
  private readonly filePath: string;

  constructor(options: TrackerModeStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, TRACKER_MODE_FILE_NAME);
  }

  /**
   * `projectPath`'s saved mode. `undefined` covers two cases this store
   * deliberately never distinguishes: a project that has never had a mode
   * chosen, and one whose stored value no longer re-validates — both are
   * "this node has no trustworthy answer", and a caller (the daemon's
   * `tracker_mode_get_request` handler, the bridge dispatch reading this
   * synchronously) must already handle "never chosen" as a real state, so
   * collapsing an invalid value onto it is safe and never a silent guess.
   */
  get(projectPath: string): TrackerMode | undefined {
    const raw = this.readFile().projects[projectPath];
    if (raw === undefined) return undefined;
    const result = safeParseTrackerMode(raw);
    return result.success ? result.data : undefined;
  }

  /**
   * Saves `mode` for `projectPath`, replacing whatever was there. There is
   * deliberately no unset (mirrors `trackerModeSetRequest`'s own doc
   * comment): `{kind:'native'}` is an explicit choice a user makes, and
   * "never chosen" is only ever the initial state, never somewhere a
   * project returns to.
   */
  set(projectPath: string, mode: TrackerMode): void {
    const file = this.readFile();
    file.projects[projectPath] = mode;
    this.writeFile(file);
  }

  private readFile(): TrackerModeFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: TRACKER_MODE_SCHEMA_VERSION, projects: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TrackerModeStoreError(
        `config file "${this.filePath}" is not valid JSON: ${detail}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: TrackerModeFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
