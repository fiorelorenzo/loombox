import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { AcpTranscriptUpdate, AcpTurnEnd } from '@loombox/providers-core';

/**
 * The on-disk, resumable per-session transcript (SPEC.md §5.6 "persists a
 * structured, resumable transcript to disk"; §7.22; §7.24; issue #77).
 *
 * Layout — one directory per session under a supervisor "state dir":
 *
 * ```
 * <stateDir>/<sessionId>/session.json   small metadata + the latest attention snapshot
 * <stateDir>/<sessionId>/log.jsonl      the ordered, append-only transcript log
 * ```
 *
 * `stateDir` defaults to `$XDG_STATE_HOME/loombox/supervisor` when
 * `XDG_STATE_HOME` is set, else `~/.loombox/supervisor` (see
 * `defaultStateDir()`), but is always injectable (`AgentSupervisorOptions.stateDir`)
 * so tests point it at an `os.mkdtemp()` directory instead of touching the
 * real home directory.
 *
 * `log.jsonl` is newline-delimited JSON, one `TranscriptLogEntry` per line,
 * written with a single synchronous `fs.appendFileSync` call per entry (a
 * single `write(2)` for a line this small) rather than queued async writes:
 * simpler than serializing a promise chain, and it makes "append, then read
 * it back" trivially ordered with no race to reason about. Every entry
 * carries `v: TRANSCRIPT_SCHEMA_VERSION` so a future format change can branch
 * on it (issue #77's "the format is versioned" acceptance criterion);
 * `readLog()` tolerates and drops a trailing unparseable line, since a crash
 * mid-write can at worst corrupt the final (still in-flight) line, never an
 * earlier, already-fsynced-by-the-OS one.
 */
export const TRANSCRIPT_SCHEMA_VERSION = 1;

/** The attention-worthy states a session can be in (SPEC.md §5.6, §7.13; issue #79). */
export type AttentionStatus =
  'working' | 'awaiting_input' | 'permission_required' | 'error' | 'exited';

/** A session's latest attention snapshot, persisted so a re-attaching caller (or a fresh supervisor) can catch up without replaying the whole log. */
export interface AttentionState {
  status: AttentionStatus;
  updatedAt: string;
  detail?: unknown;
}

export type TranscriptLogEntry =
  | { v: number; type: 'transcript_update'; seq: number; ts: string; update: AcpTranscriptUpdate }
  | { v: number; type: 'turn_end'; seq: number; ts: string; turnEnd: AcpTurnEnd }
  | { v: number; type: 'attention'; seq: number; ts: string; attention: AttentionState };

export interface SessionMetaFile {
  v: number;
  sessionId: string;
  providerId: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  attention: AttentionState;
}

/** Where a supervisor persists session state when no `stateDir` is injected (SPEC.md §5.6). */
export function defaultStateDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome && xdgStateHome.trim() !== '') {
    return path.join(xdgStateHome, 'loombox', 'supervisor');
  }
  return path.join(homedir(), '.loombox', 'supervisor');
}

export interface TranscriptStoreOptions {
  /** Injectable for tests (`os.mkdtemp`); defaults to `defaultStateDir()`. */
  stateDir?: string;
}

/**
 * Reads and writes the on-disk transcript layout described above. Pure
 * file-system state: no in-memory cache of its own (that's `AgentSession`'s
 * job, per the issue's "keep the in-memory buffer as a cache over the
 * on-disk log" instruction) except for each session's next `seq` counter,
 * which every append needs and every `readLog()` re-derives from the
 * highest `seq` already on disk — so a `TranscriptStore` opened fresh
 * against an existing state dir (the "new supervisor instance, same
 * `stateDir`" reload case) resumes numbering correctly the moment it reads
 * that session's log.
 */
export class TranscriptStore {
  readonly stateDir: string;
  private readonly seqCounters = new Map<string, number>();

