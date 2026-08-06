import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CiWatchEntry } from './ci-check-watcher';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

/* ---------------------------------------------------------------------
 * Node-side persistence for which sessions `CiCheckWatcher` should be
 * polling (SPEC §7.14; issue #239), mirroring `spend-cap-store.ts`'s own
 * shape/rationale almost exactly: one small JSON file, re-read then
 * rewritten whole on every mutation (a session opening a PR, or being
 * archived, is nowhere near a hot path). Keyed by `Session.id` rather
 * than `projectPath` — unlike a spend cap, a watch is genuinely per
 * SESSION (one session's branch, one open PR), not per project.
 *
 * This store is what lets `NodeDaemon` re-register every still-open PR's
 * watch with a fresh in-memory `CiCheckWatcher` after a restart —
 * without it, a node restart would silently stop watching every PR that
 * was open before it, with nothing telling the operator watching had
 * stopped.
 * --------------------------------------------------------------------- */

const CI_WATCH_FILE_NAME = 'ci-check-watches.json';
const CI_WATCH_SCHEMA_VERSION = 1;

interface CiWatchFileV1 {
  v: 1;
  sessions: Record<string, CiWatchEntry>;
}

/** Thrown for any malformed on-disk CI-watch file (corrupt JSON, or an entry missing/mistyping one of `CiWatchEntry`'s fields). Never returns a partially-valid result. */
export class CiWatchStoreError extends Error {
  constructor(message: string) {
    super(`ci watch store: ${message}`);
    this.name = 'CiWatchStoreError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateEntry(raw: unknown, context: string): CiWatchEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw new CiWatchStoreError(`${context}: must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const field of ['owner', 'repo', 'ref', 'prUrl', 'projectPath']) {
    if (typeof obj[field] !== 'string' || obj[field] === '') {
      throw new CiWatchStoreError(`${context}: "${field}" must be a non-empty string`);
    }
  }
  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new CiWatchStoreError(`${context}: "prNumber" must be a positive integer`);
  }
  return {
    owner: obj.owner as string,
    repo: obj.repo as string,
    ref: obj.ref as string,
    prNumber: obj.prNumber,
    prUrl: obj.prUrl as string,
    projectPath: obj.projectPath as string,
  };
}

function validateFile(parsed: unknown, filePath: string): CiWatchFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CiWatchStoreError(`config file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { sessions?: unknown };
  const sessions: Record<string, CiWatchEntry> = {};
  if (obj.sessions !== undefined) {
    if (typeof obj.sessions !== 'object' || obj.sessions === null || Array.isArray(obj.sessions)) {
      throw new CiWatchStoreError(`config file "${filePath}": "sessions" must be an object`);
    }
    for (const [sessionId, value] of Object.entries(obj.sessions)) {
      sessions[sessionId] = validateEntry(value, `${filePath} (session "${sessionId}")`);
    }
  }
  return { v: CI_WATCH_SCHEMA_VERSION, sessions };
}

export interface CiWatchStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/** One persisted watch entry, with the session id it belongs to — {@link CiWatchStore.list}'s own return shape. */
export interface CiWatchRecord extends CiWatchEntry {
  readonly sessionId: string;
}

/**
 * Persists which of this node's sessions `CiCheckWatcher` should be
 * polling, across a node restart. See this module's own top comment for
 * the storage shape/rationale.
 */
export class CiWatchStore {
  private readonly filePath: string;

  constructor(options: CiWatchStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, CI_WATCH_FILE_NAME);
  }

  /** `sessionId`'s saved watch entry, or `undefined` when this session has no open-PR watch registered (never opened a PR, or was later unwatched). */
  get(sessionId: string): CiWatchEntry | undefined {
    return this.readFile().sessions[sessionId];
  }

  /** Every persisted watch entry, each tagged with its own session id — what `NodeDaemon` re-registers with a fresh `CiCheckWatcher` on startup. */
  list(): CiWatchRecord[] {
    return Object.entries(this.readFile().sessions).map(([sessionId, entry]) => ({
      sessionId,
      ...entry,
    }));
  }

  /** Creates or replaces `sessionId`'s watch entry — called right after a session's PR is confirmed open (issue #238's `openPr`). */
  set(sessionId: string, entry: CiWatchEntry): void {
    const file = this.readFile();
    file.sessions[sessionId] = entry;
    this.writeFile(file);
  }

  /** Forgets `sessionId`'s watch entry — called when a session is archived, so a later restart never re-registers a watch for a session that no longer exists. A no-op if nothing was saved for it. */
  remove(sessionId: string): void {
    const file = this.readFile();
    if (!(sessionId in file.sessions)) return;
    delete file.sessions[sessionId];
    this.writeFile(file);
  }

  private readFile(): CiWatchFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: CI_WATCH_SCHEMA_VERSION, sessions: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new CiWatchStoreError(
        `config file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: CiWatchFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
