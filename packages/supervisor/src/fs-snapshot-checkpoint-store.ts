import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { generateCheckpointId } from './checkpoint-id';
import {
  CheckpointNotFoundError,
  type GitCheckpoint,
  type RestoreFileChange,
  type RestorePreview,
  type RestoreResult,
} from './git-checkpoint-store';
import { defaultStateDir } from './transcript-store';

/**
 * Filesystem-snapshot checkpoint & rollback engine for a project that is
 * NOT a git repository (SPEC §7.20/§6; issue #267) — `GitCheckpointStore`'s
 * own doc comment names this file as its sibling. Same public surface
 * (`checkpoint`/`listCheckpoints`/`previewRestore`/`restore`/
 * `deleteCheckpoint`/`deleteAllCheckpoints`/`filesAffectedByRestore`), same
 * `GitCheckpoint`/`RestorePreview`/`RestoreResult`/`RestoreFileChange`
 * return shapes (imported straight from that module, not redeclared), so
 * `NodeDaemon.getCheckpointStore` can hand a session either engine and
 * every caller above it — the wire protocol, `CheckpointsDialog`,
 * `CheckpointRestoreDialog` — stays unaware which kind it got.
 *
 * ## Why not git's mechanism: no ignore rules, no incremental commits
 *
 * `GitCheckpointStore` gets two things from git for free that this engine
 * cannot: `.gitignore`-filtered untracked-file detection (`git ls-files
 * --others --exclude-standard`), and a content-addressed object store that
 * already exists and already deduplicates. A folder with no `.git` has
 * neither — and, per this issue's own framing, can't be made to have the
 * first one: a `.gitignore` file sitting in a non-git folder is not
 * something `git status`/`ls-files` will ever honor without a real repo
 * behind it, and hand-parsing gitignore syntax ourselves would invent a
 * second, subtly-wrong implementation of a genuinely complex spec (glob
 * negation, per-directory scoping, `**` semantics) for a filter this
 * store's own safety story (see below) doesn't actually depend on getting
 * right. So this store treats EVERY file under `worktreePath` as part of
 * the working set — no filtering, no exclude list, no "obviously
 * generated" heuristic — and instead bounds the cost with a hard cap
 * ({@link MAX_FS_SNAPSHOT_BYTES}/{@link MAX_FS_SNAPSHOT_FILES}) that
 * refuses a checkpoint outright once the working set is too large to
 * snapshot quickly, rather than silently taking minutes on every turn.
 * See that constant's own doc comment for the real numbers this was
 * measured against.
 *
 * ## Mechanism: content-addressed blobs, same dedup property as git
 *
 * A checkpoint is a manifest — `{ path, hash, mode, size }` per file,
 * written as one JSON file — plus the file content itself, stored once
 * per unique sha256 under `<stateDir>/fs-checkpoints/<sessionId>/objects/`
 * (mirrors git's own `.git/objects/<aa>/<bb..>` layout). Content is hashed
 * before it's written, and a blob that already exists (from an earlier
 * checkpoint of the same session, including one with a completely
 * different message/id) is never rewritten — the same "an unchanged file
 * costs nothing extra per checkpoint" property `GitCheckpointStore`'s own
 * doc comment calls out for git's object store, reimplemented by hand
 * since there is no git object database to borrow here.
 *
 * Storage lives OUTSIDE `worktreePath` entirely, under this package's own
 * state dir (`{@link defaultStateDir}`, `~/.loombox/supervisor` by
 * default) rather than inside the project folder. This is not a style
 * choice: the working-set walk below has no ignore rules (previous
 * section), so anything this store wrote INSIDE `worktreePath` would be
 * picked up as part of the working set on the very next checkpoint,
 * growing without bound. Keeping every byte of bookkeeping outside the
 * folder the walk ever looks at makes that self-inclusion structurally
 * impossible rather than something a future checkpoint has to remember to
 * exclude.
 *
 * ## Restore semantics: full-tree, not incremental
 *
 * There is no staged/unstaged/tracked split to preserve here (§6: a plain
 * folder has none of git's index), so restore is simpler than
 * `GitCheckpointStore.restore`'s four-step algorithm: every file the
 * checkpoint's manifest lists is (re)written to its captured content, and
 * every file currently on disk that the manifest does NOT list is deleted
 * — the filesystem-snapshot equivalent of git's "tracked file the
 * checkpoint doesn't know about disappears" rule, just applied to
 * everything instead of only tracked content. {@link previewRestore}/
 * {@link filesAffectedByRestore} compute the same diff read-only, exactly
 * mirroring `GitCheckpointStore`'s own "no side effects" preview contract.
 *
 * **{@link MAX_FS_SNAPSHOT_BYTES}/{@link MAX_FS_SNAPSHOT_FILES} bound
 * {@link checkpoint} only.** {@link restore}/{@link previewRestore}/
 * {@link filesAffectedByRestore} never refuse for size: a working set that
 * has grown past the cap SINCE its last successful checkpoint — the exact
 * disaster this feature exists to recover from — must still be
 * rollback-able, however long that walk takes. Bounding the one operation
 * that runs unattended before every turn, while leaving the
 * explicitly-requested recovery path unbounded, is deliberate.
 */

