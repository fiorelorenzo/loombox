/* ---------------------------------------------------------------------
 * Node-side persistence for `SessionManager`'s session records (issue
 * #515): a node restart used to forget every `Session` it owned while the
 * relay's Postgres-backed board kept listing them — the row could never be
 * resumed, and its git worktree (named only by `Session.projectPath`, which
 * never leaves the encrypted envelope, SPEC §8) was orphaned on disk
 * forever, since nothing remembered where it was.
 *
 * A single JSON file, mirroring `mcp-config-store.ts`'s `McpConfigStore`
 * shape/conventions exactly: sync `node:fs`, a private `readFile`/
 * `writeFile` pair, an injectable `stateDir` defaulting to
 * `defaultNodeStateDir()`. Every mutation re-reads then rewrites the whole
 * file — sessions are a handful of small records per node, not a
 * high-frequency write path, so there is no need for anything fancier.
 * --------------------------------------------------------------------- */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadJsonFile } from './json-store';
import { defaultNodeStateDir } from './ssh/verify-and-persist';
import type { Session, SessionLifecycleState } from './session-manager';

const SESSION_STORE_FILE_NAME = 'sessions.json';
const SESSION_STORE_SCHEMA_VERSION = 1;

interface SessionsFileV1 {
  v: 1;
  sessions: Session[];
}

/** Thrown for a corrupt `sessions.json` (bad JSON, or a record missing/mistyping a required field) — mirrors `McpConfigError`'s "name the offending part, never return a partially-valid result" contract. */
export class SessionStoreError extends Error {
  constructor(message: string) {
    super(`session store: ${message}`);
    this.name = 'SessionStoreError';
  }
}

const VALID_STATES: SessionLifecycleState[] = ['running', 'paused', 'ended', 'disconnected'];

function validateSession(raw: unknown, context: string): Session {
  if (typeof raw !== 'object' || raw === null) {
    throw new SessionStoreError(`${context}: must be an object`);
  }
  const record = raw as Partial<Session>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new SessionStoreError(`${context}: "id" must be a non-empty string`);
  }
  if (typeof record.projectPath !== 'string') {
    throw new SessionStoreError(`${context}: "projectPath" must be a string`);
  }
  if (typeof record.worktreePath !== 'string') {
    throw new SessionStoreError(`${context}: "worktreePath" must be a string`);
  }
  if (record.target !== 'local' && record.target !== 'ssh') {
    throw new SessionStoreError(`${context}: "target" must be "local" or "ssh"`);
  }
  if (typeof record.provider !== 'string') {
    throw new SessionStoreError(`${context}: "provider" must be a string`);
  }
  if (typeof record.branch !== 'string') {
    throw new SessionStoreError(`${context}: "branch" must be a string`);
  }
  if (typeof record.createdAt !== 'number') {
    throw new SessionStoreError(`${context}: "createdAt" must be a number`);
  }
  if (typeof record.state !== 'string' || !VALID_STATES.includes(record.state)) {
    throw new SessionStoreError(`${context}: "state" must be one of ${VALID_STATES.join(', ')}`);
  }
  if (record.nodeId !== undefined && typeof record.nodeId !== 'string') {
    throw new SessionStoreError(`${context}: "nodeId" must be a string when present`);
  }
  if (record.targetId !== undefined && typeof record.targetId !== 'string') {
    throw new SessionStoreError(`${context}: "targetId" must be a string when present`);
  }
  if (
    record.spendCapUsd !== undefined &&
    (typeof record.spendCapUsd !== 'number' ||
      !Number.isFinite(record.spendCapUsd) ||
      record.spendCapUsd <= 0)
  ) {
    throw new SessionStoreError(
      `${context}: "spendCapUsd" must be a positive, finite number when present`,
    );
  }
  if (record.acpSessionId !== undefined && typeof record.acpSessionId !== 'string') {
    throw new SessionStoreError(`${context}: "acpSessionId" must be a string when present`);
  }
  return {
    id: record.id,
    projectPath: record.projectPath,
    worktreePath: record.worktreePath,
    target: record.target,
    provider: record.provider,
    branch: record.branch,
    createdAt: record.createdAt,
    state: record.state,
    nodeId: record.nodeId,
    targetId: record.targetId,
    spendCapUsd: record.spendCapUsd,
    acpSessionId: record.acpSessionId,
  };
}

function validateFile(parsed: unknown, filePath: string): SessionsFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionStoreError(`file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { sessions?: unknown };
  if (obj.sessions !== undefined && !Array.isArray(obj.sessions)) {
    throw new SessionStoreError(`file "${filePath}": "sessions" must be an array`);
  }
  const sessions = (obj.sessions ?? []).map((entry: unknown, index: number) =>
    validateSession(entry, `${filePath} (sessions[${index}])`),
  );
  return { v: SESSION_STORE_SCHEMA_VERSION, sessions };
}

export interface SessionStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store (`McpConfigStore`, `NodeMcpSecretManager`, `SshTargetStore`). */
  stateDir?: string;
}

/**
 * Persists `SessionManager`'s session records (see this module's doc
 * comment) across a node restart. Deliberately dumb: it has no opinion on
 * lifecycle state — `SessionManager` alone decides what a reloaded record's
 * state should become (see that class's own doc comment) — this just
 * round-trips whatever `Session[]` it is handed.
 */
export class SessionStore {
  private readonly filePath: string;

  constructor(options: SessionStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, SESSION_STORE_FILE_NAME);
  }

  /** Every persisted session record, in whatever state they were last saved in. Returns `[]` if no file exists yet (a fresh node). */
  load(): Session[] {
    return loadJsonFile(
      this.filePath,
      { v: SESSION_STORE_SCHEMA_VERSION, sessions: [] },
      validateFile,
      (message) => new SessionStoreError(message),
    ).sessions;
  }

  /** Replaces the on-disk record set wholesale with `sessions` — the caller (`SessionManager`) always passes its complete current set, never a delta. */
  save(sessions: readonly Session[]): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const file: SessionsFileV1 = { v: SESSION_STORE_SCHEMA_VERSION, sessions: [...sessions] };
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
