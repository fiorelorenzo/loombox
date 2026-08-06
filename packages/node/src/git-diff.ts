import { posix } from 'node:path';

import type {
  GitBranchSummaryV1,
  GitDiffFileStatusV1,
  GitDiffFileV1,
  GitHunkActionRequestPayloadV1,
  GitHunkFileV1,
  GitHunkLineV1,
  GitHunkV1,
  GitStashSummaryV1,
} from '@loombox/protocol';
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
  /** `git status --porcelain=v1`'s own index-status letter (left column) — `'?'` alongside {@link y} `'?'` is this parser's sole "genuinely untracked" signal, reused by {@link computeHunkDiff} to build the synthetic whole-file hunk untracked files get (their own doc comment on `GitHunkFileV1` in `@loombox/protocol`'s `git-hunks.ts`). Unused by {@link computeWorktreeDiff}'s own `readDiffFile`, which derives status from content presence instead — kept here only for the hunk side's own need. */
  x: string;
  /** `git status --porcelain=v1`'s own worktree-status letter (right column) — see {@link x}. */
  y: string;
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
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const path = record.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const previousPath = tokens[i + 1];
      entries.push({ path, previousPath: previousPath ? previousPath : null, x, y });
      i += 2;
    } else {
      entries.push({ path, previousPath: null, x, y });
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

/**
 * Hunk-level stage/unstage/discard (SPEC §7.6; issue #232) —
 * `computeWorktreeDiff`'s sibling: same real-`git`-subcommand approach,
 * same `local`/`ssh:` target-agnostic `ExecutionTarget.exec` seam, but
 * reporting the index (`HEAD` vs staged) and worktree (staged vs
 * on-disk) separately, per hunk, instead of one combined `HEAD`-vs-disk
 * text per file. See `@loombox/protocol`'s `git-hunks.ts` for the wire
 * shape and `computeHunkDiff`/`applyGitHunkAction`'s own doc comments
 * below for the git plumbing.
 */

/** Thrown only for a hunk action that could not be applied: `hunkIndex` no longer names a real hunk on that side (see `@loombox/protocol`'s `git-hunks.ts` doc comment), an `unstage` attempted on a file with no staged hunks, or the underlying `git apply`/`git add`/`git clean` command itself failed. Mirrors {@link GitDiffError}'s own "thrown only when genuinely unusable" contract. */
export class GitHunkActionError extends Error {}

/** One `@@ -oldStart,oldLines +newStart,newLines @@ <context>` hunk header line, as `git diff -U3` prints it — parsed once here, reused both to build the `GitHunkV1` a client sees and (verbatim) to rebuild a single-hunk patch `applyGitHunkAction` feeds to `git apply`. */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;

/** One hunk extracted from a `git diff` run, in both shapes a caller needs: {@link parsed} for the wire response, {@link patchText} (the header line plus every body line, each newline-terminated) to splice after a diff's {@link ParsedUnifiedDiff.preamble} into a standalone one-hunk patch. */
interface RawHunk {
  patchText: string;
  parsed: GitHunkV1;
}

/** A single-file unified diff (as `git diff ... -- <path>` produces for exactly one path), split into the part every hunk's patch shares ({@link preamble} — the `diff --git`/mode/`index`/`---`/`+++` lines) and the hunks themselves. Isolating one hunk's patch is then just `preamble + hunks[i].patchText`; `git apply` locates it in the target file by its own header/context, so omitting every OTHER hunk never shifts where this one lands (the same positional independence interactive `git add -p` itself relies on). */
interface ParsedUnifiedDiff {
  preamble: string;
  hunks: RawHunk[];
}

/**
 * Splits one file's `git diff` output into {@link ParsedUnifiedDiff}.
 * Never throws: a binary change (git prints "Binary files ... differ",
 * no `@@` line) or a genuinely empty diff both resolve to `{ preamble:
 * <the whole text>, hunks: [] }` — {@link computeHunkDiff} then reports
 * that file with no hunks on that side, {@link applyGitHunkAction}
 * reports an out-of-range `hunkIndex` for it, neither crashes.
 *
 * A `\ No newline at end of file` marker line (git's own, not a real
 * content line) is dropped rather than kept as hunk content — it carries
 * no `' '`/`+`/`-` prefix `GitHunkLineKindV1` has a slot for, and
 * dropping it from the rebuilt patch text is harmless: `git apply`
 * tolerates a patch missing that marker, it only ever affects whether
 * the trailing line gets a newline appended, never hunk placement.
 */
function parseUnifiedDiff(diffText: string): ParsedUnifiedDiff {
  const lines = diffText.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const firstHunkIndex = lines.findIndex((line) => HUNK_HEADER_RE.test(line));
  if (firstHunkIndex === -1) {
    return { preamble: diffText, hunks: [] };
  }
  const preamble = `${lines.slice(0, firstHunkIndex).join('\n')}\n`;

  const hunks: RawHunk[] = [];
  let i = firstHunkIndex;
  while (i < lines.length) {
    const headerLine = lines[i]!;
    const match = HUNK_HEADER_RE.exec(headerLine);
    if (!match) break;
    const oldStart = Number(match[1]);
    const oldLines = match[2] !== undefined ? Number(match[2]) : 1;
    const newStart = Number(match[3]);
    const newLines = match[4] !== undefined ? Number(match[4]) : 1;
    i++;

    const bodyLines: string[] = [];
    const parsedLines: GitHunkLineV1[] = [];
    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i]!)) {
      const line = lines[i]!;
      if (line.startsWith('\\')) {
        i++;
        continue;
      }
      const marker = line[0];
      if (marker === ' ') parsedLines.push({ kind: 'context', text: line.slice(1) });
      else if (marker === '+') parsedLines.push({ kind: 'added', text: line.slice(1) });
      else if (marker === '-') parsedLines.push({ kind: 'removed', text: line.slice(1) });
      else break; // not a hunk-body line — a malformed/unexpected diff; stop this hunk here
      bodyLines.push(line);
      i++;
    }

    hunks.push({
      patchText: `${headerLine}\n${bodyLines.map((line) => `${line}\n`).join('')}`,
      parsed: { header: headerLine, oldStart, oldLines, newStart, newLines, lines: parsedLines },
    });
  }
  return { preamble, hunks };
}

