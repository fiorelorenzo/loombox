import type { GitDiffExplainScopeV1, GitHunkV1 } from '@loombox/protocol';
import { computeHunkDiff } from './git-diff';
import type { ExecutionTarget } from './target';

/**
 * AI diff-explain assist (SPEC §7.6; issue #236) — `git-commit.ts`'s
 * (#233) sibling for UNDERSTANDING a diff rather than drafting text FROM
 * one. Same split of responsibility that module's own doc comment
 * establishes: this file only ever produces plain text and a prompt
 * string, both pure and side-effect-free past the one real `git`-backed
 * lookup below; actually prompting the session's own live agent is
 * `NodeDaemon.explainDiffViaAgent`'s job (a `NodeDaemon`-only capability —
 * see that method's own doc comment for why it can't live here).
 *
 * Reuses `./git-diff.ts`'s `computeHunkDiff` for BOTH scopes rather than
 * running a second `git diff` invocation of its own: a `'hunk'` explain
 * picks exactly one `GitHunkV1` out of the addressed file's
 * `staged`/`unstaged` array (`git_hunk_action_request`'s identical
 * `path`/`side`/`hunkIndex` addressing — "valid only against a diff
 * computed fresh at [explain] time on the node", that pair's own doc
 * comment, never a stale index a client might have cached); a `'file'`
 * explain concatenates every hunk on both sides for that path — the exact
 * same hunks the staging surface already renders, just handed to the
 * agent as one combined patch instead of picked apart by hunk. This also
 * makes an untracked file's synthetic single hunk (`computeHunkDiff`'s
 * own doc comment) explainable for free, with no separate `git diff
 * --no-index` code path to maintain.
 */

export class GitDiffExplainError extends Error {}

/**
 * Bounds how much diff text ever reaches the agent's own prompt. Deliberately
 * narrower than `git-commit.ts`'s own `MAX_STAGED_DIFF_TEXT_BYTES`
 * (200,000): that bound covers the WHOLE staged index across every
 * changed file, while this one scopes to a single file's — or a single
 * hunk's — own diff, inherently smaller by construction. Kept generous
 * enough that an ordinary file-sized change still explains from its real
 * content rather than a token-starved fragment, but small enough that a
 * pathological single file (a generated lockfile, a vendored bundle) never
 * burns an outsized share of the agent's own context window on one
 * "explain" turn — issue #250's near-limit warning is exactly what makes
 * that cost visible to the user now, not just a latency/spend concern.
 * `computeExplainDiffText` still explains for an oversized file/hunk, just
 * from a truncated view — same "still works, just narrower" contract
 * `computeStagedDiffText`'s own truncation already documents.
 */
export const MAX_EXPLAIN_DIFF_TEXT_CHARS = 20_000;

/** Renders one hunk back into real unified-diff text — the header line verbatim, then every line re-prefixed with its `' '`/`+`/`-` marker (the exact inverse of `git-diff.ts`'s own hunk-line parsing), so the agent's prompt sees the same shape a human reading `git diff` output would. */
function renderHunkPatchText(hunk: GitHunkV1): string {
  const marker = { context: ' ', added: '+', removed: '-' } as const;
  return [hunk.header, ...hunk.lines.map((line) => marker[line.kind] + line.text)].join('\n');
}

/**
 * Extracts the real diff text `scope` addresses — one hunk's patch text,
 * or a whole file's staged+unstaged hunks concatenated — truncated to
 * {@link MAX_EXPLAIN_DIFF_TEXT_CHARS}. Throws {@link GitDiffExplainError}
 * for a path no longer in the current diff, or a `hunkIndex` that no
 * longer names a real hunk on that side (the worktree changed since the
 * caller's last `git_diff_request`/`git_hunk_diff_request` — the same
 * staleness `GitHunkActionError` already covers for a mutating hunk
 * action); a `GitDiffError` from `computeHunkDiff` itself (no `git` on the
 * target, not a git worktree at all) propagates straight through
 * unmodified.
 */
export async function computeExplainDiffText(
  target: ExecutionTarget,
  worktreePath: string,
  scope: GitDiffExplainScopeV1,
): Promise<string> {
  const files = await computeHunkDiff(target, worktreePath);
  const file = files.find((f) => f.path === scope.path);
  if (!file) {
    throw new GitDiffExplainError(`"${scope.path}" has no current changes to explain.`);
  }

  let text: string;
  if (scope.kind === 'hunk') {
    const hunk = (scope.side === 'staged' ? file.staged : file.unstaged)[scope.hunkIndex];
    if (!hunk) {
      throw new GitDiffExplainError(
        `Hunk ${scope.hunkIndex} on the ${scope.side} side of "${scope.path}" no longer exists.`,
      );
    }
    text = renderHunkPatchText(hunk);
  } else {
    const allHunks = [...file.staged, ...file.unstaged];
    if (allHunks.length === 0) {
      throw new GitDiffExplainError(`"${scope.path}" has no current changes to explain.`);
    }
    text = allHunks.map(renderHunkPatchText).join('\n');
  }

  return text.length > MAX_EXPLAIN_DIFF_TEXT_CHARS
    ? text.slice(0, MAX_EXPLAIN_DIFF_TEXT_CHARS)
    : text;
}

/** The literal prompt handed to the session's own live agent to explain a diff (issue #236's "must go through the session's existing agent" — `git-commit.ts`'s `buildCommitDraftPrompt` own sibling). Names the scope in plain language up front so the agent's reply is grounded in what it is actually looking at, and asks for prose only — no diff regurgitation, no fenced code block echoing the input back verbatim. */
export function buildDiffExplainPrompt(scope: GitDiffExplainScopeV1, diffText: string): string {
  const scopeDescription =
    scope.kind === 'hunk'
      ? `one ${scope.side} hunk of "${scope.path}"`
      : `the whole current diff of "${scope.path}"`;
  return [
    `Explain, in plain language for a reviewer, what changed in ${scopeDescription} and why it likely matters. Be concise: a short paragraph, or a few bullet points for a change that touches several distinct things.`,
    'Respond with ONLY the explanation text and nothing else: no preamble, no restating the raw diff, no surrounding quotes or code fences.',
    '',
    '```diff',
    diffText,
    '```',
  ].join('\n');
}
