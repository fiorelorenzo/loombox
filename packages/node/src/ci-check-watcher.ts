import { z } from 'zod';
import type { CiCheckOverallStateV1, CiCheckRunV1, CiCheckStateV1 } from '@loombox/protocol';

/**
 * Polls a session's open pull request's GitHub Actions check runs (SPEC
 * §7.14 "watch CI checks, surface failures back to the agent"; issue
 * #239), the sibling of `target-health-sampler.ts`: same fixed-interval,
 * per-key registry, one-pass-at-a-time shape, but polling GitHub's REST
 * API through an injected `resolveToken`/`fetchImpl` instead of an
 * `ExecutionTarget` probe.
 *
 * **Credential seam.** `resolveToken` is the ONLY way this class ever
 * gets a GitHub bearer token — it never imports `./connected-account-
 * keyring.ts` or `./github-connect.ts` itself, mirroring
 * `github-tracker-backend.ts`'s own `ResolveGithubCredential` DI pattern
 * (that module's doc comment explains why: the real registry lookup
 * belongs to whichever caller composes this class, here `NodeDaemon`'s
 * own `resolveCiCheckGithubToken`, which reuses SPEC §7.26's connected-
 * account pin resolution — `./account-pin.ts`'s `resolveAccountForRead` —
 * rather than a new token path). `undefined` (no pin configured, ambiguous
 * candidates, or nothing connected) degrades a watched session's state to
 * `'unknown'` for that pass — never an error, and never a fetch attempt.
 *
 * **Exactly-once-per-failure dedup.** `onFailure` — `NodeDaemon`'s hook
 * into `promptSession()` — must fire once per NEW failure, not once per
 * poll a failure happens to still be red on (issue #239's acceptance).
 * "New" is keyed on the failing state's own `headSha`: the first poll that
 * observes `state: 'failing'` for a given commit fires `onFailure` and
 * remembers that sha; every later poll still failing on that SAME sha is
 * silent. The remembered sha is cleared the moment a poll stops observing
 * `'failing'` (recovered to `'passing'`/`'pending'`, or the ref moved to a
 * commit with no check runs yet), so a later failure — even one that
 * happens to land back on an sha seen before (a re-run) — fires again
 * rather than staying suppressed forever.
 */

const GITHUB_API_BASE = 'https://api.github.com';

const githubCheckRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable().optional(),
  output: z
    .object({
      title: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
    })
    .optional(),
});
const githubCheckRunsResponseSchema = z.object({
  total_count: z.number(),
  check_runs: z.array(githubCheckRunSchema),
});

/** GitHub check-run conclusions this watcher treats as a real failure worth surfacing (`ci-check.ts`'s own doc comment explains why this judgment lives here, not as a protocol-level enum constraint). Deliberately conservative: a `conclusion` GitHub returns that ISN'T in this set — including any future value this list doesn't yet know about — is never treated as a failure, only reported as-is for a client to render. */
const FAILING_CONCLUSIONS: Record<string, true> = {
  failure: true,
  timed_out: true,
  action_required: true,
  cancelled: true,
};

export function isFailingConclusion(conclusion: string | null): boolean {
  return conclusion !== null && FAILING_CONCLUSIONS[conclusion] === true;
}

function aggregateState(checkRuns: readonly CiCheckRunV1[]): CiCheckOverallStateV1 {
  if (checkRuns.length === 0) return 'unknown';
  if (checkRuns.some((run) => isFailingConclusion(run.conclusion))) return 'failing';
  if (checkRuns.some((run) => run.status !== 'completed')) return 'pending';
  return 'passing';
}

/** One session's watched PR — everything `CiCheckWatcher` needs to poll it and everything `NodeDaemon` needs to report it back on the wire. Registered by `NodeDaemon.registerCiCheckWatch` right after a successful `openPr` (issue #238), and persisted across a restart by `./ci-watch-store.ts` under the same shape. */
export interface CiWatchEntry {
  readonly owner: string;
  readonly repo: string;
  /** The branch (or, for a detached in-place session, `resolveSessionBranch`'s `detached@<sha>` form) whose check runs this entry polls — GitHub's check-runs-for-ref endpoint accepts either a branch name or a sha, so this is passed straight through. */
  readonly ref: string;
  readonly prNumber: number;
  readonly prUrl: string;
  /** Carried through into `NodeDaemon.resolveCiCheckGithubToken(entry.projectPath)` on every poll (never cached here) — a project's account pin can change between polls, and every poll must see the current one. */
  readonly projectPath: string;
}

const GITHUB_PULL_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/;

/** Parses `owner`/`repo` out of a GitHub-issued pull request URL (`openPr`'s own `OpenPrResult.url`, issue #238) — the one piece `pr-open.ts` never resolves itself (`gh pr create` infers it from the target's own git remote, never returning it structured). `undefined` for anything not shaped like a `https://github.com/<owner>/<repo>/pull/<n>` URL — a GitHub Enterprise host, or any other shape, is out of this watcher's scope (SPEC §7.14: "GitHub first"). */
export function parseGithubPullRequestUrl(
  url: string,
): { owner: string; repo: string } | undefined {
  const match = GITHUB_PULL_URL_PATTERN.exec(url);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2] };
}

