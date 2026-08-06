import { posix } from 'node:path';

import type { GitDiffFileStatusV1, GitDiffFileV1 } from '@loombox/protocol';
import type { ExecutionTarget } from './target';

/**
 * Computes a session's working-tree diff — what has actually changed on
 * disk right now (staged + unstaged + untracked, all compared against
 * `HEAD`), as opposed to `AcpToolCallUpdate.diff`'s per-tool-call ACP
 * shape, which only ever reflects one completed tool call (SPEC §7.4,
 * issue #206's diff viewer).
 *
 * Runs real `git` subcommands through `ExecutionTarget.exec` — the same
 * `git -C <worktreePath> ...` shape issue #238's `pr-open.ts` already
 * established for driving git against either a `local` or an `ssh:`
 * target through the one shared exec seam (`target.ts`'s own doc comment
 * names it exactly that). Deliberately NOT `GitCheckpointStore`'s own
 * shape: that store spawns `git` as a LOCAL child process (its own module
 * doc comment) and would have no way to reach an `ssh:` session's
 * worktree at all — this viewer's own acceptance line ("works for a
 * project on either a `local` or an `ssh:` target") rules that out.
 */

/** Thrown only when the diff genuinely could not be computed at all — `git` missing from the target, or the worktree isn't a usable git repository. A worktree that's merely clean (nothing changed) or has ordinary changes never throws; it resolves to `[]` or a real file list. */
export class GitDiffError extends Error {}

/** Mirrors `NodeDaemon.MAX_FS_READ_BYTES`'s own cap (issue #737's read-only file viewer) — the same "bound one response so an accidentally huge file never ties up the encrypted channel" reasoning, applied per side of every changed file here rather than once per whole file. */
const MAX_GIT_DIFF_TEXT_BYTES = 1_000_000;

interface WorktreeStatusEntry {
  /** The file's current path (project-relative). For a rename/copy, the destination. */
  path: string;
  /** The rename/copy source path, or `null` for every other status. */
  previousPath: string | null;
}

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=all`'s own
 * NUL-delimited output. Every record is `XY<space><path>` (`X`/`Y` are the
 * index/worktree status letters — verified empirically rather than
 * assumed, since git's docs are thin on the exact `-z` byte layout); when
 * either letter is `R` (renamed) or `C` (copied), one more NUL-delimited
 * token follows carrying the ORIGINAL path, `path` above being the
 * destination — confirmed against a live `git status --porcelain=v1 -z`
 * run rather than guessed from the (rename `git diff --name-status`'s own
 * `oldpath` before `newpath` order is the OPPOSITE of this one; the two
 * commands do not share a field order, so this parser never reuses
 * `--name-status`'s own).
 *
 * Deliberately reads only `path`/rename-ness off this output, never the
 * raw status letters themselves: whether a file is really added/modified/
 * deleted is instead derived downstream from whether it has a previous
 * blob at `HEAD` and whether it still exists on disk ({@link
 * readDiffFile}) — robust to every one of porcelain's ~20 two-letter
 * combinations (staged+unstaged mixes, unmerged conflict markers, ...)
 * without this parser needing to understand any of them.
 */
function parseStatusPorcelainZ(stdout: string): WorktreeStatusEntry[] {
  const tokens = stdout.split('\0');
  const entries: WorktreeStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i];
    if (!record) {
      i++;
      continue;
    }
    const x = record[0];
    const y = record[1];
    const path = record.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const previousPath = tokens[i + 1];
      entries.push({ path, previousPath: previousPath ? previousPath : null });
      i += 2;
    } else {
      entries.push({ path, previousPath: null });
      i += 1;
    }
  }
  return entries;
}

/** `relPath`'s content at `HEAD`, or `null` when it has none there (a new/untracked file, a rename's destination, or an unborn `HEAD`) — never throws, matching this whole module's "a per-file lookup failure degrades, it never fails the whole diff" contract. */
async function readAtHead(
  target: ExecutionTarget,
  worktreePath: string,
  relPath: string,
): Promise<string | null> {
  try {
    const result = await target.exec('git', ['-C', worktreePath, 'show', `HEAD:${relPath}`]);
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/** `relPath`'s current content in the worktree — `existed: false` (never a thrown error) for a deleted file, matching `readAtHead`'s identical degrade-not-fail contract. */
async function readWorktreeFile(
  target: ExecutionTarget,
  worktreePath: string,
  relPath: string,
): Promise<{ content: string; existed: boolean }> {
  try {
    const content = await target.readFile(posix.join(worktreePath, relPath));
    return { content, existed: true };
  } catch {
    return { content: '', existed: false };
  }
}

function truncate(text: string): string {
  return text.length > MAX_GIT_DIFF_TEXT_BYTES ? text.slice(0, MAX_GIT_DIFF_TEXT_BYTES) : text;
}

/** `\u0000` anywhere in either side is this function's binary detector — the exact heuristic `NodeDaemon.readFileForBridge` already uses for `fs_read_request` (that handler's own doc comment): every `ExecutionTarget.readFile`/`git show` decodes as UTF-8 regardless of a blob's real encoding, so a stray `\u0000` is the signal there is no useful line-level diff to show. */
function isBinaryChange(oldText: string | null, newText: string): boolean {
  return (oldText !== null && oldText.includes('\u0000')) || newText.includes('\u0000');
}

async function readDiffFile(
  target: ExecutionTarget,
  worktreePath: string,
  entry: WorktreeStatusEntry,
): Promise<GitDiffFileV1> {
  const oldRelPath = entry.previousPath ?? entry.path;
  const oldText = await readAtHead(target, worktreePath, oldRelPath);
  const worktreeFile = await readWorktreeFile(target, worktreePath, entry.path);

  let status: GitDiffFileStatusV1;
  if (entry.previousPath !== null) status = 'renamed';
  else if (oldText === null) status = 'added';
  else if (!worktreeFile.existed) status = 'deleted';
  else status = 'modified';

  // A binary/symlink change collapses to `DiffViewer`'s own existing
  // structural-only fallback (`oldText: null, newText: ''`) regardless of
  // `status` — reused as-is rather than a second "this is binary"
  // rendering (see this module's own file doc comment).
  if (isBinaryChange(oldText, worktreeFile.content)) {
    return {
      path: entry.path,
      previousPath: entry.previousPath,
      status,
      oldText: null,
      newText: '',
    };
  }

  return {
    path: entry.path,
    previousPath: entry.previousPath,
    status,
    oldText: oldText === null ? null : truncate(oldText),
    newText: truncate(worktreeFile.content),
  };
}

/** Every file changed in `worktreePath` right now, file-by-file, oldest-git-status-order (git's own default). `[]` for a clean worktree — never an error. Throws {@link GitDiffError} only when the diff itself could not be computed at all (see that class's own doc comment). */
export async function computeWorktreeDiff(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<GitDiffFileV1[]> {
  let statusResult;
  try {
    statusResult = await target.exec('git', [
      '-C',
      worktreePath,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
  } catch (error) {
    throw new GitDiffError(
      `git is not available on this target: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (statusResult.exitCode !== 0) {
    throw new GitDiffError(
      `"git status" failed: ${statusResult.stderr.trim() || statusResult.stdout.trim()}`,
    );
  }

  const entries = parseStatusPorcelainZ(statusResult.stdout);
  return Promise.all(entries.map((entry) => readDiffFile(target, worktreePath, entry)));
}
