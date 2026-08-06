import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git-based checkpoint & rollback engine (SPEC §7.20; issue #266). Snapshots
 * a session's git worktree — staged, unstaged, and untracked-but-relevant
 * changes — without requiring a commit, and restores it later, discarding
 * everything after. This is the engine only: nothing here spawns an agent,
 * touches `AgentSupervisor`/`AgentSession`, or exposes a wire message —
 * wiring a session to this store, and the protocol surface a client would
 * need to trigger it, is deliberately left to a follow-up (see the PR that
 * introduced this file for which issue). The non-git filesystem-snapshot
 * path for projects without a `.git` (§6, "Project... does not have to be a
 * git repository") is issue #267, not this one.
 *
 * ## Mechanism: a hidden ref over a `git stash`-shaped commit graph
 *
 * A checkpoint is one git commit built from three trees, reachable only
 * through `refs/loombox/checkpoints/<sessionId>/<checkpointId>`:
 *
 * ```
 *        checkpoint commit C  (tree = tracked worktree content, staged+unstaged combined)
 *       /          |          \
 *  base commit  index commit  untracked commit   (only present if untracked files exist)
 *  (HEAD at      (tree =        (tree = untracked-
 *   checkpoint    staged         but-relevant
 *   time)         content)       files; parentless)
 * ```
 *
 * This is exactly the object graph `git stash push --include-untracked`
 * produces (verified against real git 2.47: a 3-parent commit whose own
 * tree is the combined working-tree content, second parent's tree is the
 * index, third parent is a parentless commit over untracked files) — built
 * here with plumbing (`write-tree`/`commit-tree`) instead of `git stash`
 * itself, so capture never touches the real index, `refs/stash`, or the
 * working tree, and multiple checkpoints across sessions can never collide
 * on the one real stash slot. A single ref keeps every object in this graph
 * reachable and immune to `git gc`; git's own object store deduplicates
 * blobs against everything already committed, so an unchanged file costs
 * nothing extra per checkpoint.
 *
 * Two alternatives were considered and rejected:
 *
 * - **A real commit on the session's branch.** Simpler, but it rewrites
 *   `git log` for a branch the agent (and, on a `workInPlace` session, the
 *   user) is actively working on, forces a throwaway commit message into
 *   real history, and — critically — cannot represent "staged vs unstaged"
 *   at all: a commit has no such split, so restoring one loses exactly the
 *   distinction design consideration #3 requires being preserved.
 * - **A filesystem copy (`cp -r` / tar snapshot) of the worktree.** Doesn't
 *   deduplicate (a checkpoint of a large repo costs a full copy every time,
 *   unlike git's content-addressed blobs), doesn't gitignore-filter without
 *   reimplementing git's own exclude-matching, and still needs a *separate*
 *   mechanism to capture the staged/unstaged split (the filesystem alone
 *   only ever shows one merged state). It also doesn't survive a crash
 *   mid-write as safely as an atomic `git update-ref`.
 *
 * ## Untracked files: exactly git's own notion, nothing invented
 *
 * "Untracked-but-relevant" is implemented as precisely what
 * `git ls-files --others --exclude-standard` returns: untracked, and not
 * excluded by `.gitignore` / `.git/info/exclude` / the user's global
 * excludes. This is the same rule `git status`, `git add -A`, and
 * `git stash -u` already use, so a brand-new source file the agent just
 * wrote is captured, while `node_modules/`, build output, and anything else
 * the project already ignores is not — no bespoke "relevant" heuristic to
 * get wrong or drift from what the project itself declares irrelevant.
 *
 * ## Restore semantics: content-exact, history-safe
 *
 * {@link GitCheckpointStore.restore} never runs `git reset`, `git checkout`,
 * or any command that moves `HEAD` or a branch ref — it only ever forces the
 * *index* and *working tree* to match the checkpoint's captured trees via
 * `git read-tree --reset -u` (index + worktree together, run once against
 * the checkpoint's own tree for the combined content, then again index-only
 * against the index tree to re-split staged from unstaged) plus a manual
 * wipe-and-rematerialize of untracked files. Concretely:
 *
 * 1. Every file present in the checkpoint's working-tree snapshot is
 *    restored to exactly that content (staged or not).
 * 2. The index is then narrowed back to exactly what was staged at
 *    checkpoint time — restoring the staged/unstaged split, not just file
 *    contents.
 * 3. Every currently untracked-and-relevant file is deleted, then the
 *    checkpoint's own untracked snapshot is rematerialized from its tree —
 *    this is what "removes files created after the checkpoint" means for
 *    untracked files.
 * 4. Any tracked file that didn't exist in the checkpoint (created, staged,
 *    or even committed afterwards) is absent from the checkpoint's tree, so
 *    step 1 removes it from the working tree too.
 *
 * **If the agent made a real commit after the checkpoint, that commit is
 * never touched — `HEAD` doesn't move, nothing is rewritten, nothing is
 * lost from `git log`.** Restore still forces the working tree/index back to
 * the checkpoint's exact snapshot per the steps above, so a file that
 * commit introduced disappears from disk (its effect is undone) while the
 * commit object itself stays fully intact and reachable — this is the
 * chosen rule for design consideration #4 ("no lost commits the agent did
 * make"): rollback discards *uncommitted* state unconditionally, and
 * reverts the *working-tree effect* of anything since the checkpoint
 * (committed or not) without ever discarding the commits themselves. A
 * caller inspecting `git log` after a rollback sees every commit the agent
 * made; `git status`/the file tree shows the checkpoint's exact state.
 * {@link GitCheckpointStore.previewRestore} lets a caller (the UI flow in
 * issue #268) find out *before* calling {@link GitCheckpointStore.restore}
 * whether there's anything uncommitted to discard and how many commits sit
 * between the checkpoint and `HEAD`, since restore is destructive and the
 * engine has no way to prompt a human itself.
 *
 * ## Non-git repository, detached HEAD, dirty submodule
 *
 * All three fail cleanly via named errors before touching anything:
 * {@link NotAGitWorktreeError}, {@link DetachedHeadError},
 * {@link DirtySubmoduleError}. Detached `HEAD` is refused because every
 * loombox-managed worktree is always created on a real branch
 * (`SessionManager`/`./ssh/remote-worktree.ts`'s
 * `loombox/session-<id>` convention) — a detached worktree here means
 * something outside that contract, and restore's "never move HEAD" promise
 * is only meaningful relative to a branch tip in the first place. A dirty
 * submodule is refused rather than silently checkpointed incomplete: git's
 * object model records only a submodule's *checked-out commit* as a gitlink
 * entry, never its own uncommitted working tree, so a checkpoint taken
 * anyway would look complete but silently drop exactly the kind of
 * in-flight state this feature exists to protect.
 */

const CHECKPOINT_REF_ROOT = 'refs/loombox/checkpoints';

/**
 * The synthetic git identity every checkpoint commit is authored/committed
 * as. These commits are never authored "by" the person configured in the
 * repo's `user.name`/`user.email` (real or absent) — they're loombox
 * bookkeeping objects, not something the user or agent wrote, and using a
 * fixed identity means capture never depends on (or pollutes) the repo's
 * own git config.
 */
const CHECKPOINT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'loombox checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@loombox.local',
  GIT_COMMITTER_NAME: 'loombox checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@loombox.local',
};

/** Thrown when `worktreePath` isn't inside a git working tree at all. */
export class NotAGitWorktreeError extends Error {
  constructor(readonly worktreePath: string) {
    super(`not a git working tree: ${worktreePath} (checkpoint/restore needs a real git repo)`);
    this.name = 'NotAGitWorktreeError';
  }
}

/** Thrown when `worktreePath`'s `HEAD` isn't on a branch — see the module doc comment for why this is refused rather than handled. */
export class DetachedHeadError extends Error {
  constructor(readonly worktreePath: string) {
    super(
      `${worktreePath}: HEAD is detached; checkpoint/restore requires a worktree checked out ` +
        'on a branch',
    );
    this.name = 'DetachedHeadError';
  }
}

/** Thrown when `worktreePath` has a submodule with uncommitted state (modified content, untracked content inside it, or a checked-out commit that differs from what's staged) — see the module doc comment for why this can't be captured safely. */
export class DirtySubmoduleError extends Error {
  constructor(
    readonly worktreePath: string,
    readonly statusLines: string[],
  ) {
    super(
      `${worktreePath}: submodule(s) with uncommitted state — checkpoint cannot capture a ` +
        `submodule's own working tree, only its recorded commit (${statusLines.join('; ')})`,
    );
    this.name = 'DirtySubmoduleError';
  }
}

/** Thrown by {@link GitCheckpointStore.restore}/{@link GitCheckpointStore.previewRestore}/{@link GitCheckpointStore.deleteCheckpoint} when `checkpointId` has no matching ref for this session. */
export class CheckpointNotFoundError extends Error {
  constructor(
    readonly sessionId: string,
    readonly checkpointId: string,
  ) {
    super(`no checkpoint "${checkpointId}" for session ${sessionId}`);
    this.name = 'CheckpointNotFoundError';
  }
}

/** One checkpoint's metadata, as reconstructed from its hidden ref and commit graph — never the commit's raw shape, so a caller never needs to know this is a stash-shaped graph under the hood. */
export interface GitCheckpoint {
  id: string;
  sessionId: string;
  /** Free-text label passed to {@link GitCheckpointStore.checkpoint}, or a generated default. */
  message: string;
  /** When this checkpoint was taken (epoch ms), from the checkpoint commit's own committer date. */
  createdAt: number;
  /** The checkpoint's own commit object — reachable only via its hidden ref, never on any branch. */
  commit: string;
  /** `HEAD` at the moment this checkpoint was taken. */
  baseCommit: string;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedFiles: boolean;
}

/** What {@link GitCheckpointStore.restore} would do, computed with no side effects — the "caller must be able to know before doing it" requirement (SPEC §7.20 design consideration #3). */
export interface RestorePreview {
  checkpointId: string;
  /** Real commits made on this worktree's branch since the checkpoint's base commit. `restore()` never removes or rewrites them — see the module doc comment's design consideration #4. */
  commitsSinceCheckpoint: number;
  /** Whether the worktree currently has any staged, unstaged, or untracked-but-relevant change that `restore()` would discard. */
  hasUncommittedChangesToDiscard: boolean;
}

/** What {@link GitCheckpointStore.restore} actually did, as an explicit record rather than a silent success (design consideration #3). */
export interface RestoreResult {
  checkpointId: string;
  discardedUncommittedChanges: boolean;
  commitsPreserved: number;
}

/**
 * One file {@link GitCheckpointStore.filesAffectedByRestore} found to
 * differ between the worktree's current state and `checkpointId`'s own
 * captured snapshot — the file-level counterpart to
 * {@link RestorePreview}'s summary booleans (issue #747's "the
 * confirmation must name what will be lost, in files"). `action` names
 * what {@link GitCheckpointStore.restore} does to this specific path:
 * `'restore'` (re)writes it to the checkpoint's own content, whether that
 * means overwriting a changed file or recreating one deleted since;
 * `'delete'` removes it outright, because it exists now but the
 * checkpoint never captured it (created — tracked or untracked — after
 * the checkpoint was taken).
 */
export interface RestoreFileChange {
  /** Worktree-relative, matching `git`'s own path format (`/`-separated). */
  path: string;
  action: 'restore' | 'delete';
}

export interface GitCheckpointStoreOptions {
  /** Absolute path to the git worktree this store checkpoints/restores — a session's `Session.worktreePath`/`worktreePath` (`@loombox/node`), though this class has no dependency on that type; any git working tree path works. */
  worktreePath: string;
  /** Namespaces this store's checkpoints under `refs/loombox/checkpoints/<sessionId>/...`, so two sessions sharing a project (e.g. two worktrees off the same repo) never collide. */
  sessionId: string;
}

interface ResolvedCheckpoint {
  checkpointCommit: string;
  baseCommit: string;
  indexCommit: string;
  untrackedCommit: string | undefined;
}

/** One entry from `git ls-tree -r`. */
interface TreeBlobEntry {
  mode: string;
  blob: string;
  path: string;
}

/**
 * Owns checkpoint/restore for one worktree + session pairing. Stateless
 * beyond its constructor options — every checkpoint's real state lives in
 * the repo's own refs and object database, so a fresh instance pointed at
 * the same `worktreePath`/`sessionId` sees exactly the same checkpoints.
 */
export class GitCheckpointStore {
  private readonly worktreePath: string;
  private readonly sessionId: string;

  constructor(options: GitCheckpointStoreOptions) {
    this.worktreePath = options.worktreePath;
    this.sessionId = options.sessionId;
  }

  private refPath(checkpointId: string): string {
    return `${CHECKPOINT_REF_ROOT}/${this.sessionId}/${checkpointId}`;
  }

  private async git(args: string[], extraEnv?: Record<string, string>): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.worktreePath,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      });
      return stdout.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`git ${args.join(' ')} failed in ${this.worktreePath}: ${message}`);
    }
  }

  /** Binary-safe variant of {@link git}, for reading blob content back out (`cat-file blob`) without a UTF-8 round trip corrupting non-text files. */
  private gitBuffer(args: string[]): Promise<Buffer> {
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    execFile(
      'git',
      args,
      { cwd: this.worktreePath, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(`git ${args.join(' ')} failed in ${this.worktreePath}: ${error.message}`),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    return promise;
  }

  /**
   * Confirms `worktreePath` is fit for a checkpoint/restore operation —
   * see the module doc comment's "Non-git repository, detached HEAD, dirty
   * submodule" section for what each guard means and why. Pure: never
   * mutates the repo, worktree, or index.
   */
  private async assertUsable(): Promise<void> {
    let isWorkTree: string;
    try {
      isWorkTree = await this.git(['rev-parse', '--is-inside-work-tree']);
    } catch {
      throw new NotAGitWorktreeError(this.worktreePath);
    }
    if (isWorkTree !== 'true') {
      throw new NotAGitWorktreeError(this.worktreePath);
    }

    try {
      await this.git(['symbolic-ref', '-q', 'HEAD']);
    } catch {
      throw new DetachedHeadError(this.worktreePath);
    }

    const status = await this.git(['status', '--porcelain=v2', '--ignore-submodules=none']);
    const dirtySubmoduleLines = status
      .split('\n')
      .filter((line) => line.length > 0)
      // porcelain=v2's ordinary-change field 3 is `N...` for a plain file
      // and `S<c><m><u>` for a submodule (verified against real git 2.47);
      // any submodule appearing here at all means it has uncommitted state,
      // since a clean submodule doesn't show up in status output.
      .filter((line) => /^[12] \S+ S/.test(line));
    if (dirtySubmoduleLines.length > 0) {
      throw new DirtySubmoduleError(this.worktreePath, dirtySubmoduleLines);
    }
  }

  /** Runs `fn` with a throwaway index file (never the repo's real one), cleaning it up afterwards regardless of outcome. */
  private async withTempIndex<T>(fn: (indexPath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'loombox-checkpoint-index-'));
    try {
      return await fn(join(dir, 'index'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Copies the real (per-worktree) index into `destPath`, or leaves `destPath` absent if there's no real index yet — git treats a missing `GIT_INDEX_FILE` as an empty index, which is the correct starting point in that case. */
  private async copyRealIndexInto(destPath: string): Promise<void> {
    const realIndexPath = await this.git([
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ]);
    try {
      await writeFile(destPath, await readFile(realIndexPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }

  private async listTreeBlobs(tree: string): Promise<TreeBlobEntry[]> {
    const raw = await this.git(['ls-tree', '-r', '-z', tree]);
    return raw
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const tabIndex = entry.indexOf('\t');
        const meta = entry.slice(0, tabIndex).split(' ');
        return { mode: meta[0], blob: meta[2], path: entry.slice(tabIndex + 1) };
      });
  }

  private async resolveCheckpoint(checkpointId: string): Promise<ResolvedCheckpoint> {
    let checkpointCommit: string;
    try {
      checkpointCommit = await this.git(['rev-parse', '--verify', this.refPath(checkpointId)]);
    } catch {
      throw new CheckpointNotFoundError(this.sessionId, checkpointId);
    }
    const baseCommit = await this.git(['rev-parse', `${checkpointCommit}^1`]);
    const indexCommit = await this.git(['rev-parse', `${checkpointCommit}^2`]);
    let untrackedCommit: string | undefined;
    try {
      untrackedCommit = await this.git(['rev-parse', `${checkpointCommit}^3`]);
    } catch {
      untrackedCommit = undefined;
    }
    return { checkpointCommit, baseCommit, indexCommit, untrackedCommit };
  }

  /**
   * Takes a checkpoint of the worktree's current state — staged, unstaged,
   * and untracked-but-relevant files — with no commit required. See the
   * module doc comment for the exact mechanism.
   */
  async checkpoint(options: { message?: string; id?: string } = {}): Promise<GitCheckpoint> {
    await this.assertUsable();

    // A monotonic, nanosecond-resolution prefix so checkpoints sort by
    // creation order via a plain lexicographic `--sort=refname` — git commit
    // timestamps only have 1-second resolution, which is not enough to
    // order two checkpoints taken in the same test run (or the same second
    // in general) correctly.
    const id =
      options.id ??
      `${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID().slice(0, 8)}`;

    // Four independent reads over the worktree's CURRENT state — none
    // depends on any other's result, so they run concurrently rather than
    // as four separate sequential `git` round trips (issue #603: this
    // store's own latency became directly user-visible once a session
    // started calling this before every turn). Safe to run together:
    // `write-tree` (both the real and the temp-index one) only ever
    // WRITES new objects into git's content-addressed object database,
    // never a ref or the working tree, and git's object writes are safe
    // under concurrent writers — the same property that lets any git
    // tooling touch one repo at once at all.
    const [baseRefs, indexTree, workingTree, untrackedFiles] = await Promise.all([
      this.git(['rev-parse', 'HEAD', 'HEAD^{tree}']),
      // The real index, completely untouched — exactly what's currently staged.
      this.git(['write-tree']),
      // A throwaway copy of the real index with unstaged modifications/
      // deletions of already-tracked files staged into it (`add -u` never
      // touches new untracked files) — the combined staged+unstaged
      // content, matching what `git stash create` builds internally.
      this.withTempIndex(async (tempIndexPath) => {
        await this.copyRealIndexInto(tempIndexPath);
        await this.git(['add', '-u'], { GIT_INDEX_FILE: tempIndexPath });
        return this.git(['write-tree'], { GIT_INDEX_FILE: tempIndexPath });
      }),
      // Untracked-and-not-ignored files — git's own notion (module doc comment).
      this.git(['ls-files', '--others', '--exclude-standard']).then((raw) =>
        raw.split('\n').filter((line) => line.length > 0),
      ),
    ]);
    const [baseCommit, baseTree] = baseRefs.split('\n');

    let untrackedCommit: string | undefined;
    if (untrackedFiles.length > 0) {
      const untrackedTree = await this.withTempIndex(async (tempIndexPath) => {
        await this.git(['add', '--', ...untrackedFiles], { GIT_INDEX_FILE: tempIndexPath });
        return this.git(['write-tree'], { GIT_INDEX_FILE: tempIndexPath });
      });
      untrackedCommit = await this.git(
        ['commit-tree', untrackedTree, '-m', 'loombox checkpoint: untracked files'],
        CHECKPOINT_GIT_IDENTITY,
      );
    }

    const indexCommit = await this.git(
      ['commit-tree', indexTree, '-p', baseCommit, '-m', 'loombox checkpoint: index'],
      CHECKPOINT_GIT_IDENTITY,
    );

    const parents = ['-p', baseCommit, '-p', indexCommit];
    if (untrackedCommit) parents.push('-p', untrackedCommit);
    const message = options.message?.trim() || `loombox checkpoint ${id}`;
    const checkpointCommit = await this.git(
      ['commit-tree', workingTree, ...parents, '-m', message],
      CHECKPOINT_GIT_IDENTITY,
    );

    // Captured right before the ref actually lands rather than round-tripped
    // back from `git log` afterward (one fewer `git` call; no caller reads
    // this back for exact cross-checking against the commit's own
    // committer date, which `commit-tree` — given no explicit
    // `GIT_COMMITTER_DATE` in `CHECKPOINT_GIT_IDENTITY` — defaults to "now"
    // at that same call anyway, only at git's own one-second resolution
    // instead of this millisecond one).
    const createdAt = Date.now();
    await this.git(['update-ref', this.refPath(id), checkpointCommit]);

    return {
      id,
      sessionId: this.sessionId,
      message,
      createdAt,
      commit: checkpointCommit,
      baseCommit,
      hasStagedChanges: indexTree !== baseTree,
      hasUnstagedChanges: workingTree !== indexTree,
      hasUntrackedFiles: untrackedFiles.length > 0,
    };
  }

  /** Every checkpoint taken for this session, oldest first. Empty array if none exist yet — never throws for "no checkpoints". */
  async listCheckpoints(): Promise<GitCheckpoint[]> {
    const root = `${CHECKPOINT_REF_ROOT}/${this.sessionId}`;
    const raw = await this.git([
      'for-each-ref',
      root,
      '--format=%(refname)|%(objectname)|%(creatordate:iso-strict)|%(subject)',
      // Refname sorts lexicographically by the id's monotonic prefix
      // (see `checkpoint()`) — not by commit date, which only has
      // 1-second resolution and can't order same-second checkpoints.
      '--sort=refname',
    ]);
    if (!raw) return [];

    const checkpoints: GitCheckpoint[] = [];
    for (const line of raw.split('\n').filter((entry) => entry.length > 0)) {
      const [refname, commit, createdAtIso, ...subjectParts] = line.split('|');
      const id = refname.slice(root.length + 1);
      const { baseCommit, indexCommit, untrackedCommit } = await this.resolveCheckpoint(id);
      const [baseTree, indexTree, workingTree] = await Promise.all([
        this.git(['rev-parse', `${baseCommit}^{tree}`]),
        this.git(['rev-parse', `${indexCommit}^{tree}`]),
        this.git(['rev-parse', `${commit}^{tree}`]),
      ]);
      checkpoints.push({
        id,
        sessionId: this.sessionId,
        message: subjectParts.join('|'),
        createdAt: Date.parse(createdAtIso),
        commit,
        baseCommit,
        hasStagedChanges: indexTree !== baseTree,
        hasUnstagedChanges: workingTree !== indexTree,
        hasUntrackedFiles: untrackedCommit !== undefined,
      });
    }
    return checkpoints;
  }

  /** The shared computation behind {@link previewRestore} and {@link restore}'s own result — factored out so `restore()` doesn't pay for `assertUsable()`/`resolveCheckpoint()` twice. */
  private async computeRestorePreview(
    checkpointId: string,
    baseCommit: string,
  ): Promise<RestorePreview> {
    const head = await this.git(['rev-parse', 'HEAD']);
    const commitsSinceCheckpoint = Number(
      await this.git(['rev-list', '--count', `${baseCommit}..${head}`]),
    );
    const status = await this.git(['status', '--porcelain=v2', '--ignore-submodules=none']);

    return {
      checkpointId,
      commitsSinceCheckpoint,
      hasUncommittedChangesToDiscard: status.length > 0,
    };
  }

  /** Computes what {@link restore} would do, with no side effects. Throws {@link CheckpointNotFoundError} for an unknown `checkpointId`. */
  async previewRestore(checkpointId: string): Promise<RestorePreview> {
    await this.assertUsable();
    const { baseCommit } = await this.resolveCheckpoint(checkpointId);
    return this.computeRestorePreview(checkpointId, baseCommit);
  }

  /**
   * Restores the worktree to exactly the state {@link checkpoint} captured
   * — staged/unstaged split included — discarding every uncommitted change
   * made since, and removing every file (tracked or untracked) created
   * since that isn't part of the checkpoint. Never moves `HEAD` or any
   * branch ref; see the module doc comment for the full restore algorithm
   * and the rule for a commit the agent made after the checkpoint.
   *
   * Throws {@link CheckpointNotFoundError} for an unknown `checkpointId`,
   * or one of {@link NotAGitWorktreeError}/{@link DetachedHeadError}/
   * {@link DirtySubmoduleError} if the worktree itself isn't in a state
   * this engine can safely operate on.
   */
  async restore(checkpointId: string): Promise<RestoreResult> {
    await this.assertUsable();
    const { checkpointCommit, baseCommit, indexCommit, untrackedCommit } =
      await this.resolveCheckpoint(checkpointId);
    const preview = await this.computeRestorePreview(checkpointId, baseCommit);

    // 1. Force the tracked worktree + index to the checkpoint's own
    //    combined (staged+unstaged) snapshot — recreates/overwrites every
    //    file the checkpoint knows about and removes every tracked file it
    //    doesn't (including one a later, real commit introduced).
    await this.git(['read-tree', '--reset', '-u', `${checkpointCommit}^{tree}`]);
    // 2. Narrow the index back down to exactly what was staged at
    //    checkpoint time — restores the staged/unstaged split. The
    //    worktree files written in step 1 are untouched by this.
    await this.git(['read-tree', '--reset', `${indexCommit}^{tree}`]);

    // 3. Wipe every untracked-and-relevant file currently present — this is
    //    what removes an untracked file the agent created after the
    //    checkpoint. Every file the checkpoint itself captured gets
    //    rewritten fresh in step 4 regardless, so deleting it here first is
    //    safe and keeps the operation a clean "wipe, then rematerialize".
    const currentUntracked = (await this.git(['ls-files', '--others', '--exclude-standard']))
      .split('\n')
      .filter((line) => line.length > 0);
    await Promise.all(
      currentUntracked.map((relativePath) =>
        rm(join(this.worktreePath, relativePath), { force: true }),
      ),
    );

    // 4. Rematerialize the checkpoint's own untracked snapshot, if any.
    if (untrackedCommit) {
      const entries = await this.listTreeBlobs(`${untrackedCommit}^{tree}`);
      for (const entry of entries) {
        const destPath = join(this.worktreePath, entry.path);
        await mkdir(dirname(destPath), { recursive: true });
        const content = await this.gitBuffer(['cat-file', 'blob', entry.blob]);
        await writeFile(destPath, content, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      }
    }

    return {
      checkpointId,
      discardedUncommittedChanges: preview.hasUncommittedChangesToDiscard,
      commitsPreserved: preview.commitsSinceCheckpoint,
    };
  }

  /** Deletes one checkpoint's hidden ref. The objects it referenced become ordinary unreachable git objects, cleaned up by the repo's own eventual `git gc` like any other — this never touches the worktree or index. Throws {@link CheckpointNotFoundError} for an unknown `checkpointId`. */
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    const ref = this.refPath(checkpointId);
    let commit: string;
    try {
      commit = await this.git(['rev-parse', '--verify', ref]);
    } catch {
      throw new CheckpointNotFoundError(this.sessionId, checkpointId);
    }
    await this.git(['update-ref', '-d', ref, commit]);
  }

  /** Deletes every checkpoint recorded for this session — the whole-session cleanup a caller tearing down a session's worktree (`SessionManager.removeSession`) would run to avoid leaking hidden refs forever. Not called automatically by anything in this class. */
  async deleteAllCheckpoints(): Promise<void> {
    for (const checkpoint of await this.listCheckpoints()) {
      await this.deleteCheckpoint(checkpoint.id);
    }
  }

  /**
   * Every file whose on-disk content will differ after restoring to
   * `checkpointId`, computed with no side effects — see
   * {@link RestoreFileChange}'s own doc comment for what `action` means.
   * Mirrors {@link restore}'s own two-phase algorithm exactly rather than
   * inventing a separate notion of "changed": tracked content is diffed
   * as checkpointCommit's own tree against the SAME combined
   * (real-index-plus-`add -u`) tree {@link checkpoint}/{@link restore}
   * build for "the worktree's current state", and untracked content is
   * diffed the same way against the checkpoint's own `untrackedCommit`
   * (or the canonical empty tree, for a checkpoint that captured none).
   * `git diff --name-status --no-renames <current> <checkpoint>` reads
   * naturally as "what changes to go FROM current TO the checkpoint" —
   * exactly what `restore()` is about to do — so `A` (added in the
   * checkpoint) means the file comes back (`'restore'`), `D` (missing
   * from the checkpoint) means it goes away (`'delete'`), and `M` means
   * its content changes (`'restore'`). `--no-renames` keeps every
   * "removed here, satisfied by pairing with `-M`'ing renames" case as a
   * demonstration.
   */
  async filesAffectedByRestore(checkpointId: string): Promise<RestoreFileChange[]> {
    await this.assertUsable();
    const { checkpointCommit, untrackedCommit } = await this.resolveCheckpoint(checkpointId);

    const [currentTrackedTree, currentUntrackedFiles, checkpointTrackedTree, emptyTree] =
      await Promise.all([
        this.withTempIndex(async (tempIndexPath) => {
          await this.copyRealIndexInto(tempIndexPath);
          await this.git(['add', '-u'], { GIT_INDEX_FILE: tempIndexPath });
          return this.git(['write-tree'], { GIT_INDEX_FILE: tempIndexPath });
        }),
        this.git(['ls-files', '--others', '--exclude-standard']).then((raw) =>
          raw.split('\n').filter((line) => line.length > 0),
        ),
        this.git(['rev-parse', `${checkpointCommit}^{tree}`]),
        this.withTempIndex((tempIndexPath) =>
          this.git(['write-tree'], { GIT_INDEX_FILE: tempIndexPath }),
        ),
      ]);

    const currentUntrackedTree =
      currentUntrackedFiles.length > 0
        ? await this.withTempIndex(async (tempIndexPath) => {
            await this.git(['add', '--', ...currentUntrackedFiles], {
              GIT_INDEX_FILE: tempIndexPath,
            });
            return this.git(['write-tree'], { GIT_INDEX_FILE: tempIndexPath });
          })
        : emptyTree;
    const checkpointUntrackedTree = untrackedCommit
      ? await this.git(['rev-parse', `${untrackedCommit}^{tree}`])
      : emptyTree;

    const [trackedDiff, untrackedDiff] = await Promise.all([
      this.diffTreeNames(currentTrackedTree, checkpointTrackedTree),
      this.diffTreeNames(currentUntrackedTree, checkpointUntrackedTree),
    ]);

    return [...trackedDiff, ...untrackedDiff].map(({ status, path }) => ({
      path,
      action: status === 'D' ? 'delete' : 'restore',
    }));
  }

  /** `git diff --name-status --no-renames -z fromTree toTree`, parsed into `{status, path}` pairs — factored out of {@link filesAffectedByRestore} for its own doc comment's "current going to checkpoint" reading. */
  private async diffTreeNames(
    fromTree: string,
    toTree: string,
  ): Promise<Array<{ status: string; path: string }>> {
    const raw = await this.git(['diff', '--name-status', '--no-renames', '-z', fromTree, toTree]);
    if (!raw) return [];
    const parts = raw.split('\0').filter((part) => part.length > 0);
    const out: Array<{ status: string; path: string }> = [];
    for (let i = 0; i < parts.length; i += 2) {
      out.push({ status: parts[i], path: parts[i + 1] });
    }
    return out;
  }
}