function unknownState(entry: CiWatchEntry, now: number): CiCheckStateV1 {
  return {
    state: 'unknown',
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    checkRuns: [],
    updatedAt: now,
  };
}

export interface CiCheckWatcherOptions {
  /** How often to repoll every registered session, ms. Defaults to 60s — check runs change far less often than `TargetHealthSampler`'s resource readings, and GitHub's REST API is rate-limited per token. */
  intervalMs?: number;
  /** Per-poll fetch timeout, ms — a wedged GitHub request must not block every other watched session's own poll forever, same "bounded" reasoning as `TargetHealthSampler.timeoutMs`. Defaults to 15s. */
  timeoutMs?: number;
  now?: () => number;
  /** Injectable for tests; defaults to the global `fetch`. Never used unless `resolveToken` returns a real token first. */
  fetchImpl?: typeof fetch;
  /** The only source of a GitHub bearer token this class ever consults — see this file's own doc comment. */
  resolveToken: (entry: CiWatchEntry) => Promise<string | undefined>;
  /** Called after every completed poll of a watched session, whatever the resulting state — mirrors `TargetHealthSampler.onSample`'s "every pass, not just on change" contract. `NodeDaemon` wires this to push `ci_check_status`. */
  onUpdate?: (sessionId: string, state: CiCheckStateV1) => void;
  /** Called exactly once per new failure — see this file's own doc comment for the dedup rule. `NodeDaemon` wires this to `promptSession`. */
  onFailure?: (sessionId: string, state: CiCheckStateV1) => void;
}

export class CiCheckWatcher {
  private readonly entries = new Map<string, CiWatchEntry>();
  private readonly latest = new Map<string, CiCheckStateV1>();
  private readonly notifiedFailureSha = new Map<string, string>();
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveToken: (entry: CiWatchEntry) => Promise<string | undefined>;
  private readonly onUpdate: ((sessionId: string, state: CiCheckStateV1) => void) | undefined;
  private readonly onFailure: ((sessionId: string, state: CiCheckStateV1) => void) | undefined;
  private timer?: ReturnType<typeof setInterval>;
  /** Guards against a slow pass overlapping the next tick, same convention as `TargetHealthSampler.inFlight`. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(options: CiCheckWatcherOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveToken = options.resolveToken;
    this.onUpdate = options.onUpdate;
    this.onFailure = options.onFailure;
  }

  /** Registers (or replaces) `sessionId`'s watched PR. Polled from the next pass onward. */
  watch(sessionId: string, entry: CiWatchEntry): void {
    this.entries.set(sessionId, entry);
  }

  /** Stops polling `sessionId` and forgets its last reading and dedup state — a session archived mid-poll (see `pollOne`'s own guard) never resurfaces a stale reading or an out-of-date `onFailure` after this returns. */
  unwatch(sessionId: string): void {
    this.entries.delete(sessionId);
    this.latest.delete(sessionId);
    this.notifiedFailureSha.delete(sessionId);
  }

  latestFor(sessionId: string): CiCheckStateV1 | undefined {
    return this.latest.get(sessionId);
  }

  /** Runs one polling pass right now, chained after any pass already in flight so passes never overlap (mirrors `TargetHealthSampler.sampleNow`). Resolves once every registered session has been polled (successfully, rejected, or timed out). */
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

  private async pollOne(sessionId: string, entry: CiWatchEntry): Promise<void> {
    const state = await this.fetchState(entry).catch(() => unknownState(entry, this.now()));
    // Unwatched (e.g. the session was archived) while this poll was in
    // flight — never resurrect an entry in `latest`, and never fire a
    // hook for a session this watcher was just told to forget.
    if (!this.entries.has(sessionId)) return;

    this.latest.set(sessionId, state);
    this.onUpdate?.(sessionId, state);

    if (state.state === 'failing' && state.headSha) {
      if (this.notifiedFailureSha.get(sessionId) !== state.headSha) {
        this.notifiedFailureSha.set(sessionId, state.headSha);
        this.onFailure?.(sessionId, state);
      }
    } else {
      this.notifiedFailureSha.delete(sessionId);
    }
  }

  private async fetchState(entry: CiWatchEntry): Promise<CiCheckStateV1> {
    const token = await this.resolveToken(entry);
    if (!token) return unknownState(entry, this.now());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${GITHUB_API_BASE}/repos/${entry.owner}/${entry.repo}/commits/${encodeURIComponent(entry.ref)}/check-runs?per_page=100`,
        {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
          signal: controller.signal,
        },
      );
      if (!response.ok) return unknownState(entry, this.now());

      const parsed = githubCheckRunsResponseSchema.parse(await response.json());
      const checkRuns: CiCheckRunV1[] = parsed.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        detailsUrl: run.html_url ?? undefined,
        summary: run.output?.summary ?? run.output?.title ?? undefined,
      }));
      return {
        state: aggregateState(checkRuns),
        headSha: parsed.check_runs[0]?.head_sha,
        prUrl: entry.prUrl,
        prNumber: entry.prNumber,
        checkRuns,
        updatedAt: this.now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs an immediate pass, then one every `intervalMs` — idempotent-ish, mirrors `TargetHealthSampler.start`. */
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
