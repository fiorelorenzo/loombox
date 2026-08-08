import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

/**
 * Refuses to let a second node process start against a state dir another
 * live node process already holds (issue #929: two `devbox-node-1`
 * processes held the same identity against the production relay for 15
 * hours — both inside one systemd cgroup, both reconnecting and logging
 * `connected` on every relay restart, both looking perfectly healthy,
 * because nothing on the node side ever checked). A state dir IS a node's
 * identity — it's where `identity.ts`'s `NodeIdentityStore` keeps the
 * private key a node authenticates to the relay with (issue #815) — so
 * "refuse a second node on an already-held state dir" and "refuse a second
 * node holding the same identity" are the same check.
 *
 * **Why a plain PID file, not `flock(2)`/a real advisory lock.** There is
 * no cross-platform advisory-lock primitive in Node's own `fs` module, and
 * this package already has a working, tested precedent for "the file on
 * disk is the durable source of truth, checked and repaired on every
 * read" (`identity.ts`'s own doc comment) rather than reaching for a new
 * dependency. The risk a naive PID file usually has — a hard-killed
 * holder's stale lock wedging every future start — is handled explicitly
 * by {@link acquireNodeLock}'s staleness check below, which is the actual
 * hard part; once that's right, "write a PID, read a PID" is enough.
 *
 * **The staleness check, and its one accepted gap.** A held lock is
 * "stale" (safe to steal) only when {@link acquireNodeLock} can positively
 * confirm the recorded holder is gone: `process.kill(pid, 0)` throwing
 * `ESRCH`, or (Linux only) `/proc/sys/kernel/random/boot_id` no longer
 * matching what the lock recorded — a reboot resets the entire process
 * table, so a pre-reboot pid cannot possibly still be that holder no
 * matter what `kill(pid, 0)` says about whatever now happens to have that
 * number. `EPERM` (a process exists, owned by someone else) and any
 * content this code can't parse are both treated as *live* — refusing to
 * start is always the safe failure here, since erroneously stealing a live
 * lock reproduces issue #929 itself, while erroneously refusing a start
 * just means an operator has to look. The one gap this doesn't close: a
 * dead holder's pid reused by an unrelated process, on the same boot,
 * before this runs — accepted as vanishingly unlikely (Linux's pid
 * allocator cycles through the full pid space before reusing one) rather
 * than solved, exactly like every other plain-PID-file scheme.
 */
export const NODE_LOCK_FILE_NAME = 'node.lock';

interface PersistedNodeLock {
  pid: number;
  nodeId?: string;
  hostname: string;
  bootId?: string;
  acquiredAt: string;
  /** Disambiguates this exact acquisition from a later one that reused the same pid — `release()` only ever unlinks a file whose content still matches what THIS acquisition wrote (see {@link acquireNodeLock}'s own doc comment on the release race it closes). */
  token: string;
}

/** Thrown by {@link acquireNodeLock} when another live process already holds the lock. Carries the holder's pid/nodeId so a caller (or a test) can assert on specifics rather than parsing the message. */
export class NodeLockHeldError extends Error {
  readonly stateDir: string;
  readonly holderPid: number;
  readonly holderNodeId: string | undefined;

  constructor(stateDir: string, holder: PersistedNodeLock) {
    super(
      `NodeLockHeldError: refusing to start — pid ${holder.pid}` +
        (holder.nodeId ? ` (node id "${holder.nodeId}")` : '') +
        ` already holds the identity under ${stateDir} (acquired ${holder.acquiredAt}). ` +
        'Running two node processes against one identity is exactly issue #929: the relay ' +
        'accepts both and neither side notices for as long as both stay up. Stop the other ' +
        'process before starting this one — or, if you are certain it is not actually a live ' +
        `node (e.g. it survived from a different boot), remove ${path.join(stateDir, NODE_LOCK_FILE_NAME)} by hand.`,
    );
    this.name = 'NodeLockHeldError';
    this.stateDir = stateDir;
    this.holderPid = holder.pid;
    this.holderNodeId = holder.nodeId;
  }
}

/** Thrown by {@link acquireNodeLock} when the lock file exists but isn't in a shape this code recognizes — deliberately never auto-removed (unlike a confirmed-stale lock): an unrecognized file might be a future format this code predates, and guessing wrong here means silently letting two nodes run, the exact bug this module exists to prevent. */
export class NodeLockCorruptError extends Error {
  readonly stateDir: string;

  constructor(stateDir: string, raw: string) {
    super(
      `NodeLockCorruptError: the lock file under ${stateDir} exists but isn't recognized ` +
        `(content: ${JSON.stringify(raw.slice(0, 200))}). Not removing it automatically — ` +
        'confirm no node process is actually using this state dir, then delete ' +
        `${path.join(stateDir, NODE_LOCK_FILE_NAME)} by hand.`,
    );
    this.name = 'NodeLockCorruptError';
    this.stateDir = stateDir;
  }
}

export interface AcquireNodeLockOptions {
  /** Defaults to `defaultNodeStateDir()` — the same default `identity.ts`'s `NodeIdentityStore` uses, so "one state dir" and "one lock" stay the same directory without every caller repeating the default. */
  stateDir?: string;
  /** Embedded in the lock file and in {@link NodeLockHeldError}'s message purely for a human reading `cat node.lock` or a refused startup log — never compared against anything. */
  nodeId?: string;
}