/** Where this store's manifests/blobs live, under {@link defaultStateDir}'s own root — namespaced away from `TranscriptStore`'s `<stateDir>/<sessionId>/...` layout (same root, different top-level subdirectory) so the two never collide over the same `<sessionId>` path. */
const FS_CHECKPOINT_STATE_SUBDIR = 'fs-checkpoints';

/**
 * How many files {@link FsSnapshotCheckpointStore.checkpoint} will hash
 * and store before refusing outright (the {@link MAX_FS_SNAPSHOT_BYTES}
 * total-size cap is the other half of the same guardrail — either one
 * tripping refuses the checkpoint). Measured against a real, unmodified
 * `node_modules` tree (this monorepo's own root install: 38,042 files,
 * ~892 MB) on the reference dev box (AMD EPYC 9645, local NVMe-backed
 * disk): a full walk + sha256 of every file + content-addressed blob copy
 * took ~9.4s wall time for that whole tree (see the PR this issue shipped
 * in for the exact numbers and the script that produced them). That is
 * already well past what "before every turn" can tolerate — issue #603's
 * own measurement put `GitCheckpointStore.checkpoint()` at 45-90ms against
 * a trivial repo, and treated THAT as a real latency tax worth two
 * revisions to fix. 20,000 files / 250 MB — roughly half that real tree —
 * keeps a refused-or-not decision fast (the cap trips during the cheap
 * stat-only scan, before any hashing starts, typically well under a
 * second) and keeps an accepted checkpoint's worst case in the low
 * single-digit seconds rather than double digits. A project that
 * routinely exceeds this — most commonly an already-installed
 * `node_modules`/`vendor`/build-output tree sitting inside the project
 * folder with no `.gitignore` to exclude it from a git repo either — is
 * exactly the case §7.20's design question ("what to snapshot and how not
 * to make it ruinous") named as unusable for a naive full-tree copy; the
 * honest answer for a folder that large is "initialize a git repo", where
 * checkpointing is incremental and content-addressed against history that
 * already exists, not "silently take minutes on every turn".
 */
export const MAX_FS_SNAPSHOT_FILES = 20_000;

/** The total-bytes half of {@link MAX_FS_SNAPSHOT_FILES}'s own cap — see that constant's doc comment for the measurement it's based on. 250 MB. */
export const MAX_FS_SNAPSHOT_BYTES = 250 * 1024 * 1024;

/** How many files {@link FsSnapshotCheckpointStore} hashes/copies (or, for restore, writes) concurrently — bounds open file descriptors on a large tree while still overlapping I/O across many small files. */
const IO_CONCURRENCY = 32;

