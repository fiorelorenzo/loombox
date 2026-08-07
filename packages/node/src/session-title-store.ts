/* ---------------------------------------------------------------------
 * Node-side persistence for a session's own display title (issue #706).
 * `NodeDaemon.announce()` seals `title` into `SessionPrivateMetaV1`'s
 * ENCRYPTED envelope (SPEC §8) — the relay never sees it in the clear,
 * only the sealed bytes it caches and re-serves verbatim to any
 * subscribed client. That means once a node process exits, its own
 * in-memory copy of every session's title is gone with it; only the
 * relay's cached copy of the last envelope it was sent survives.
 *
 * That is fine for an ordinary reconnect (`NodeDaemon.reannounceAll`
 * deliberately skips re-announcing a bridge-less/`'disconnected'`
 * session — the relay's own cached envelope is "still accurate", per
 * that method's own doc comment) but not for reviving one
 * (`NodeDaemon.reviveSessionInternal`): a revival's freshly spawned
 * bridge needs a real `title` of its own, both to seal into the
 * `announce()` call it fires (refreshing `branch`, otherwise unchanged)
 * and to carry on `SessionBridge.title` for whatever LATER mere
 * reconnect `reannounceAll` re-announces it on. A placeholder there
 * would silently overwrite the relay's already-correct cached title
 * with garbage on that later reconnect — this store is what lets
 * revival avoid that.
 *
 * One JSON file, keyed by session id, mirroring `TestRunnerConfigStore`'s
 * own shape — written every time `announce()` runs (idempotent; the
 * value practically never actually changes, since this codebase has no
 * session-rename feature). Best-effort by design, unlike
 * `TestRunnerConfigStore`: a title is cosmetic, so a corrupt file or a
 * write failure degrades to "title unknown" (revival falls back to a
 * generic placeholder) rather than ever blocking the real feature
 * (reviving the agent itself).
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const SESSION_TITLE_FILE_NAME = 'session-titles.json';
const SESSION_TITLE_SCHEMA_VERSION = 1;

interface SessionTitleFileV1 {
  v: 1;
  titles: Record<string, string>;
}

function validateFile(parsed: unknown): SessionTitleFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { v: SESSION_TITLE_SCHEMA_VERSION, titles: {} };
  }
  const obj = parsed as { titles?: unknown };
  const titles: Record<string, string> = {};
  if (obj.titles && typeof obj.titles === 'object' && !Array.isArray(obj.titles)) {
    for (const [id, value] of Object.entries(obj.titles as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) titles[id] = value;
    }
  }
  return { v: SESSION_TITLE_SCHEMA_VERSION, titles };
}

export interface SessionTitleStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/** Persists this node's per-session display titles across a node restart. See this module's doc comment for the storage shape/rationale. */
export class SessionTitleStore {
  private readonly filePath: string;

  constructor(options: SessionTitleStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, SESSION_TITLE_FILE_NAME);
  }

  /** `sessionId`'s last-known title, or `undefined` if this store never saw one (a session created before this store existed, or a corrupt/missing file). */
  get(sessionId: string): string | undefined {
    return this.readFile().titles[sessionId];
  }

  /** Records `sessionId`'s current title. A no-op write (no disk touch) if it already matches what's stored — `announce()` calls this on every single announce, including every reconnect re-announce, and the value practically never changes. */
  set(sessionId: string, title: string): void {
    const file = this.readFile();
    if (file.titles[sessionId] === title) return;
    file.titles[sessionId] = title;
    this.writeFile(file);
  }

  /** Forgets `sessionId`'s title — called when a session is archived/removed, so this file doesn't grow forever. A no-op if nothing was stored for it. */
  remove(sessionId: string): void {
    const file = this.readFile();
    if (!(sessionId in file.titles)) return;
    delete file.titles[sessionId];
    this.writeFile(file);
  }

  private readFile(): SessionTitleFileV1 {
    if (!existsSync(this.filePath)) return { v: SESSION_TITLE_SCHEMA_VERSION, titles: {} };
    try {
      return validateFile(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      // Best-effort by design (this module's own doc comment): a corrupt
      // file degrades to "nothing known" rather than ever throwing.
      return { v: SESSION_TITLE_SCHEMA_VERSION, titles: {} };
    }
  }

  private writeFile(file: SessionTitleFileV1): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(file, null, 2));
    } catch {
      // Best-effort (see class doc comment) — a write failure here must
      // never take down the actual `announce()` call it rides alongside.
    }
  }
}
