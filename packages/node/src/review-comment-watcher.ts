import { z } from 'zod';
import type { ReviewCommentStateV1, ReviewCommentThreadV1 } from '@loombox/protocol';

/**
 * Polls a session's open pull request's review threads (SPEC §7.14
 * "handle review comments"; issue #240) — the review-comment sibling of
 * `ci-check-watcher.ts`: same fixed-interval, per-key registry,
 * one-pass-at-a-time shape, same injected `resolveToken`/`fetchImpl`
 * credential seam (see that file's own doc comment for the full
 * rationale, which applies here unchanged — `NodeDaemon`'s own
 * `resolveCiCheckGithubToken` is reused as-is for this watcher too,
 * rather than a second token path).
 *
 * **Why GraphQL, not REST.** GitHub's REST `pulls/{n}/comments` endpoint
 * returns individual review comments with no field at all for "is the
 * conversation this comment belongs to resolved" — that is a GraphQL-only
 * concept (`PullRequestReviewThread.isResolved`, flipped by the
 * `resolveReviewThread` mutation a reviewer/author triggers from the PR's
 * own UI). A review comment differs from a CI check failure in exactly
 * the way issue #240 asks this module to make legible: it is a human
 * waiting for a reply, not a machine waiting for a retry, and "waiting"
 * has an actual end state — resolved — that only the GraphQL API can see.
 *
 * **Only unresolved threads are ever reported.** `fetchState` filters
 * `isResolved: true` threads out of `ReviewCommentStateV1.threads`
 * entirely, rather than reporting every thread with a flag on each. This
 * is deliberate: it is the whole mechanism behind "a resolved thread
 * clears [the inbox item]" (issue #240's acceptance) — a client's own
 * inbox item disappears the moment a thread stops appearing in this
 * list, no separate "thread resolved" event or client-side bookkeeping
 * needed, the exact same "state, not a diff" contract `CiCheckWatcher`
 * already established for `checkRuns`.
 *
 * **Exactly-once-per-new-comment dedup.** `onNewComment` fires once per
 * comment id this watcher has never seen before, on any still-unresolved
 * thread; a comment already seen (this poll re-observing an old
 * still-open thread, or a later poll still open on it) never fires
 * again — issue #240's "act once per new comment, not once per poll".
 * Unlike `CiCheckWatcher.onFailure`'s sha-keyed dedup, a comment id is
 * never forgotten once notified (there is no legitimate "the same
 * comment came back" re-fire the way a CI re-run on an old sha is a
 * legitimate new failure) — `NodeDaemon` wires this hook to nothing more
 * than a best-effort log, deliberately never to `promptSession`: a review
 * comment's action is a human decision (forward it into the session, or
 * don't), never an automatic agent turn the way a red check is (this
 * file's own top-of-module rationale, and issue #240's "the action is
 * different").
 */

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

const reviewThreadCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  createdAt: z.string(),
  url: z.string().nullable().optional(),
  author: z.object({ login: z.string() }).nullable().optional(),
});

const reviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  comments: z.object({ nodes: z.array(reviewThreadCommentSchema) }),
});

const reviewThreadsResponseSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              reviewThreads: z.object({ nodes: z.array(reviewThreadSchema) }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** One session's watched PR — everything `ReviewCommentWatcher` needs to poll it. A deliberate subset of `CiCheckWatcher`'s own `CiWatchEntry` (no `ref`: a review thread is addressed by PR number, never by commit/branch) — `NodeDaemon` builds this from the exact same `parseGithubPullRequestUrl`/`OpenPrResult` `registerCiCheckWatch` already computes, so a `CiWatchEntry` value satisfies this interface's shape as-is. */
export interface ReviewCommentWatchEntry {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly prUrl: string;
  /** Carried through into `resolveToken` on every poll, never cached — mirrors `CiWatchEntry.projectPath`'s own doc comment: a project's account pin can change between polls, and every poll must see the current one. */
  readonly projectPath: string;
}

function unknownState(entry: ReviewCommentWatchEntry, now: number): ReviewCommentStateV1 {
  return {
    state: 'unknown',
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    threads: [],
    updatedAt: now,
  };
}

/** The GraphQL query this watcher sends on every poll — `first: 100` threads/comments each, a generous ceiling no real PR review conversation approaches in practice, and simplest to reason about (no pagination state to carry between polls). */
const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes { id body path line createdAt url author { login } }
          }
        }
      }
    }
  }
}`;

export interface ReviewCommentWatcherOptions {
  /** How often to repoll every registered session, ms. Defaults to 60s, same as `CiCheckWatcher`. */
  intervalMs?: number;
  /** Per-poll fetch timeout, ms. Defaults to 15s, same as `CiCheckWatcher`. */
  timeoutMs?: number;
  now?: () => number;
  /** Injectable for tests; defaults to the global `fetch`. Never used unless `resolveToken` returns a real token first. */
  fetchImpl?: typeof fetch;
  /** The only source of a GitHub bearer token this class ever consults — mirrors `CiCheckWatcher`'s own credential seam. */
  resolveToken: (entry: ReviewCommentWatchEntry) => Promise<string | undefined>;
  /** Called after every completed poll of a watched session, whatever the resulting state — mirrors `CiCheckWatcher.onUpdate`. `NodeDaemon` wires this to push `review_comment_status`. */
  onUpdate?: (sessionId: string, state: ReviewCommentStateV1) => void;
  /** Called once per genuinely new (never-before-seen) comment id observed on a still-unresolved thread — see this file's own doc comment for the dedup rule and why `NodeDaemon` never wires this to an automatic agent turn. */
  onNewComment?: (
    sessionId: string,
    state: ReviewCommentStateV1,
    thread: ReviewCommentThreadV1,
  ) => void;
}

export class ReviewCommentWatcher {
  private readonly entries = new Map<string, ReviewCommentWatchEntry>();
  private readonly latest = new Map<string, ReviewCommentStateV1>();
  /** sessionId -> every comment id `onNewComment` has already fired for. Never pruned except by `unwatch` — a comment id is globally unique and a legitimate re-fire only ever happens for a genuinely new comment, never a repeat of an old one (unlike `CiCheckWatcher`'s sha-keyed dedup, which deliberately DOES reset on recovery). */
  private readonly notifiedCommentIds = new Map<string, Set<string>>();
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveToken: (entry: ReviewCommentWatchEntry) => Promise<string | undefined>;
  private readonly onUpdate: ((sessionId: string, state: ReviewCommentStateV1) => void) | undefined;
  private readonly onNewComment:
    | ((sessionId: string, state: ReviewCommentStateV1, thread: ReviewCommentThreadV1) => void)
    | undefined;
  private timer?: ReturnType<typeof setInterval>;
  /** Guards against a slow pass overlapping the next tick, same convention as `CiCheckWatcher.inFlight`. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(options: ReviewCommentWatcherOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveToken = options.resolveToken;
    this.onUpdate = options.onUpdate;
    this.onNewComment = options.onNewComment;
  }

  /** Registers (or replaces) `sessionId`'s watched PR. Polled from the next pass onward. */
  watch(sessionId: string, entry: ReviewCommentWatchEntry): void {
    this.entries.set(sessionId, entry);
  }

  /** Stops polling `sessionId` and forgets its last reading and dedup state — mirrors `CiCheckWatcher.unwatch` exactly. */
  unwatch(sessionId: string): void {
    this.entries.delete(sessionId);
    this.latest.delete(sessionId);
    this.notifiedCommentIds.delete(sessionId);
  }

  latestFor(sessionId: string): ReviewCommentStateV1 | undefined {
    return this.latest.get(sessionId);
  }

  /** Runs one polling pass right now, chained after any pass already in flight so passes never overlap (mirrors `CiCheckWatcher.pollNow`). Resolves once every registered session has been polled. */
  pollNow(): Promise<void> {
    this.inFlight = this.inFlight.then(
      () => this.runPass(),
      () => this.runPass(),
    );
    return this.inFlight;
  }

  private async runPass(): Promise<void> {
    await Promise.all(
      Array.from(this.entries.entries()).map(([sessionId, entry]) =>
        this.pollOne(sessionId, entry),
      ),
    );
  }

  private async pollOne(sessionId: string, entry: ReviewCommentWatchEntry): Promise<void> {
    const state = await this.fetchState(entry).catch(() => unknownState(entry, this.now()));
    // Unwatched (e.g. the session was archived) while this poll was in
    // flight — never resurrect an entry in `latest`, and never fire a
    // hook for a session this watcher was just told to forget.
    if (!this.entries.has(sessionId)) return;

    this.latest.set(sessionId, state);
    this.onUpdate?.(sessionId, state);

    let seen = this.notifiedCommentIds.get(sessionId);
    if (!seen) {
      seen = new Set<string>();
      this.notifiedCommentIds.set(sessionId, seen);
    }
    for (const thread of state.threads) {
      if (seen.has(thread.commentId)) continue;
      seen.add(thread.commentId);
      this.onNewComment?.(sessionId, state, thread);
    }
  }

  private async fetchState(entry: ReviewCommentWatchEntry): Promise<ReviewCommentStateV1> {
    const token = await this.resolveToken(entry);
    if (!token) return unknownState(entry, this.now());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          query: REVIEW_THREADS_QUERY,
          variables: { owner: entry.owner, repo: entry.repo, number: entry.prNumber },
        }),
        signal: controller.signal,
      });
      if (!response.ok) return unknownState(entry, this.now());

      const parsed = reviewThreadsResponseSchema.parse(await response.json());
      if (parsed.errors && parsed.errors.length > 0) return unknownState(entry, this.now());
      const nodes = parsed.data?.repository?.pullRequest?.reviewThreads.nodes ?? [];

      const threads: ReviewCommentThreadV1[] = [];
      for (const thread of nodes) {
        if (thread.isResolved) continue;
        const latestComment = thread.comments.nodes.at(-1);
        if (!latestComment) continue; // GitHub reporting a thread with zero comments never actually happens; defensive only.
        threads.push({
          threadId: thread.id,
          commentId: latestComment.id,
          path: latestComment.path ?? undefined,
          line: latestComment.line ?? undefined,
          authorLogin: latestComment.author?.login,
          body: latestComment.body,
          createdAt: latestComment.createdAt,
          url: latestComment.url ?? undefined,
        });
      }

      return {
        state: threads.length > 0 ? 'pending' : 'clear',
        prUrl: entry.prUrl,
        prNumber: entry.prNumber,
        threads,
        updatedAt: this.now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs an immediate pass, then one every `intervalMs` — mirrors `CiCheckWatcher.start`. */
  start(): void {
    this.pollNow().catch(() => {});
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.pollNow().catch(() => {});
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