export interface NodeLock {
  /** Absolute path to the lock file this lock wrote. */
  readonly path: string;
  /**
   * Removes the lock file — but only if it still holds exactly the bytes
   * this acquisition wrote. If the content differs, some other code path
   * already reclaimed it (this acquisition's holder was itself perceived
   * stale and stolen from — see {@link acquireNodeLock}'s steal race), and
   * unlinking now would delete a live process's real lock; this logs a
   * warning and leaves the file alone instead. Idempotent: releasing twice,
   * or a file that's already gone, is a silent no-op.
   */
  release(): void;
}

function currentBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return undefined;
  }
}

function isLive(holder: PersistedNodeLock): boolean {
  const bootId = currentBootId();
  if (holder.bootId !== undefined && bootId !== undefined && holder.bootId !== bootId) {
    // The machine has rebooted since this lock was written — the process
    // table was wiped, so `holder.pid` cannot possibly still be the same
    // process no matter what `kill(pid, 0)` reports about whatever now
    // happens to hold that number.
    return false;
  }
  try {
    process.kill(holder.pid, 0);
    return true; // Exists (or exists-but-forbidden — see EPERM below); either way, something is there.
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // No such process — genuinely gone.
    if (code === 'EPERM') return true; // Exists, owned by someone else — the conservative default.
    throw error;
  }
}

function parseLock(raw: string): PersistedNodeLock | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as Partial<PersistedNodeLock>;
  if (
    typeof candidate.pid !== 'number' ||
    typeof candidate.hostname !== 'string' ||
    typeof candidate.acquiredAt !== 'string' ||
    typeof candidate.token !== 'string'
  ) {
    return undefined;
  }
  return {
    pid: candidate.pid,
    nodeId: candidate.nodeId,
    hostname: candidate.hostname,
    bootId: candidate.bootId,
    acquiredAt: candidate.acquiredAt,
    token: candidate.token,
  };
}

/**
 * Claims the exclusive right to run a node against `stateDir`, or throws.
 * Real callers ({@link ../main.ts}'s `start()`) call this once at startup,
 * before anything else touches `stateDir`, and call the returned
 * {@link NodeLock.release} from their own graceful-shutdown path — a hard
 * kill (`SIGKILL`, a crash) skips that release entirely, which is fine and
 * expected: the next `acquireNodeLock` against the same `stateDir` detects
 * the old pid is gone (this function's own staleness check) and steals the
 * lock rather than wedging forever, exactly issue #929's own "the classic
 * way a naive lockfile makes things worse than the bug it fixes" concern.
 *
 * **The steal race.** Two processes can both observe the same stale lock
 * and both decide to steal it. Both unlink it (the loser's unlink is a
 * harmless no-op — `ENOENT` is swallowed) and both retry the exclusive
 * `open(path, 'wx')` that only one of them can win (`O_CREAT|O_EXCL` is a
 * single atomic kernel call); the loser sees `EEXIST` again, re-reads,
 * and this time finds the winner's fresh, live lock — so it correctly
 * throws {@link NodeLockHeldError} instead of a second "I stole it too".
 */
export function acquireNodeLock(options: AcquireNodeLockOptions = {}): NodeLock {
  const stateDir = options.stateDir ?? defaultNodeStateDir();
  const lockPath = path.join(stateDir, NODE_LOCK_FILE_NAME);
  mkdirSync(stateDir, { recursive: true });

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const content: PersistedNodeLock = {
      pid: process.pid,
      nodeId: options.nodeId,
      hostname: hostname(),
      bootId: currentBootId(),
      acquiredAt: new Date().toISOString(),
      token: randomUUID(),
    };
    const serialized = JSON.stringify(content);

    try {
      writeFileExclusive(lockPath, serialized);
      return {
        path: lockPath,
        release: () => releaseLock(lockPath, serialized),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let existingRaw: string;
    try {
      existingRaw = readFileSync(lockPath, 'utf8');
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue; // Removed between our EEXIST and this read — retry the create.
      throw readError;
    }

    const holder = parseLock(existingRaw);
    if (!holder) throw new NodeLockCorruptError(stateDir, existingRaw);
    if (isLive(holder)) throw new NodeLockHeldError(stateDir, holder);

    // Confirmed stale: steal it, but only if it's still the exact stale
    // bytes just inspected (guards the race documented above).
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === existingRaw) {
        unlinkSync(lockPath);
      }
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
    }
    // Loop back and retry the exclusive create.
  }

  throw new Error(
    `acquireNodeLock: gave up after ${maxAttempts} attempts contesting a repeatedly-stolen ` +
      `lock at ${lockPath}; another process is racing this one hard enough that this is no ` +
      'longer a plausible one-off. Investigate rather than retrying blindly.',
  );
}

function writeFileExclusive(filePath: string, content: string): void {
  // `wx`: O_CREAT|O_EXCL — atomically fails with `EEXIST` if the file
  // already exists, never overwrites. This one call is what makes the
  // whole "only one process can win the create" race-safety above true.
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function releaseLock(lockPath: string, expectedContent: string): void {
  let current: string;
  try {
    current = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // Already gone — fine.
    throw error;
  }
  if (current !== expectedContent) {
    console.warn(
      `NodeLock: not releasing ${lockPath} — its content no longer matches what this ` +
        'process wrote, meaning another process already perceived this holder as stale and ' +
        'stole it. Leaving the current (live) lock untouched.',
    );
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
