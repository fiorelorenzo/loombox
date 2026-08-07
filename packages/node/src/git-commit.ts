import type { ExecutionTarget } from './target';

/**
 * Committing what's currently staged (SPEC §7.6; issue #233) — #232's
 * hunk-level staging's own next step: the index is now something a user
 * can actually curate (`./git-diff.ts`'s `applyGitHunkAction`), so this
 * turns a curated index into a real commit, with a message drafted from
 * the staged diff.
 *
 * Draft generation itself does NOT live here: the issue's own constraint
 * ("message generation must go through the session's existing agent
 * rather than a new provider path") means prompting the session's own
 * live `AgentSession` — a `NodeDaemon`-only capability (it alone holds
 * the live `SessionBridge`), so that half lives in `NodeDaemon.
 * draftCommitMessageViaAgent`/`draftGitCommitMessageForBridge`. This
 * module only ever drives real `git` subcommands through
 * `ExecutionTarget.exec`, exactly like `./git-diff.ts`'s
 * `computeHunkDiff`/`applyGitHunkAction` (this module's own siblings,
 * same target-agnostic local-vs-`ssh:` seam) — {@link computeStagedDiffText}
 * supplies the raw material `NodeDaemon` folds into the agent's own
 * prompt, {@link commitStaged} performs the actual commit.
 */

/** Thrown only for a commit that genuinely could not happen: an empty index (nothing staged), an empty message, or the underlying `git` command itself failing. Mirrors `GitDiffError`/`GitHunkActionError`'s own "thrown only when genuinely unusable" contract. */
export class GitCommitError extends Error {}

/** Mirrors `git-diff.ts`'s own `MAX_GIT_DIFF_TEXT_BYTES` — the same "never tie up the encrypted channel (here: the agent's own prompt/context) on an accidentally huge diff" reasoning, applied to the whole staged diff text `computeStagedDiffText` returns rather than per file. An oversized diff still drafts, just from a truncated view. */
const MAX_STAGED_DIFF_TEXT_BYTES = 200_000;

/** `git diff --cached`'s own text for the whole worktree at `worktreePath` — every staged hunk, concatenated, exactly as `git apply`/a human's own `git diff --cached` would show it. Truncated per {@link MAX_STAGED_DIFF_TEXT_BYTES} above; never throws for an empty index (an empty string is a legitimate answer a caller checks for itself — see `NodeDaemon.draftGitCommitMessageForBridge`), only for a genuinely failing `git diff` invocation. */
export async function computeStagedDiffText(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<string> {
  const result = await target.exec('git', [
    '-C',
    worktreePath,
    'diff',
    '--cached',
    '--no-color',
    '--no-ext-diff',
  ]);
  if (result.exitCode !== 0) {
    throw new GitCommitError(
      `"git diff --cached" failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.length > MAX_STAGED_DIFF_TEXT_BYTES
    ? result.stdout.slice(0, MAX_STAGED_DIFF_TEXT_BYTES)
    : result.stdout;
}

/** The literal prompt handed to the session's own live agent to draft a commit message (issue #233's "must go through the session's existing agent" — see `NodeDaemon.draftGitCommitMessageForBridge`'s own doc comment for why that lives there, not here). Asks for the message ALONE, so the node can treat the agent's whole reply as the draft verbatim rather than parsing preamble back apart. */
export function buildCommitDraftPrompt(stagedDiffText: string): string {
  return [
    "Write a concise git commit message for the following staged changes, in this project's own style (a short imperative summary line, a blank line, then an optional body only if it adds real information).",
    'Respond with ONLY the commit message text and nothing else: no preamble, no explanation, no surrounding quotes or code fences.',
    '',
    '```diff',
    stagedDiffText,
    '```',
  ].join('\n');
}

/** The commit `commitStaged` just created — its full sha, for a caller (or a test) to look up independently rather than trusting this call's own success as the only proof. */
export interface GitCommitResult {
  sha: string;
}

/**
 * Commits every currently staged change with `message` (SPEC §7.6; issue
 * #233's acceptance: "commit what is staged, with a message the agent
 * drafts... user must be able to edit the draft before committing" —
 * this function is the very last step of that flow, called only once an
 * operator has explicitly confirmed; it has no notion of "draft" vs
 * "edited" itself, only ever the final text).
 *
 * Never trusts a caller's own "there is something staged" belief: `git
 * diff --cached --quiet`'s exit code is re-checked fresh right here,
 * exactly like `applyGitHunkAction`'s own "never trust a stale snapshot"
 * rule — an empty index (nothing staged at all, or everything got
 * unstaged since a draft was generated) is refused with a clear
 * {@link GitCommitError} rather than silently producing an empty commit.
 *
 * `message` travels to `git commit` via `-F -` (stdin), never `-m`
 * string-concatenated onto argv: a message starting with `-`, containing
 * newlines, or anything else a human might type is never misinterpreted
 * as another flag.
 */
export async function commitStaged(
  target: ExecutionTarget,
  worktreePath: string,
  message: string,
): Promise<GitCommitResult> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new GitCommitError('commit message is empty');
  }

  const stagedCheck = await target.exec('git', ['-C', worktreePath, 'diff', '--cached', '--quiet']);
  if (stagedCheck.exitCode === 0) {
    throw new GitCommitError('nothing staged to commit — stage at least one hunk first');
  }
  if (stagedCheck.exitCode !== 1) {
    throw new GitCommitError(
      `failed to check the index: ${stagedCheck.stderr.trim() || stagedCheck.stdout.trim()}`,
    );
  }

  const commitResult = await target.exec(
    'git',
    ['-C', worktreePath, 'commit', '--quiet', '-F', '-'],
    { input: trimmedMessage },
  );
  if (commitResult.exitCode !== 0) {
    throw new GitCommitError(
      `"git commit" failed: ${commitResult.stderr.trim() || commitResult.stdout.trim()}`,
    );
  }

  const shaResult = await target.exec('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
  if (shaResult.exitCode !== 0) {
    throw new GitCommitError(
      `commit succeeded but "git rev-parse HEAD" failed: ${shaResult.stderr.trim() || shaResult.stdout.trim()}`,
    );
  }
  return { sha: shaResult.stdout.trim() };
}