/** Same status derivation `readDiffFile` above already uses (kept as its own copy rather than a shared extraction — see {@link WorktreeStatusEntry.x}'s doc comment on why this module tolerates that duplication), so a file's `status` reads identically whether seen through `git_diff_response` or `git_hunk_diff_response`. */
async function determineHunkFileStatus(
  target: ExecutionTarget,
  worktreePath: string,
  entry: WorktreeStatusEntry,
): Promise<GitDiffFileStatusV1> {
  if (entry.previousPath !== null) return 'renamed';
  const oldText = await readAtHead(target, worktreePath, entry.path);
  if (oldText === null) return 'added';
  const worktreeFile = await readWorktreeFile(target, worktreePath, entry.path);
  return worktreeFile.existed ? 'modified' : 'deleted';
}

/** An untracked file (`git status`'s `??`) has no index entry at all, so it never appears in any `git diff`/`git diff --cached` output — its whole worktree content becomes one synthetic `unstaged` hunk instead (`GitHunkFileV1`'s own doc comment in `@loombox/protocol`'s `git-hunks.ts`). A genuinely empty untracked file gets no hunk at all (there is nothing to stage). */
async function buildUntrackedHunkFile(
  target: ExecutionTarget,
  worktreePath: string,
  entry: WorktreeStatusEntry,
): Promise<GitHunkFileV1> {
  const worktreeFile = await readWorktreeFile(target, worktreePath, entry.path);
  const content = truncate(worktreeFile.content);
  const rawLines = content.length === 0 ? [] : content.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const unstaged: GitHunkV1[] =
    rawLines.length === 0
      ? []
      : [
          {
            header: `@@ -0,0 +1,${rawLines.length} @@`,
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: rawLines.length,
            lines: rawLines.map((text) => ({ kind: 'added' as const, text })),
          },
        ];
  return { path: entry.path, previousPath: null, status: 'added', staged: [], unstaged };
}