/** Thrown by {@link FsSnapshotCheckpointStore.checkpoint} when the working set exceeds {@link MAX_FS_SNAPSHOT_FILES}/{@link MAX_FS_SNAPSHOT_BYTES} — see this module's own doc comment for why only `checkpoint()` (never restore) enforces this. */
export class SnapshotTooLargeError extends Error {
  constructor(
    readonly worktreePath: string,
    readonly filesScanned: number,
    readonly bytesScanned: number,
  ) {
    super(
      `${worktreePath}: working set exceeds this checkpoint engine's limit of ` +
        `${MAX_FS_SNAPSHOT_FILES.toLocaleString()} files / ` +
        `${Math.round(MAX_FS_SNAPSHOT_BYTES / (1024 * 1024))} MB (at least ` +
        `${bytesScanned >= MAX_FS_SNAPSHOT_BYTES ? Math.round(bytesScanned / (1024 * 1024)) + ' MB' : filesScanned.toLocaleString() + ' files'} ` +
        'scanned before refusing) — refusing rather than silently taking minutes on every ' +
        'turn (issue #267). A git repository checkpoints incrementally and has no such limit; ' +
        'for a plain folder this large, exclude generated/vendored directories from the ' +
        'project folder or initialize a git repo.',
    );
    this.name = 'SnapshotTooLargeError';
  }
}

/** One file mode this store tracks — mirrors the three git blob modes {@link GitCheckpointStore.restore} already writes (`100644`/`100755`) plus the symlink one (`120000`), so a manifest entry's `mode` means exactly what it would in a real git tree. */
type FsSnapshotFileMode = '100644' | '100755' | '120000';

interface FsSnapshotFileEntry {
  /** POSIX-style, `worktreePath`-relative (`/`-separated regardless of host OS), matching `GitCheckpoint`'s own path convention. */
  path: string;
  hash: string;
  mode: FsSnapshotFileMode;
  size: number;
}

interface FsSnapshotManifest {
  v: 1;
  id: string;
  sessionId: string;
  message: string;
  createdAt: number;
  files: FsSnapshotFileEntry[];
}

export interface FsSnapshotCheckpointStoreOptions {
  /** Absolute path to the (non-git) project folder this store checkpoints/restores — a work-in-place session's `worktreePath` (`@loombox/node`'s `Session.worktreePath`, equal to `projectPath` for a non-git session per `SessionManager.createSession`'s own `workInPlace` branch), though this class has no dependency on that type. */
  worktreePath: string;
  /** Namespaces this store's checkpoints under `<stateDir>/fs-checkpoints/<sessionId>/...`, mirroring `GitCheckpointStoreOptions.sessionId`'s own "two sessions sharing a project never collide" reasoning. */
  sessionId: string;
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultStateDir()` (this package's own `~/.loombox/supervisor` convention, `./transcript-store.ts`). Always OUTSIDE `worktreePath` — see this module's doc comment for why that isn't optional. */
  stateDir?: string;
  /** Overrides {@link MAX_FS_SNAPSHOT_FILES} for this instance only — a test seam so `SnapshotTooLargeError`'s own refusal is unit-testable against a handful of files rather than the real 20,000-file production cap. Production code (`NodeDaemon.getCheckpointStore`) never passes this; defaults to {@link MAX_FS_SNAPSHOT_FILES}. */
  maxFiles?: number;
  /** Overrides {@link MAX_FS_SNAPSHOT_BYTES} for this instance only — same test-seam reasoning as {@link maxFiles}. Defaults to {@link MAX_FS_SNAPSHOT_BYTES}. */
  maxBytes?: number;
}

interface WalkedEntry {
  relPath: string;
  absPath: string;
  size: number;
  mode: FsSnapshotFileMode;
  /** Only set for a `mode: '120000'` (symlink) entry — its target string, read once during the walk so hashing never has to `readlink` a second time. */
  symlinkTarget?: string;
}

interface HashedEntry extends WalkedEntry {
  hash: string;
}

type RestoreChange =
  | { relPath: string; action: 'delete' }
  | { relPath: string; action: 'restore'; hash: string; mode: FsSnapshotFileMode };

/** Runs `fn` over `items` with at most `limit` in flight at once — bounds open file descriptors on a large working-set walk while still overlapping I/O. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** A deterministic fingerprint over a manifest's own file list — sorted by path so file-list order never affects it — playing the role `GitCheckpoint.commit`/`baseCommit` play for a real git commit hash. There is no real "commit" here (no git object was ever created), so both fields get the same value; see {@link toGitCheckpoint}'s own doc comment. */
function manifestFingerprint(files: readonly FsSnapshotFileEntry[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.mode} ${file.hash} ${file.path}\n`);
  }
  return hash.digest('hex');
}