  constructor(options: TranscriptStoreOptions = {}) {
    this.stateDir = options.stateDir ?? defaultStateDir();
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.stateDir, sessionId);
  }

  private logPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'log.jsonl');
  }

  private metaPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'session.json');
  }

  /** Creates a session's on-disk directory + files and writes its initial metadata. Idempotent: safe to call again for an id that already exists (used by resume/reopen paths later). */
  createSession(meta: {
    sessionId: string;
    providerId: string;
    workspacePath: string;
  }): SessionMetaFile {
    mkdirSync(this.sessionDir(meta.sessionId), { recursive: true });
    const existing = this.readMeta(meta.sessionId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const initial: SessionMetaFile = {
      v: TRANSCRIPT_SCHEMA_VERSION,
      sessionId: meta.sessionId,
      providerId: meta.providerId,
      workspacePath: meta.workspacePath,
      createdAt: now,
      updatedAt: now,
      attention: { status: 'working', updatedAt: now },
    };
    writeFileSync(this.metaPath(meta.sessionId), `${JSON.stringify(initial)}\n`, 'utf8');
    if (!existsSync(this.logPath(meta.sessionId))) {
      writeFileSync(this.logPath(meta.sessionId), '', 'utf8');
    }
    this.seqCounters.set(meta.sessionId, 0);
    return initial;
  }

  /** Appends one `session/update`-derived transcript entry (SPEC.md §7.24's reducer input shape). */
  appendTranscriptUpdate(sessionId: string, update: AcpTranscriptUpdate): void {
    this.appendEntry(sessionId, { type: 'transcript_update', update });
  }

  /** Appends a turn's completion. */
  appendTurnEnd(sessionId: string, turnEnd: AcpTurnEnd): void {
    this.appendEntry(sessionId, { type: 'turn_end', turnEnd });
  }

  /** Appends an attention-state transition AND updates `session.json`'s snapshot to match (issue #79's "persists the latest attention state"). */
  appendAttention(sessionId: string, attention: AttentionState): void {
    this.appendEntry(sessionId, { type: 'attention', attention });
    this.updateMetaAttention(sessionId, attention);
  }

  private nextSeq(sessionId: string): number {
    const next = (this.seqCounters.get(sessionId) ?? 0) + 1;
    this.seqCounters.set(sessionId, next);
    return next;
  }

  /**
   * Appends never throw: they run from inside `AgentSession`'s live
   * event-handling path (a child process event handler, not something a
   * caller `await`s or wraps in `try`/`catch`), most often well after the
   * code that started the session has moved on. A best-effort persistence
   * write failing (the session's directory having since been removed, a
   * transient disk error, ...) must not crash that handler or take down an
   * otherwise-healthy session — it only means this one entry is missing from
   * the resumable log, not that the live session stops working.
   */
  private appendEntry(
    sessionId: string,
    partial:
      | { type: 'transcript_update'; update: AcpTranscriptUpdate }
      | { type: 'turn_end'; turnEnd: AcpTurnEnd }
      | { type: 'attention'; attention: AttentionState },
  ): void {
    const entry: TranscriptLogEntry = {
      v: TRANSCRIPT_SCHEMA_VERSION,
      seq: this.nextSeq(sessionId),
      ts: new Date().toISOString(),
      ...partial,
    } as TranscriptLogEntry;
    try {
      appendFileSync(this.logPath(sessionId), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // best-effort; see the doc comment above.
    }
  }

  private updateMetaAttention(sessionId: string, attention: AttentionState): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    const updated: SessionMetaFile = { ...meta, attention, updatedAt: new Date().toISOString() };
    try {
      writeFileSync(this.metaPath(sessionId), `${JSON.stringify(updated)}\n`, 'utf8');
    } catch {
      // best-effort; see appendEntry's doc comment above.
    }
  }

  /** This session's metadata (incl. latest attention snapshot), or `undefined` if nothing is persisted for it. */
  readMeta(sessionId: string): SessionMetaFile | undefined {
    const filePath = this.metaPath(sessionId);
    if (!existsSync(filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as SessionMetaFile;
    } catch {
      return undefined;
    }
  }

  /**
   * Parses the full on-disk log for a session, oldest first, tolerating (by
   * dropping) a trailing partial/corrupt line — see the class doc comment.
   * Also re-derives this store's `seq` counter for the session from the
   * highest entry found, so subsequent appends continue numbering correctly.
   */
  readLog(sessionId: string): TranscriptLogEntry[] {
    const filePath = this.logPath(sessionId);
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    const entries: TranscriptLogEntry[] = [];
    let maxSeq = 0;
    for (const line of lines) {
      let entry: TranscriptLogEntry;
      try {
        entry = JSON.parse(line) as TranscriptLogEntry;
      } catch {
        // A crash mid-write can only ever corrupt the final, still-in-flight
        // line; stop here rather than risk treating garbage as data.
        break;
      }
      entries.push(entry);
      if (entry.seq > maxSeq) maxSeq = entry.seq;
    }
    this.seqCounters.set(sessionId, maxSeq);
    return entries;
  }

  /** Every enriched `AcpTranscriptUpdate` recorded for a session, oldest first (a convenience filter over `readLog()`). */
  readTranscriptUpdates(sessionId: string): AcpTranscriptUpdate[] {
    return this.readLog(sessionId)
      .filter(
        (entry): entry is Extract<TranscriptLogEntry, { type: 'transcript_update' }> =>
          entry.type === 'transcript_update',
      )
      .map((entry) => entry.update);
  }

  /** Every session id with a persisted directory under this store's state dir (SPEC.md §5.6's "enumerate persisted sessions on startup"). */
  listSessionIds(): string[] {
    if (!existsSync(this.stateDir)) return [];
    return readdirSync(this.stateDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }
}