/** A tracked file's hunks: `staged` from `git diff --cached` (index vs `HEAD`), `unstaged` from `git diff` (worktree vs index) — both restricted to this one file so {@link parseUnifiedDiff} sees exactly one file's output. Both pathspecs (`previousPath` and `path`) are passed for a rename so a partially-staged rename's content hunks are still found on whichever side has them. */
async function buildTrackedHunkFile(
  target: ExecutionTarget,
  worktreePath: string,
  entry: WorktreeStatusEntry,
): Promise<GitHunkFileV1> {
  const status = await determineHunkFileStatus(target, worktreePath, entry);
  const pathspecs = entry.previousPath !== null ? [entry.previousPath, entry.path] : [entry.path];

  const [stagedResult, unstagedResult] = await Promise.all([
    target.exec('git', [
      '-C',
      worktreePath,
      'diff',
      '--cached',
      '--no-color',
      '-U3',
      '--no-ext-diff',
      '--',
      ...pathspecs,
    ]),
    target.exec('git', [
      '-C',
      worktreePath,
      'diff',
      '--no-color',
      '-U3',
      '--no-ext-diff',
      '--',
      ...pathspecs,
    ]),
  ]);

  const staged = parseUnifiedDiff(stagedResult.stdout).hunks.map((hunk) => hunk.parsed);
  const unstaged = parseUnifiedDiff(unstagedResult.stdout).hunks.map((hunk) => hunk.parsed);
  return { path: entry.path, previousPath: entry.previousPath, status, staged, unstaged };
}

function buildHunkFile(
  target: ExecutionTarget,
  worktreePath: string,
  entry: WorktreeStatusEntry,
): Promise<GitHunkFileV1> {
  return entry.x === '?' && entry.y === '?'
    ? buildUntrackedHunkFile(target, worktreePath, entry)
    : buildTrackedHunkFile(target, worktreePath, entry);
}

/** Every changed file's staged/unstaged hunks, same file set and ordering `computeWorktreeDiff` reports (both read the identical `git status` line). `[]` for a clean worktree — never an error. Throws {@link GitDiffError} only when the diff itself could not be computed at all, same contract as `computeWorktreeDiff`. */
export async function computeHunkDiff(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<GitHunkFileV1[]> {
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
  return Promise.all(entries.map((entry) => buildHunkFile(target, worktreePath, entry)));
}

/** `git status --porcelain=v1 -z --untracked-files=all -- <relPath>`'s own `'??'` prefix, scoped to exactly one path — cheaper than re-running the whole-worktree status {@link computeHunkDiff} already did, since {@link applyGitHunkAction} only ever needs one file's answer. */
async function isUntrackedPath(
  target: ExecutionTarget,
  worktreePath: string,
  relPath: string,
): Promise<boolean> {
  const result = await target.exec('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    relPath,
  ]);
  return result.exitCode === 0 && result.stdout.startsWith('??');
}