/**
 * Owns checkpoint/restore for one (non-git) project + session pairing.
 * Stateless beyond its constructor options, exactly like
 * `GitCheckpointStore` — every checkpoint's real state lives on disk under
 * `stateDir`, so a fresh instance pointed at the same
 * `worktreePath`/`sessionId`/`stateDir` sees exactly the same checkpoints.
 */
export class FsSnapshotCheckpointStore {
  private readonly worktreePath: string;
  private readonly sessionId: string;
  private readonly root: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(options: FsSnapshotCheckpointStoreOptions) {
    this.worktreePath = options.worktreePath;
    this.sessionId = options.sessionId;
    this.root = path.join(
      options.stateDir ?? defaultStateDir(),
      FS_CHECKPOINT_STATE_SUBDIR,
      options.sessionId,
    );
    this.maxFiles = options.maxFiles ?? MAX_FS_SNAPSHOT_FILES;
    this.maxBytes = options.maxBytes ?? MAX_FS_SNAPSHOT_BYTES;
  }

  private get manifestsDir(): string {
    return path.join(this.root, 'checkpoints');
  }

  private get objectsDir(): string {
    return path.join(this.root, 'objects');
  }

  private manifestPath(checkpointId: string): string {
    return path.join(this.manifestsDir, `${checkpointId}.json`);
  }

  private objectPath(hash: string): string {
    return path.join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
  }

  private absPath(relPath: string): string {
    return path.join(this.worktreePath, ...relPath.split('/'));
  }

  /**
   * Walks every regular file and symlink under `worktreePath` (no ignore
   * rules — this module's own doc comment). When `enforceLimit` is true
   * (only {@link checkpoint} passes this), throws
   * {@link SnapshotTooLargeError} the moment the running file count or
   * byte total crosses {@link MAX_FS_SNAPSHOT_FILES}/
   * {@link MAX_FS_SNAPSHOT_BYTES} — a cheap stat-only pass (no file
   * content is read here), so refusing a too-large tree costs one
   * directory scan, never a hash of gigabytes of content that's about to
   * be discarded anyway. `enforceLimit: false` (restore's own read path)
   * never throws for size — see the module doc comment's "bound
   * `checkpoint` only" section.
   */
  private async walkWorktree(options: { enforceLimit: boolean }): Promise<WalkedEntry[]> {
    const entries: WalkedEntry[] = [];
    let totalBytes = 0;
    const stack: string[] = [this.worktreePath];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        // Removed mid-walk (a concurrent agent write) — skip it, same
        // "best-effort against a live, mutating tree" spirit as
        // `GitCheckpointStore.restore`'s own untracked-file wipe (`rm`
        // with `force: true`).
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw error;
      }

      for (const dirent of dirents) {
        const absPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(absPath);
          continue;
        }
        // Sockets/FIFOs/devices aren't real working-set content — `git
        // ls-files` would never surface them either.
        if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;

        const relPath = path.relative(this.worktreePath, absPath).split(path.sep).join('/');
        let entry: WalkedEntry;
        if (dirent.isSymbolicLink()) {
          const target = await readlink(absPath);
          entry = {
            relPath,
            absPath,
            size: Buffer.byteLength(target, 'utf8'),
            mode: '120000',
            symlinkTarget: target,
          };
        } else {
          const st = await stat(absPath);
          entry = {
            relPath,
            absPath,
            size: st.size,
            mode: (st.mode & 0o111) !== 0 ? '100755' : '100644',
          };
        }

