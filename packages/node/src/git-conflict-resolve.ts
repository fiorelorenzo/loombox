import type {
  GitConflictHunkOriginV1,
  GitConflictHunkV1,
  GitConflictResolutionHunkV1,
} from '@loombox/protocol';
import { MAX_EXPLAIN_DIFF_TEXT_CHARS } from './git-diff-explain';

/**
 * AI merge-conflict resolution assist (SPEC §7.6; issue #237) —
 * `git-diff-explain.ts`'s (#236) own sibling: pure parsing/prompt-building
 * here, actually prompting the session's own live agent is
 * `NodeDaemon.resolveGitConflictForBridge`'s job (see that method's own
 * doc comment for why it can't live here — the identical split
 * `git-diff-explain.ts`'s own file doc comment already documents).
 *
 * One agent turn PER conflicted hunk, never one turn for the whole file:
 * `buildConflictResolvePrompt` addresses exactly one hunk at a time
 * (`git_diff_explain_request`'s own `'hunk'` scope shape), so each prompt
 * stays small regardless of how large the surrounding file is.
 * {@link MAX_CONFLICT_HUNKS_PER_RESOLVE} is this file's own answer to the
 * cost this creates that `git_diff_explain_request` never had to consider
 * (issue #250's context-limit warning exists because a large prompt is
 * already a known real cost here): a file resolved in one click can only
 * ever spend that many turns, never an unbounded number.
 *
 * `resolveHunkOrigin` is the trust boundary the whole feature exists for
 * (the file's own doc comment in `@loombox/protocol`'s
 * `git-conflict-resolve.ts` explains why): it NEVER trusts the agent's
 * own account of which side it kept, it compares the agent's literal
 * reply against the hunk's real `oursText`/`theirsText` and reports what
 * actually happened.
 */

export class GitConflictResolveError extends Error {}

/** One click's own bound on how many agent turns `resolveGitConflictForBridge` will spend — see the file doc comment's cost-realism note. A file with more conflicted hunks than this refuses outright (`outcome: 'too_large'`) rather than silently spending an unbounded number of turns. */
export const MAX_CONFLICT_HUNKS_PER_RESOLVE = 12;

type ConflictSegment =
  | { readonly kind: 'literal'; readonly text: string }
  | {
      readonly kind: 'hunk';
      readonly oursLabel: string;
      readonly theirsLabel: string;
      readonly oursText: string;
      readonly theirsText: string;
      readonly baseText: string | null;
    };

/**
 * Real git conflict markers (`git`'s default `merge` style, and the
 * optional diff3/zdiff3 `|||||||` base section when `merge.conflictStyle`
 * produces one) — `^<<<<<<< label`, our lines, an optional
 * `^||||||| label` base section, `^=======`, their lines, `^>>>>>>>
 * label`. Named capture groups (1-6): oursLabel, oursText, baseLabel
 * (unused — the base section's own label carries no meaning this feature
 * needs), baseText, theirsText, theirsLabel. `m` so `^`/`$` anchor per
 * line, not the whole string; the lazy `[\s\S]*?` bodies terminate at the
 * next real marker line rather than swallowing the rest of the file.
 */
const CONFLICT_MARKER_RE =
  /^<<<<<<< ([^\n]*)\r?\n([\s\S]*?)(?:^\|\|\|\|\|\|\| ([^\n]*)\r?\n([\s\S]*?))?^=======\r?\n([\s\S]*?)^>>>>>>> ([^\n]*)\r?\n?/gm;

/** Splits `content` into literal (unchanged) text and conflict-hunk segments, in file order — the one real parse both {@link parseConflictMarkers} (lists the hunks) and {@link assembleResolvedContent} (splices resolutions back in) build on, so listing and reassembling can never disagree about where a hunk starts and ends. */
function splitConflictSegments(content: string): ConflictSegment[] {
  const segments: ConflictSegment[] = [];
  let lastIndex = 0;
  CONFLICT_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONFLICT_MARKER_RE.exec(content))) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'literal', text: content.slice(lastIndex, match.index) });
    }
    const [, oursLabel, oursText, , baseText, theirsText, theirsLabel] = match;
    segments.push({
      kind: 'hunk',
      oursLabel: oursLabel ?? '',
      theirsLabel: theirsLabel ?? '',
      oursText: oursText ?? '',
      theirsText: theirsText ?? '',
      baseText: baseText ?? null,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ kind: 'literal', text: content.slice(lastIndex) });
  }
  return segments;
}