async function execGitHunkActionOrThrow(
  target: ExecutionTarget,
  worktreePath: string,
  args: string[],
  failureContext: string,
  input?: string,
): Promise<void> {
  const result = await target.exec('git', ['-C', worktreePath, ...args], { input });
  if (result.exitCode !== 0) {
    throw new GitHunkActionError(
      `${failureContext}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/**
 * Stages, unstages, or discards exactly one hunk (SPEC §7.6; issue #232)
 * — `hunkIndex` addresses `unstaged[hunkIndex]` for `stage`/`discard`,
 * `staged[hunkIndex]` for `unstage` (`@loombox/protocol`'s `git-hunks.ts`
 * doc comment), against a diff recomputed fresh right here — never the
 * caller's own possibly-stale `computeHunkDiff` snapshot.
 *
 * An untracked file's single synthetic hunk (index 0 only — see
 * {@link buildUntrackedHunkFile}) has no real `git diff` counterpart to
 * extract a patch from, so it's handled directly: `stage` is `git add`,
 * `discard` is `git clean -f` (there is no committed/indexed version to
 * fall back to — discarding a brand-new file's only hunk really does
 * delete it, matching `DiscardHunkDialog`'s own confirmation copy),
 * `unstage` always errors (an untracked file's `staged` array is always
 * `[]`).
 *
 * A tracked file's hunk becomes a standalone one-hunk patch
 * ({@link parseUnifiedDiff} + `ParsedUnifiedDiff.preamble`), then `git
 * apply` does the actual mutation — exactly the mechanism `git add -p`/
 * `git restore -p` themselves use for one selected hunk:
 * - `stage`: forward-apply the *unstaged* (index→worktree) hunk with
 *   `--cached` — patches the index toward the worktree for those lines
 *   only.
 * - `unstage`: reverse-apply the *staged* (`HEAD`→index) hunk with
 *   `--cached` — patches the index back toward `HEAD` for those lines
 *   only, worktree untouched.
 * - `discard`: reverse-apply the *unstaged* (index→worktree) hunk with
 *   no `--cached` — patches the actual worktree file back toward the
 *   index for those lines only. Unrecoverable, per this action's own
 *   name and `DiscardHunkDialog`'s confirmation copy.
 */
export async function applyGitHunkAction(
  target: ExecutionTarget,
  worktreePath: string,
  payload: GitHunkActionRequestPayloadV1,
): Promise<void> {
  const { path, hunkIndex, action } = payload;

  if (await isUntrackedPath(target, worktreePath, path)) {
    if (action === 'unstage') {
      throw new GitHunkActionError(`cannot unstage "${path}": it has no staged hunks`);
    }
    if (hunkIndex !== 0) {
      throw new GitHunkActionError(`no such hunk at index ${hunkIndex} for untracked "${path}"`);
    }
    if (action === 'stage') {
      await execGitHunkActionOrThrow(
        target,
        worktreePath,
        ['add', '--', path],
        `failed to stage "${path}"`,
      );
    } else {
      await execGitHunkActionOrThrow(
        target,
        worktreePath,
        ['clean', '-f', '-q', '--', path],
        `failed to discard "${path}"`,
      );
    }
    return;
  }

  const side = action === 'unstage' ? 'staged' : 'unstaged';
  const diffArgs =
    side === 'staged'
      ? ['diff', '--cached', '--no-color', '-U3', '--no-ext-diff', '--', path]
      : ['diff', '--no-color', '-U3', '--no-ext-diff', '--', path];
  const diffResult = await target.exec('git', ['-C', worktreePath, ...diffArgs]);
  if (diffResult.exitCode !== 0) {
    throw new GitHunkActionError(
      `"git diff" failed while preparing to ${action} "${path}": ${diffResult.stderr.trim() || diffResult.stdout.trim()}`,
    );
  }
  const { preamble, hunks } = parseUnifiedDiff(diffResult.stdout);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    throw new GitHunkActionError(
      `no such ${side} hunk at index ${hunkIndex} for "${path}" — the worktree may have changed since the diff was last fetched`,
    );
  }
  const patch = preamble + hunk.patchText;

  const applyArgs = ['apply', '--whitespace=nowarn'];
  if (action === 'stage') applyArgs.push('--cached');
  else if (action === 'unstage') applyArgs.push('--cached', '--reverse');
  else applyArgs.push('--reverse');
  applyArgs.push('-');

  await execGitHunkActionOrThrow(
    target,
    worktreePath,
    applyArgs,
    `"git apply" failed to ${action} a hunk in "${path}"`,
    patch,
  );
}

/**
 * Branch create/switch/merge and stash save/list/pop/drop (SPEC §7.6;
 * issue #234) — `applyGitHunkAction`'s siblings in shape: real `git`
 * subcommands through `ExecutionTarget.exec`, one thrown error class per
 * expected structured failure rather than a single catch-all, so
 * `NodeDaemon`'s bridge (`node-daemon.ts`'s `switchBranchForBridge` and
 * neighbors) can map each one to its own protocol outcome instead of
 * collapsing everything to `'error'`. None of these know anything about
 * `Session` — the worktree-isolated-session guard (a session's own fixed
 * branch never switches from under it, `@loombox/protocol`'s
 * `git-branch.ts` file doc comment) lives entirely in the bridge, applied
 * before `switchBranch`/`createBranch`'s checkout path are ever called.
 */

/** Thrown only when a branch/stash *listing* could not be computed at all — `git` missing from the target, or the worktree isn't a usable git repository. Mirrors {@link GitDiffError}'s own "thrown only when genuinely unusable" contract. */
export class GitBranchError extends Error {}

/** The base class for every branch/stash *action* (create/switch/merge/abort/stash save/pop/drop) that could not be applied — thrown directly for a failure with no more specific shape below; every subclass below still `instanceof GitBranchActionError`, so a caller that only wants "did this fail" can catch this alone. */
export class GitBranchActionError extends Error {}

/** `createBranch` for a name git itself reports as already taken ("A branch named '<name>' already exists"). */
export class GitBranchAlreadyExistsError extends GitBranchActionError {}

/** `switchBranch`/`mergeBranch` for a name that matches no local or remote-tracking branch at all. */
export class GitBranchNotFoundError extends GitBranchActionError {}

/** `switchBranch` (and, through it, `createBranch`'s own checkout path) when real `git checkout` output shows local changes — tracked or untracked — that switching would overwrite, parsed into {@link paths} rather than left as a raw stderr paragraph (issue #234's own acceptance bar: an honest, actionable state). */
export class GitDirtyWorktreeError extends GitBranchActionError {
  readonly paths: string[];
  constructor(message: string, paths: string[]) {
    super(message);
    this.paths = paths;
  }
}

/** `mergeBranch` when the merge stops on real conflicts — {@link conflictedPaths} from `git diff --name-only --diff-filter=U`, the actual unmerged files, never a swallowed nonzero exit (issue #234's own acceptance bar: a state the client can render and the user can resolve or abort via {@link abortMerge}). */
export class GitMergeConflictError extends GitBranchActionError {
  readonly conflictedPaths: string[];
  constructor(message: string, conflictedPaths: string[]) {
    super(message);
    this.conflictedPaths = conflictedPaths;
  }
}

/** `stashPop`/`stashDrop` for an index naming no real stash entry. */
export class GitStashNotFoundError extends GitBranchActionError {}

/** `stashPop` when the pop cannot complete cleanly — issue #234's own named failure mode, "a stash that cannot pop". Real git conflict-markers the worktree AND keeps the stash entry rather than dropping it (git's own safety behaviour), so nothing is lost either way; {@link conflictedPaths} is the same `git diff --name-only --diff-filter=U` signal {@link GitMergeConflictError} uses. */
export class GitStashPopConflictError extends GitBranchActionError {
  readonly conflictedPaths: string[];
  constructor(message: string, conflictedPaths: string[]) {
    super(message);
    this.conflictedPaths = conflictedPaths;
  }
}

/** Every currently-unmerged path — `git diff --name-only --diff-filter=U`, real during a stopped merge or a failed stash pop alike (both leave the index in the same conflicted shape). Never throws: an unmerged-free worktree (nothing to report) and a target that can't even run the command both resolve `[]`, since a caller only reaches this after its own `git merge`/`git stash pop` already told it something is wrong. */
async function listConflictedPaths(target: ExecutionTarget, worktreePath: string): Promise<string[]> {
  const result = await target
    .exec('git', ['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U'])
    .catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Extracts the actual conflicting paths from real `git checkout`'s own "Your local changes to the following files would be overwritten by checkout:" (tracked) or "The following untracked working tree files would be overwritten by checkout:" (untracked) stderr shape — one indented path per line between that header and the trailing "Please ... before you switch branches" paragraph. `null` when `stderr` matches neither shape (a genuinely different failure). */
function parseCheckoutOverwritePaths(stderr: string): string[] | null {
  const lines = stderr.split('\n');
  const headerIndex = lines.findIndex((line) => line.includes('would be overwritten by checkout'));
  if (headerIndex === -1) return null;
  const paths: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('\t') && !line.startsWith('    ')) break;
    const trimmed = line.trim();
    if (trimmed) paths.push(trimmed);
  }
  return paths;
}

/** Every local branch in `worktreePath`, `current` tagging whichever one `git branch --list`'s own `'* '` prefix marks — a detached `HEAD`'s synthetic `(HEAD detached at ...)` pseudo-entry is dropped rather than reported as a branch named `"(HEAD..."`. `[]` for a repo with no branches at all (an unborn `HEAD`) — never an error. Throws {@link GitBranchError} only when the list itself could not be computed at all. */
export async function listBranches(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<GitBranchSummaryV1[]> {
  let result;
  try {
    result = await target.exec('git', ['-C', worktreePath, 'branch', '--list']);
  } catch (error) {
    throw new GitBranchError(
      `git is not available on this target: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new GitBranchError(
      `"git branch" failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const current = line.startsWith('* ');
      const name = (current ? line.slice(2) : line).trim();
      return { name, current };
    })
    .filter((entry) => !entry.name.startsWith('('));
}

export interface CreateBranchOptions {
  name: string;
  /** Branched off `HEAD` when `null`. */
  startPoint: string | null;
}

/** Creates `options.name` off `options.startPoint` (or `HEAD`) — plain `git branch`, never a checkout on its own; a caller wanting create-and-switch composes this with {@link switchBranch} (`NodeDaemon`'s own bridge does, gating the switch half on the worktree-isolated-session guard neither function knows about itself). Throws {@link GitBranchAlreadyExistsError} for a name already taken, {@link GitBranchActionError} for any other failure. */
export async function createBranch(
  target: ExecutionTarget,
  worktreePath: string,
  options: CreateBranchOptions,
): Promise<void> {
  const args = ['branch', options.name];
  if (options.startPoint) args.push(options.startPoint);
  const result = await target.exec('git', ['-C', worktreePath, ...args]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    if (/already exists/.test(detail)) {
      throw new GitBranchAlreadyExistsError(`branch "${options.name}" already exists`);
    }
    throw new GitBranchActionError(`"git branch" failed to create "${options.name}": ${detail}`);
  }
}

export interface SwitchBranchOptions {
  name: string;
}

/** Switches `worktreePath`'s checked-out branch to `options.name` — plain `git checkout <name>`. Throws {@link GitDirtyWorktreeError} (with the real conflicting paths) when local changes would be overwritten, {@link GitBranchNotFoundError} when `<name>` names no branch, {@link GitBranchActionError} for any other failure. Carries no worktree-isolated-session guard of its own — see this file's own doc comment above `GitBranchError`. */
export async function switchBranch(
  target: ExecutionTarget,
  worktreePath: string,
  options: SwitchBranchOptions,
): Promise<void> {
  const result = await target.exec('git', ['-C', worktreePath, 'checkout', options.name]);
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  const dirtyPaths = parseCheckoutOverwritePaths(result.stderr);
  if (dirtyPaths) {
    throw new GitDirtyWorktreeError(
      `switching to "${options.name}" would overwrite local changes`,
      dirtyPaths,
    );
  }
  if (/did not match any file\(s\) known to git|error: pathspec/.test(detail)) {
    throw new GitBranchNotFoundError(`no such branch "${options.name}"`);
  }
  throw new GitBranchActionError(`"git checkout" failed to switch to "${options.name}": ${detail}`);
}

export interface MergeBranchOptions {
  name: string;
}

export interface MergeBranchResult {
  /** `true` only when real `git merge` output includes its own literal "Fast-forward" line — `false` for both a real merge commit and "Already up to date." (nothing moved either way). */
  fastForward: boolean;
}

/** Merges `options.name` into `worktreePath`'s current branch — `git merge --no-edit` (git's own default merge-commit message, no interactive editor). Throws {@link GitMergeConflictError} (with every unmerged path) when the merge stops on real conflicts, {@link GitBranchNotFoundError} when `options.name` names no branch, {@link GitBranchActionError} for any other failure. Never moves which branch is checked out, so — unlike `switchBranch` — this carries no worktree-isolated-session guard: merging upstream INTO an isolated session's own branch is the intended use. */
export async function mergeBranch(
  target: ExecutionTarget,
  worktreePath: string,
  options: MergeBranchOptions,
): Promise<MergeBranchResult> {
  const result = await target.exec('git', ['-C', worktreePath, 'merge', '--no-edit', options.name]);
  if (result.exitCode === 0) {
    return { fastForward: result.stdout.includes('Fast-forward') };
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  const conflicted = await listConflictedPaths(target, worktreePath);
  if (conflicted.length > 0) {
    throw new GitMergeConflictError(`merging "${options.name}" produced conflicts`, conflicted);
  }
  if (/not something we can merge/.test(combined)) {
    throw new GitBranchNotFoundError(`no such branch "${options.name}"`);
  }
  throw new GitBranchActionError(
    `"git merge" failed to merge "${options.name}": ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

/** Aborts a merge stopped on conflicts (`git merge --abort`) — the other half of {@link mergeBranch}'s conflict outcome's "resolve or abort" (issue #234's own acceptance bar). Throws {@link GitBranchActionError} when there is no merge in progress to abort, or the abort itself fails. */
export async function abortMerge(target: ExecutionTarget, worktreePath: string): Promise<void> {
  const result = await target.exec('git', ['-C', worktreePath, 'merge', '--abort']);
  if (result.exitCode !== 0) {
    throw new GitBranchActionError(
      `"git merge --abort" failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/** Every entry on `worktreePath`'s stash stack, index-and-message parsed from `git stash list`'s own `stash@{N}: <message>` lines — index 0 is the most recent, the same addressing {@link stashPop}/{@link stashDrop} take directly. `[]` for an empty stack — never an error. Throws {@link GitBranchError} only when the list itself could not be computed at all. */
export async function listStashes(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<GitStashSummaryV1[]> {
  let result;
  try {
    result = await target.exec('git', ['-C', worktreePath, 'stash', 'list']);
  } catch (error) {
    throw new GitBranchError(
      `git is not available on this target: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new GitBranchError(
      `"git stash list" failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^stash@\{(\d+)\}:\s?(.*)$/.exec(line);
      return match ? { index: Number(match[1]), message: match[2] ?? '' } : { index: 0, message: line };
    });
}

export interface StashSaveOptions {
  message: string | null;
}

export interface StashSaveResult {
  /** `false`, not an error, when there was nothing to stash — real git behaviour ("No local changes to save", exit 0). */
  created: boolean;
}

/** Saves the current worktree onto the stash stack — `git stash push -u`, always including untracked files (see `@loombox/protocol`'s `git-stash.ts` file doc comment for why: `computeWorktreeDiff`/`computeHunkDiff` already treat an untracked file as a real visible change, so leaving one behind here would silently disagree with the diff viewer). Labeled `options.message` when given. Throws {@link GitBranchActionError} for any failure. */
export async function stashSave(
  target: ExecutionTarget,
  worktreePath: string,
  options: StashSaveOptions,
): Promise<StashSaveResult> {
  const args = ['stash', 'push', '-u'];
  if (options.message) args.push('-m', options.message);
  const result = await target.exec('git', ['-C', worktreePath, ...args]);
  if (result.exitCode !== 0) {
    throw new GitBranchActionError(
      `"git stash push" failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return { created: !result.stdout.includes('No local changes to save') };
}

export interface StashPopOptions {
  /** `stash@{0}` (the most recent) when `null`. */
  index: number | null;
}

/** Pops `options.index` off the stash stack — `git stash pop`. Throws {@link GitStashPopConflictError} (with every unmerged path) when the pop cannot complete cleanly (issue #234's own named failure mode: "a stash that cannot pop") — real git conflict-markers the worktree and keeps the stash entry rather than dropping it, so a caller resolves the conflicts and calls {@link stashDrop}, or discards the conflict-marked changes and tries again; nothing is lost either way. Throws {@link GitStashNotFoundError} for an index naming no real entry, {@link GitBranchActionError} for any other failure. */
export async function stashPop(
  target: ExecutionTarget,
  worktreePath: string,
  options: StashPopOptions,
): Promise<void> {
  const ref = `stash@{${options.index ?? 0}}`;
  const result = await target.exec('git', ['-C', worktreePath, 'stash', 'pop', ref]);
  if (result.exitCode === 0) return;
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/No stash entries found|unknown stash reference|is not a valid reference/.test(combined)) {
    throw new GitStashNotFoundError(`no such stash entry "${ref}"`);
  }
  const conflicted = await listConflictedPaths(target, worktreePath);
  if (conflicted.length > 0) {
    throw new GitStashPopConflictError(`popping "${ref}" produced conflicts`, conflicted);
  }
  throw new GitBranchActionError(
    `"git stash pop" failed: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

export interface StashDropOptions {
  index: number;
}

/** Drops `options.index` off the stash stack for good — `git stash drop`, the way out of a resolved (or abandoned) {@link stashPop} conflict, or of an entry no longer wanted. Throws {@link GitStashNotFoundError} for an index naming no real entry, {@link GitBranchActionError} for any other failure. */
export async function stashDrop(
  target: ExecutionTarget,
  worktreePath: string,
  options: StashDropOptions,
): Promise<void> {
  const ref = `stash@{${options.index}}`;
  const result = await target.exec('git', ['-C', worktreePath, 'stash', 'drop', ref]);
  if (result.exitCode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (/No stash entries found|unknown stash reference|is not a valid reference/.test(combined)) {
      throw new GitStashNotFoundError(`no such stash entry "${ref}"`);
    }
    throw new GitBranchActionError(
      `"git stash drop" failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}