        entries.push(entry);
        totalBytes += entry.size;
        if (
          options.enforceLimit &&
          (entries.length > this.maxFiles || totalBytes > this.maxBytes)
        ) {
          throw new SnapshotTooLargeError(this.worktreePath, entries.length, totalBytes);
        }
      }
    }

    return entries;
  }

  /** Hashes every entry (streamed for regular files; the already-read symlink target for a `120000` one), optionally persisting each unique blob into {@link objectsDir} — `persistBlobs: false` is the read-only path {@link computeDiff} uses (preview/`filesAffectedByRestore` promise no side effects, exactly like `GitCheckpointStore`'s own preview methods). */
  private async hashEntries(
    entries: readonly WalkedEntry[],
    options: { persistBlobs: boolean },
  ): Promise<HashedEntry[]> {
    if (options.persistBlobs) await mkdir(this.objectsDir, { recursive: true });
    return mapWithConcurrency(entries, IO_CONCURRENCY, async (entry) => {
      const hash =
        entry.mode === '120000'
          ? createHash('sha256').update(entry.symlinkTarget!, 'utf8').digest('hex')
          : await this.hashFile(entry.absPath);
      if (options.persistBlobs) await this.storeBlob(entry, hash);
      return { ...entry, hash };
    });
  }

  /** Streamed (never buffers a whole file into memory, however large) so a single oversized file in the working set can't blow up this process's heap — the concrete failure mode a full `readFile` would risk. */
  private hashFile(absPath: string): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    return promise;
  }

  /** Writes `entry`'s content into the content-addressed blob store under `hash`, unless a blob for that hash is already there — the dedup property this module's own doc comment describes. Writes to a per-call temp path first and `rename`s into place, so a crash mid-write can never leave a partial/corrupt blob at `hash`'s own path (the same "atomic, never a torn write" property `GitCheckpointStore` gets for free from `git update-ref`). */
  private async storeBlob(entry: WalkedEntry, hash: string): Promise<void> {
    const dest = this.objectPath(hash);
    if (await pathExists(dest)) return;
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    if (entry.mode === '120000') {
      await writeFile(tmp, entry.symlinkTarget!, 'utf8');
    } else {
      await copyFile(entry.absPath, tmp);
    }
    await rename(tmp, dest);
  }

  private async loadManifest(checkpointId: string): Promise<FsSnapshotManifest> {
    try {
      return JSON.parse(
        await readFile(this.manifestPath(checkpointId), 'utf8'),
      ) as FsSnapshotManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new CheckpointNotFoundError(this.sessionId, checkpointId);
      }
      throw error;
    }
  }

  private toGitCheckpoint(manifest: FsSnapshotManifest): GitCheckpoint {
    // `commit`/`baseCommit` normally distinguish "this checkpoint's own
    // content" from "HEAD at checkpoint time" (git's real two commits).
    // There is no git commit here at all — both get this manifest's own
    // fingerprint, since a filesystem-snapshot checkpoint has no
    // meaningful "base" separate from itself (module doc comment's
    // "full-tree, not incremental"). `hasStagedChanges`/
    // `hasUnstagedChanges` are always false (no index exists to split
    // against); `hasUntrackedFiles` is true whenever the checkpoint
    // captured anything at all — the closest honest analogue, since
    // EVERY captured file is "untracked" by this engine's own definition.
    // None of these four booleans are rendered by `CheckpointsDialog`/
    // `CheckpointRestoreDialog` today (only `message`/`createdAt` and
    // `RestorePreview.hasUncommittedChangesToDiscard`/`isWorkInPlace`
    // are), so this is a documented, harmless placeholder rather than a
    // value anything currently depends on.
    const fingerprint = manifestFingerprint(manifest.files);
    return {
      id: manifest.id,
      sessionId: manifest.sessionId,
      message: manifest.message,
      createdAt: manifest.createdAt,
      commit: fingerprint,
      baseCommit: fingerprint,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: manifest.files.length > 0,
    };
  }

  /** Takes a checkpoint of the working set's current content — every regular file and symlink under `worktreePath`, no ignore rules. Throws {@link SnapshotTooLargeError} if the working set exceeds {@link MAX_FS_SNAPSHOT_FILES}/{@link MAX_FS_SNAPSHOT_BYTES}. */
  async checkpoint(options: { message?: string; id?: string } = {}): Promise<GitCheckpoint> {
    const id = options.id ?? generateCheckpointId();
    const walked = await this.walkWorktree({ enforceLimit: true });
    const hashed = await this.hashEntries(walked, { persistBlobs: true });

    const manifest: FsSnapshotManifest = {
      v: 1,
      id,
      sessionId: this.sessionId,
      message: options.message?.trim() || `loombox checkpoint ${id}`,
      createdAt: Date.now(),
      files: hashed.map(({ relPath, hash, mode, size }) => ({ path: relPath, hash, mode, size })),
    };

    await mkdir(this.manifestsDir, { recursive: true });
    await writeFile(this.manifestPath(id), JSON.stringify(manifest), 'utf8');

    return this.toGitCheckpoint(manifest);
  }

  /** Every checkpoint taken for this session, oldest first. Empty array if none exist yet — never throws for "no checkpoints", mirroring `GitCheckpointStore.listCheckpoints()`. */
  async listCheckpoints(): Promise<GitCheckpoint[]> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.manifestsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw error;
    }
    // Ids are the same monotonic, `generateCheckpointId()`-produced prefix
    // `GitCheckpointStore` sorts by (`--sort=refname`'s own filename
    // analogue here) — a plain lexicographic filename sort is creation
    // order.
    const ids = fileNames
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    const manifests = await Promise.all(ids.map((id) => this.loadManifest(id)));
    return manifests.map((manifest) => this.toGitCheckpoint(manifest));
  }

  /**
   * The shared diff behind {@link previewRestore}/{@link restore}/
   * {@link filesAffectedByRestore} — computed with NO size cap (module
   * doc comment's "bound `checkpoint` only"). Hashes the CURRENT working
   * set (read-only: `persistBlobs: false`) and compares it against
   * `checkpointId`'s own manifest: a current file the manifest doesn't
   * know about is `'delete'`; a manifest file missing, or present with a
   * different hash/mode, is `'restore'`; anything identical in both is
   * left out entirely, mirroring `GitCheckpointStore.filesAffectedByRestore`'s
   * own "only files that actually change" contract.
   */
  private async computeDiff(
    checkpointId: string,
  ): Promise<{ manifest: FsSnapshotManifest; changes: RestoreChange[] }> {
    const manifest = await this.loadManifest(checkpointId);
    const manifestByPath = new Map(manifest.files.map((file) => [file.path, file]));

    const currentWalked = await this.walkWorktree({ enforceLimit: false });
    const currentHashed = await this.hashEntries(currentWalked, { persistBlobs: false });
    const currentByPath = new Map(currentHashed.map((entry) => [entry.relPath, entry]));

    const changes: RestoreChange[] = [];
    for (const [relPath, current] of currentByPath) {
      const inManifest = manifestByPath.get(relPath);
      if (!inManifest) {
        changes.push({ relPath, action: 'delete' });
      } else if (inManifest.hash !== current.hash || inManifest.mode !== current.mode) {
        changes.push({ relPath, action: 'restore', hash: inManifest.hash, mode: inManifest.mode });
      }
    }
    for (const [relPath, file] of manifestByPath) {
      if (!currentByPath.has(relPath)) {
        changes.push({ relPath, action: 'restore', hash: file.hash, mode: file.mode });
      }
    }

    return { manifest, changes };
  }

  /** Computes what {@link restore} would do, with no side effects. Throws {@link CheckpointNotFoundError} for an unknown `checkpointId`. */
  async previewRestore(checkpointId: string): Promise<RestorePreview> {
    const { changes } = await this.computeDiff(checkpointId);
    // No git-commit concept exists here, so there is nothing analogous to
    // "real commits made since the checkpoint" to count — always 0,
    // mirrored by `RestoreResult.commitsPreserved` in `restore()` below.
    return {
      checkpointId,
      commitsSinceCheckpoint: 0,
      hasUncommittedChangesToDiscard: changes.length > 0,
    };
  }

  /**
   * Restores the working set to exactly `checkpointId`'s captured content:
   * every file the checkpoint's manifest doesn't list is deleted, then
   * every file it does list is (re)written to that exact content/mode.
   * Deletes run before rewrites (mirrors `GitCheckpointStore.restore`'s
   * own wipe-then-rematerialize ordering) so a path that changed from a
   * file to a directory (or back) between checkpoint and restore never
   * has to reconcile a delete and a write racing each other.
   */
  async restore(checkpointId: string): Promise<RestoreResult> {
    const { changes } = await this.computeDiff(checkpointId);
    const deletes = changes.filter(
      (c): c is Extract<RestoreChange, { action: 'delete' }> => c.action === 'delete',
    );
    const restores = changes.filter(
      (c): c is Extract<RestoreChange, { action: 'restore' }> => c.action === 'restore',
    );

    await mapWithConcurrency(deletes, IO_CONCURRENCY, (change) =>
      rm(this.absPath(change.relPath), { recursive: true, force: true }),
    );
    await mapWithConcurrency(restores, IO_CONCURRENCY, (change) =>
      this.materializeFile(change.relPath, change.hash, change.mode),
    );

    return { checkpointId, discardedUncommittedChanges: changes.length > 0, commitsPreserved: 0 };
  }

  /** Writes `relPath` back to the content stored under `hash`/`mode`, creating parent directories (and clearing a conflicting non-directory ancestor, or a conflicting directory at `relPath` itself, if either is in the way — see {@link ensureParentDir}) as needed. */
  private async materializeFile(
    relPath: string,
    hash: string,
    mode: FsSnapshotFileMode,
  ): Promise<void> {
    const dest = this.absPath(relPath);
    await this.ensureParentDir(dest);

    if (mode === '120000') {
      const target = await readFile(this.objectPath(hash), 'utf8');
      await rm(dest, { force: true }); // symlink() refuses if dest already exists
      await symlink(target, dest);
      return;
    }

    try {
      await copyFile(this.objectPath(hash), dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EISDIR') throw error;
      // `relPath` currently holds a whole directory where the checkpoint
      // wants a plain file — remove it and retry once.
      await rm(dest, { recursive: true, force: true });
      await copyFile(this.objectPath(hash), dest);
    }
    await chmod(dest, mode === '100755' ? 0o755 : 0o644);
  }

  /** `mkdir(dirname(absPath), { recursive: true })`, but recovers from an ancestor that currently exists as a plain file/symlink rather than a directory (`ENOTDIR`) — only possible because this store's checkpoints are full-tree snapshots with no notion of "this path used to be a file", so a manifest can legitimately ask for a nested path under one. Walks up from `dirname(absPath)` to find and remove the exact blocking ancestor, then retries once. */
  private async ensureParentDir(absPath: string): Promise<void> {
    const dir = path.dirname(absPath);
    try {
      await mkdir(dir, { recursive: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOTDIR') throw error;
    }
    let probe = dir;
    while (probe !== this.worktreePath && probe !== path.dirname(probe)) {
      const st = await lstat(probe).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (st && !st.isDirectory()) {
        await rm(probe, { force: true });
        break;
      }
      probe = path.dirname(probe);
    }
    await mkdir(dir, { recursive: true });
  }

  /** Deletes one checkpoint's manifest. The blobs it referenced simply stay in {@link objectsDir} as ordinary, unreferenced files — this store has no active garbage collection, mirroring `GitCheckpointStore.deleteCheckpoint`'s own "objects become unreachable... never touches the worktree" scope: cheap to leave behind, and another checkpoint sharing the same content will find the blob already there regardless. Throws {@link CheckpointNotFoundError} for an unknown `checkpointId`. */
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    try {
      await readFile(this.manifestPath(checkpointId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new CheckpointNotFoundError(this.sessionId, checkpointId);
      }
      throw error;
    }
    await rm(this.manifestPath(checkpointId), { force: true });
  }

  /** Deletes every checkpoint recorded for this session, mirroring `GitCheckpointStore.deleteAllCheckpoints()`. Not called automatically by anything in this class. */
  async deleteAllCheckpoints(): Promise<void> {
    for (const checkpoint of await this.listCheckpoints()) {
      await this.deleteCheckpoint(checkpoint.id);
    }
  }

  /** Every file whose on-disk content will differ after restoring to `checkpointId`, computed with no side effects. Mirrors `GitCheckpointStore.filesAffectedByRestore`'s own shape and "current going to checkpoint" `action` meaning exactly. */
  async filesAffectedByRestore(checkpointId: string): Promise<RestoreFileChange[]> {
    const { changes } = await this.computeDiff(checkpointId);
    return changes.map(({ relPath, action }) => ({ path: relPath, action }));
  }
}