/** Parses every real conflict hunk out of `content`, in file order. Throws {@link GitConflictResolveError} when `content` has no conflict markers at all — the same "nothing to do here" refusal `computeExplainDiffText` gives a path with no current changes. */
export function parseConflictMarkers(content: string): GitConflictHunkV1[] {
  const hunks = splitConflictSegments(content)
    .filter((segment) => segment.kind === 'hunk')
    .map((segment, index): GitConflictHunkV1 => ({
      index,
      oursLabel: segment.oursLabel,
      theirsLabel: segment.theirsLabel,
      oursText: segment.oursText,
      theirsText: segment.theirsText,
      baseText: segment.baseText,
    }));
  if (hunks.length === 0) {
    throw new GitConflictResolveError(
      'No conflict markers found — this file is not currently conflicted.',
    );
  }
  return hunks;
}

/** Bounds one hunk side's text before it reaches a prompt — reuses `git-diff-explain.ts`'s own bound rather than inventing a second one (the file doc comment's "reused, not reinvented"); an individual conflict side this large is rare, this is defensive, not the primary cost control (that's {@link MAX_CONFLICT_HUNKS_PER_RESOLVE}, bounding turns rather than truncating content). */
function truncateForPrompt(text: string): string {
  return text.length > MAX_EXPLAIN_DIFF_TEXT_CHARS
    ? `${text.slice(0, MAX_EXPLAIN_DIFF_TEXT_CHARS)}\n… (truncated)`
    : text;
}

/** The literal prompt handed to the session's own live agent to resolve ONE conflict hunk (issue #237's "must go through the session's existing agent" — `git-diff-explain.ts`'s `buildDiffExplainPrompt` own sibling). Asks for the replacement text alone, no markers, no commentary, no fenced code block — the reply becomes `GitConflictResolutionHunkV1.resolvedText` verbatim. */
export function buildConflictResolvePrompt(
  path: string,
  hunk: GitConflictHunkV1,
  hunkNumber: number,
  hunkCount: number,
): string {
  const scopeDescription =
    hunkCount === 1
      ? `the one merge conflict in "${path}"`
      : `merge conflict ${hunkNumber} of ${hunkCount} in "${path}"`;
  return [
    `Resolve ${scopeDescription}.`,
    '',
    `"${hunk.oursLabel}" side (ours):`,
    truncateForPrompt(hunk.oursText),
    '',
    `"${hunk.theirsLabel}" side (theirs):`,
    truncateForPrompt(hunk.theirsText),
    '',
    'Reply with ONLY the final text that should replace this conflicted section — no <<<<<<<' +
      '/=======/>>>>>>> markers, no explanation, no fenced code block. If one side is already' +
      ' correct on its own, reply with that side verbatim; otherwise combine or rewrite as needed.',
  ].join('\n');
}

/** Normalizes line endings and trailing whitespace before comparing two blocks of text — a comparison for TRUST (see the file doc comment), so it must not be fooled by a harmless CRLF/trailing-newline difference the agent's own reply is likely to introduce. */
function normalizeForComparison(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

/** Derives which side (if either) `resolvedText` actually is — see the file doc comment: this NEVER trusts the agent's own account of what it did, it compares the literal reply against the hunk's real `oursText`/`theirsText`. An exact match (modulo line-ending/trailing-whitespace noise) to one side reports that side; anything else — a genuine combination of both, or a fresh rewrite — reports `'rewritten'`, since either way it is not a silent pick of one side. */
export function resolveHunkOrigin(
  hunk: GitConflictHunkV1,
  resolvedText: string,
): GitConflictHunkOriginV1 {
  const normalizedResolved = normalizeForComparison(resolvedText);
  if (normalizedResolved === normalizeForComparison(hunk.oursText)) return 'ours';
  if (normalizedResolved === normalizeForComparison(hunk.theirsText)) return 'theirs';
  return 'rewritten';
}

/** Splices `resolution` back into `content` in place of each real conflict hunk's own markers, leaving every other byte untouched — the same {@link splitConflictSegments} parse {@link parseConflictMarkers} used to list the hunks, so this can never disagree with what was actually shown for review. Ensures each replacement ends with exactly one trailing newline (appending one if the agent's reply omitted it) so it never runs on into whatever follows in the file; the review UI still shows `resolution[i].resolvedText` exactly as the agent wrote it, unpadded — only this assembled copy is newline-safe. Throws {@link GitConflictResolveError} if `resolution` is missing an entry for a hunk `content` actually has. */
export function assembleResolvedContent(
  content: string,
  resolution: readonly GitConflictResolutionHunkV1[],
): string {
  let hunkIndex = 0;
  return splitConflictSegments(content)
    .map((segment) => {
      if (segment.kind === 'literal') return segment.text;
      const resolved = resolution[hunkIndex];
      hunkIndex += 1;
      if (!resolved) {
        throw new GitConflictResolveError(
          `Resolution is missing hunk ${hunkIndex - 1} — the file actually has one there.`,
        );
      }
      return resolved.resolvedText.endsWith('\n')
        ? resolved.resolvedText
        : `${resolved.resolvedText}\n`;
    })
    .join('');
}
