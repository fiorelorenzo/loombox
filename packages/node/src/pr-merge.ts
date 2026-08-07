import { z } from 'zod';
import type { PrMergeBlockedReason, PrMergeMethod, PrMergeOutcome } from '@loombox/protocol';

/**
 * Merges a session's open pull request (SPEC §7.14 "...and merge"; issue
 * #240) via a direct GitHub REST call — the merge sibling of
 * `review-comment-watcher.ts`'s GraphQL poll and `ci-check-watcher.ts`'s
 * REST poll, all three sharing the exact same SPEC §7.26 connected-
 * account credential seam (a bearer token handed in, never resolved by
 * this module itself). Unlike `pr-open.ts`'s `openPr`, this never touches
 * `gh` or the session's own execution target — merging needs no
 * checkout, no working tree, nothing local at all, just two GitHub API
 * calls: read the PR's current mergeability, then merge it.
 *
 * **Read before write, always.** GitHub's own merge endpoint
 * (`PUT .../merge`) collapses "blocked by branch protection" and "a real
 * merge conflict" into the identical 405 response — it does not
 * distinguish them itself. This module reads the PR's `mergeable`/
 * `mergeable_state`/`draft`/`merged` fields FIRST and classifies the
 * outcome from those (GitHub's own, more expressive vocabulary for
 * exactly this question) before ever attempting the write; the `PUT` is
 * only ever issued once that read reports `mergeable_state: 'clean'`
 * (or `'has_hooks'`, GitHub's own "clean, but this repo also has a
 * pre-receive hook installed" variant). This is what makes
 * `PrMergeOutcome`'s `'blocked'` vs `'conflict'` distinction (SPEC §7.14
 * "reports success/failure clearly") an honest read of GitHub's own
 * state rather than a guess from a single ambiguous status code.
 */

const GITHUB_API_BASE = 'https://api.github.com';

const pullRequestStateSchema = z.object({
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  state: z.string(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
});

const mergeResponseSchema = z.object({
  merged: z.boolean().optional(),
  sha: z.string().optional(),
  message: z.string().optional(),
});

export interface MergePrOptions {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly method: PrMergeMethod;
  /** The bearer token to merge with — resolved by the caller (`NodeDaemon.resolveCiCheckGithubToken`), never by this module; see this file's own doc comment. */
  readonly token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout, ms. Defaults to 15s, same as `CiCheckWatcher`/`ReviewCommentWatcher`. */
  timeoutMs?: number;
}

/** GitHub's own `mergeable_state` vocabulary, folded down to {@link PrMergeBlockedReason} for the two "not mergeable yet, but genuinely blocked rather than conflicted" values this module ever reaches this classification for (`'clean'`/`'has_hooks'` are handled before this is called; `'dirty'`/`'draft'`/`'unknown'` never reach it either — see `mergePr`'s own call site). */
function blockedReasonFromMergeableState(mergeableState: string | undefined): PrMergeBlockedReason {
  switch (mergeableState) {
    case 'blocked':
    case 'unstable':
      return 'requirements_not_met';
    case 'behind':
      return 'behind_base';
    default:
      return 'unknown';
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads `owner/repo#prNumber`'s current mergeability and merges it if
 * clean — see this module's own doc comment for the read-then-write
 * rationale. Never throws for an expected GitHub-side outcome (a draft, a
 * conflict, a still-computing mergeability, ...) — every one of those is
 * its own named {@link PrMergeOutcome}; only a response this module's own
 * schema genuinely can't parse propagates as a thrown error, for the
 * caller to fold into its own `'failed'`/`'unknown'`.
 */
export async function mergePr(options: MergePrOptions): Promise<PrMergeOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = `${GITHUB_API_BASE}/repos/${options.owner}/${options.repo}/pulls/${options.prNumber}`;
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/vnd.github+json',
  };

  const readResponse = await fetchWithTimeout(fetchImpl, base, { headers }, timeoutMs);
  if (!readResponse.ok) {
    return {
      outcome: 'failed',
      category: 'unknown',
      detail: `GitHub returned ${readResponse.status} reading pull request state`,
    };
  }
  const pr = pullRequestStateSchema.parse(await readResponse.json());

  if (pr.merged) return { outcome: 'already_merged' };
  if (pr.state !== 'open') return { outcome: 'blocked', reason: 'closed' };
  if (pr.draft) return { outcome: 'blocked', reason: 'draft' };
  if (pr.mergeable === null || pr.mergeable === undefined || pr.mergeable_state === 'unknown') {
    // GitHub computes mergeability asynchronously off the merge endpoint
    // itself — a freshly-opened or freshly-pushed PR can genuinely have
    // neither yet. Distinct from `'blocked'`: retrying shortly, not
    // fixing anything, is the correct next step.
    return { outcome: 'not_ready' };
  }
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    return { outcome: 'conflict' };
  }
  if (pr.mergeable_state !== 'clean' && pr.mergeable_state !== 'has_hooks') {
    return { outcome: 'blocked', reason: blockedReasonFromMergeableState(pr.mergeable_state) };
  }

  const mergeResponse = await fetchWithTimeout(
    fetchImpl,
    `${base}/merge`,
    {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ merge_method: options.method }),
    },
    timeoutMs,
  );

  // GitHub's merge endpoint itself: 405 means "not mergeable" (branch
  // protection raced ahead of the read above), 409 means the head sha
  // moved out from under this merge attempt — both are races against the
  // read-then-write gap just above, not this module's own bug.
  if (mergeResponse.status === 405) return { outcome: 'blocked', reason: 'requirements_not_met' };
  if (mergeResponse.status === 409) return { outcome: 'conflict' };
  if (!mergeResponse.ok) {
    const detail = await mergeResponse
      .json()
      .then((body: unknown) => mergeResponseSchema.parse(body).message)
      .catch(() => undefined);
    return { outcome: 'failed', category: 'unknown', detail };
  }

  const merged = mergeResponseSchema.parse(await mergeResponse.json());
  if (!merged.sha) {
    return {
      outcome: 'failed',
      category: 'unknown',
      detail: 'GitHub reported success with no merge sha',
    };
  }
  return { outcome: 'merged', sha: merged.sha };
}
