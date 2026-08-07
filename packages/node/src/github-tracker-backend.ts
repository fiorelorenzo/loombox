/* ---------------------------------------------------------------------
 * The GitHub `TrackerBackend` — live tracker slices 1 + 2 (SPEC §7.10
 * "GitHub, full feature set... REST for issues/comments/labels/
 * milestones/assignees", `docs.github.com/en/rest/issues/*`; issues
 * #213/#215). Implements `@loombox/shared`'s `TrackerBackend` extension
 * point (#209) for `list`/`get`/`create`/`update`/`addComment` (slice 1)
 * plus `listTransitions`/`transition` (slice 2, issue #215) against a
 * bound `owner/repo`. Non-goals, deferred to a later slice/issue: boards/
 * Projects v2 (`listBoards`/`listSprints`/`moveToSprint`, #218) and the
 * Jira backend (#214) — neither of those optional methods is implemented
 * here.
 *
 * **Slice 2 — transitions are GitHub's fixed two-state model, not a
 * discovered workflow (SPEC §7.10).** "GitHub has no built-in transition
 * concept... a transition is `PATCH .../issues/{n} {state, state_reason}`,
 * so `transitions` on the GitHub backend degrades to a fixed two-state
 * set rather than a discovered per-project workflow like Jira's" (#216).
 * `listTransitions` reports the moves actually available from the
 * issue's *current* state — `close_completed`/`close_not_planned` when
 * open, `reopen` when closed — rather than always offering all three;
 * `transition` applies one by PATCHing `state`/`state_reason` together,
 * so closing as "completed" and closing as "not planned" are distinct,
 * inspectable outcomes end to end (`fields.stateReason` on the returned
 * item), never collapsed into a single generic "closed".
 *
 * **Credentials only through `resolveCredential`.** SPEC §7.10: "this
 * section never performs an OAuth flow or stores a token itself; it
 * consumes a resolved credential (`{token}` for GitHub...) from that
 * area." This module never runs the device flow (#222's job,
 * `./github-connect.ts`) and never touches `./keyring.ts` directly. The
 * real connected-accounts credential registry SPEC §7.10 calls
 * `resolveCredential(connectionId)` doesn't exist yet in a directly
 * callable shape — #222 only shipped `GithubConnectService.getAccessToken`,
 * which takes a full `ConnectedAccount`, not the bare `connectionId` a
 * `TrackerBinding` carries — so {@link ResolveGithubCredential} is defined
 * here as the narrow injected dependency this backend actually needs.
 * Whichever issue builds the real registry should make it satisfy this
 * type rather than this backend growing a second, bespoke lookup path.
 * `github-tracker-backend.test.ts` asserts this boundary structurally (this
 * file's own source is grepped for a keyring/`github-connect` import) as
 * well as behaviorally (every request's bearer comes from the injected
 * resolver's return value, nothing else).
 *
 * **Server-side only.** Like every `TrackerBackend` (SPEC §7.10: "runs
 * server-side... never in a client, since it holds bearer tokens"), this
 * lives in `@loombox/node` and is never imported by `apps/web` — see this
 * file's own test for how that is checked. `packages/node` is not in
 * `apps/web`'s dependency graph at all (direct or transitive), the same
 * property that already keeps `./keyring.ts` and `./github-connect.ts` out
 * of the client bundle (the `node:events` hydration break AGENTS.md
 * documents came from a *shared* package pulling in a Node-only module,
 * not from anything reachable through `@loombox/node`).
 *
 * **Real-world GitHub behaviour handled here, each with its own test**
 * (issue #213's acceptance):
 * - Pagination on `list`/`listBindings` via the `Link` response header's
 *   `rel="next"` (`parseNextLink`) — `TrackerListFilter.cursor`/
 *   `TrackerListPage.nextCursor` carry that URL verbatim rather than a
 *   page number, so the next call needs no re-derivation of query params.
 * - Rate limiting: a `403` with `x-ratelimit-remaining: 0` is GitHub's
 *   rate-limit signal, not a permission error — checked before the
 *   generic error branch and raised as `GithubTrackerRateLimitError` with
 *   a computed `retryAfterMs` (from `Retry-After` when present, else
 *   `X-RateLimit-Reset` minus now).
 * - A `404` is reported as `GithubTrackerAccessError`, not "not found":
 *   GitHub returns 404, never 403, when a token has no access to a
 *   private repo/issue, so this backend never tells a caller "gone" when
 *   the truth is "no access".
 * - GitHub's issues-list and single-issue endpoints both return pull
 *   requests (a PR *is* an issue in GitHub's model, distinguished only by
 *   a `pull_request` key on the payload) — filtered out of `list`, and
 *   rejected explicitly in `get` so a PR number never masquerades as a
 *   tracker item.
 * --------------------------------------------------------------------- */

import type {
  TrackerBackend,
  TrackerBackendCapabilities,
  TrackerBinding,
  TrackerItemLive,
  TrackerListFilter,
  TrackerListPage,
  TrackerTransition,
} from '@loombox/shared';
import type { GitHubTarget, WorkflowCategoryV1 } from '@loombox/protocol';

const GITHUB_API_BASE = 'https://api.github.com';

/** The one shape a resolved GitHub credential needs (SPEC §7.10's `{token}` for GitHub). */
export interface GithubCredential {
  readonly token: string;
}

/**
 * Resolves the bearer credential for a `TrackerBinding.connectionId`. The
 * ONLY source of GitHub tokens this backend ever consults — see this
 * module's top comment for why it is defined here rather than imported
 * from an existing connected-accounts registry.
 */
export type ResolveGithubCredential = (connectionId: string) => Promise<GithubCredential>;

/** Raised when GitHub answers `403` with `x-ratelimit-remaining: 0` — retryable, never a permission error. */
export class GithubTrackerRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`github tracker: rate limited (x-ratelimit-remaining: 0) — retry in ${retryAfterMs}ms`);
    this.name = 'GithubTrackerRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Raised for a `404` (no access, not "gone"), a payload that turns out to be a pull request, a binding whose target isn't a GitHub repo, or a `resolveCredential` result with no usable token. */
export class GithubTrackerAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubTrackerAccessError';
  }
}

/** Raised for any other non-2xx GitHub response. */
export class GithubTrackerRequestError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`github tracker: HTTP ${status} from ${url}`);
    this.name = 'GithubTrackerRequestError';
    this.status = status;
  }
}

/** Parses the `Link` response header for `rel="next"`; `undefined` on the last page or when the header is absent. */
function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const segment of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(segment);
    if (match) return match[1];
  }
  return undefined;
}

/** `Retry-After` (seconds) wins when present; otherwise `X-RateLimit-Reset` (unix seconds) minus `nowMs`. Never negative. */
function computeRetryAfterMs(headers: Headers, nowMs: number): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) return Math.max(0, Math.round(resetMs - nowMs));
  }
  return 0;
}

/** Every field this backend reads off a GitHub issue (or pull-request-shaped issue) payload. */
interface GithubIssuePayload {
  number: number;
  title: string;
  html_url: string;
  state: string;
  state_reason?: string | null;
  body: string | null;
  labels: unknown;
  assignees: unknown;
  milestone: unknown;
  user: unknown;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Present (non-null) only when GitHub's issues endpoint is actually returning a pull request. */
  pull_request?: unknown;
}

/** GitHub's issues API returns pull requests as issues — this is the one documented way to tell them apart (`docs.github.com/en/rest/issues/issues#list-repository-issues`: "Note: GitHub's REST API considers every pull request an issue..."). */
function isPullRequestPayload(raw: Record<string, unknown>): boolean {
  return raw.pull_request != null;
}

/**
 * GitHub exposes no third state — `state`/`state_reason` is the entire
 * surface (issue #651, v7 decision F4-2's own framing: "GitHub exposes
 * open/closed plus state_reason"). `open` maps to `new`; `closed` maps
 * to `done` regardless of `state_reason` — a "not planned" close is
 * still a *resolved* issue, not an in-progress one, and GitHub has no
 * signal at all for "started but not done" (that lives in a repo's own
 * labels/Projects-v2 field, out of this backend's scope). A board fed
 * only by GitHub items is therefore expected to show an empty
 * `indeterminate` column — the "empty category still renders" case, not
 * a bug in this mapping.
 */
export function deriveGithubWorkflowCategory(
  state: string,
  stateReason: string | null,
): WorkflowCategoryV1 {
  void stateReason; // carried for callers, not read here — see doc comment above.
  return state === 'closed' ? 'done' : 'new';
}

function toTrackerItem(raw: GithubIssuePayload): TrackerItemLive {
  const stateReason = raw.state_reason ?? null;
  return {
    externalId: String(raw.number),
    title: raw.title,
    url: raw.html_url,
    fields: {
      state: raw.state,
      stateReason,
      workflowCategory: deriveGithubWorkflowCategory(raw.state, stateReason),
      body: raw.body,
      labels: raw.labels,
      assignees: raw.assignees,
      milestone: raw.milestone,
      author: raw.user,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      closedAt: raw.closed_at,
    },
  };
}

/** The GitHub issue-write fields this backend forwards from `create`/`update`'s untyped `fields` bag — everything else is silently dropped rather than sent as an unrecognised key GitHub would reject. `state`/`state_reason` are a plain field PATCH (closing/reopening), not this backend building #215's transition-discovery UI. */
const ISSUE_WRITE_FIELDS = [
  'title',
  'body',
  'labels',
  'assignees',
  'milestone',
  'state',
  'state_reason',
] as const;

function pickIssueWriteFields(fields: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ISSUE_WRITE_FIELDS) {
    if (fields[key] !== undefined) picked[key] = fields[key];
  }
  return picked;
}

/**
 * GitHub's entire transition surface (SPEC §7.10, issue #215): exactly
 * two states plus a `state_reason` qualifier for *why* an issue closed.
 * There is no per-project workflow to discover — this fixed map IS the
 * graph, for every GitHub issue, always — unlike Jira's own
 * `GET .../transitions` discovery (#216, `JiraTrackerBackend`).
 */
const GITHUB_TRANSITIONS: Record<
  string,
  {
    readonly state: 'open' | 'closed';
    readonly stateReason: 'completed' | 'not_planned' | 'reopened';
  }
> = {
  close_completed: { state: 'closed', stateReason: 'completed' },
  close_not_planned: { state: 'closed', stateReason: 'not_planned' },
  reopen: { state: 'open', stateReason: 'reopened' },
};

/** Which of `GITHUB_TRANSITIONS` are actually available given an issue's *current* `state` — a closed issue can only reopen, an open one can only close (one way or the other), never all three at once. `targetCategory` (issue #696) is `deriveGithubWorkflowCategory` applied to each entry's own `GITHUB_TRANSITIONS[id]` — the identical function a read already runs — so a board move matches a transition by CATEGORY, never a hand-duplicated id/category table that could drift from the read-side mapping. */
function transitionsForState(state: string): TrackerTransition[] {
  const targetCategory = (id: string): WorkflowCategoryV1 => {
    const move = GITHUB_TRANSITIONS[id]!;
    return deriveGithubWorkflowCategory(move.state, move.stateReason);
  };
  if (state === 'closed') {
    return [{ id: 'reopen', name: 'Reopen', targetCategory: targetCategory('reopen') }];
  }
  return [
    {
      id: 'close_completed',
      name: 'Close as completed',
      targetCategory: targetCategory('close_completed'),
    },
    {
      id: 'close_not_planned',
      name: 'Close as not planned',
      targetCategory: targetCategory('close_not_planned'),
    },
  ];
}

function requireGithubTarget(target: TrackerBinding['target']): GitHubTarget {
  if (
    typeof target !== 'object' ||
    target === null ||
    !('owner' in target) ||
    !('repo' in target)
  ) {
    throw new GithubTrackerAccessError(
      'github tracker: binding.target is not a GitHubTarget (expected {owner, repo}) — this backend only binds to GitHub repos',
    );
  }
  return target as GitHubTarget;
}

function issuesListUrl(target: GitHubTarget, filter: TrackerListFilter): string {
  // `filter.query` has no equivalent on this per-repo issues-list endpoint
  // (that would need the separate Search API, out of slice 1's scope per
  // issue #213's non-goals) — deliberately unused rather than silently
  // approximated.
  const url = new URL(`${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/issues`);
  url.searchParams.set('state', filter.status ?? 'open');
  if (filter.assignee) url.searchParams.set('assignee', filter.assignee);
  if (filter.limit) {
    url.searchParams.set('per_page', String(Math.min(Math.max(Math.trunc(filter.limit), 1), 100)));
  }
  return url.toString();
}

function issueUrl(target: GitHubTarget, externalId: string): string {
  return `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/issues/${encodeURIComponent(externalId)}`;
}

async function githubRequest(
  fetchImpl: typeof fetch,
  now: () => number,
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'loombox',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  // Checked before the generic !response.ok branch below: a 403 carrying
  // this header is GitHub's rate-limit signal, not a permission error
  // (SPEC §7.10 has no local write queue to smooth over a 429/403-as-
  // rate-limit, so a caller needs to tell the two apart to retry rather
  // than surface a hard access denial).
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new GithubTrackerRateLimitError(computeRetryAfterMs(response.headers, now()));
  }

  // GitHub returns 404, not 403, when the authenticated token has no
  // access to a private repo/issue — it never confirms the resource
  // exists to a caller it won't show it to.
  if (response.status === 404) {
    throw new GithubTrackerAccessError(
      `github tracker: 404 from ${url} — either nothing exists at this URL, or this token has no access to it (GitHub does not distinguish the two)`,
    );
  }

  if (!response.ok) {
    throw new GithubTrackerRequestError(response.status, url);
  }
  return response;
}

export interface GithubTrackerBackendOptions {
  /** The only source of GitHub bearer tokens — see this module's top comment. */
  resolveCredential: ResolveGithubCredential;
  /** Injectable for tests; defaults to the global `fetch`. Issue #213's acceptance: tests must stub this, never hit the real GitHub API. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests' rate-limit retry-after math; defaults to `Date.now`. */
  now?: () => number;
}

/** The GitHub `TrackerBackend` (SPEC §7.10, issues #213/#215). One instance is reusable across every bound repo — `resolveCredential` is re-invoked per call rather than a token being cached on the instance, so a revoked/rotated credential takes effect on the very next call. */
export class GithubTrackerBackend implements TrackerBackend {
  readonly id = 'github' as const;

  /** Slices 1+2 (issues #213/#215): issues, comments, and the fixed two-state transition model. `boards`/`sprints` land in #218; GitHub issues have no generic custom-field analog, so `customFields` stays false permanently for this provider. */
  readonly capabilities: TrackerBackendCapabilities = {
    comments: true,
    transitions: true,
    boards: false,
    sprints: false,
    labels: true,
    milestones: true,
    customFields: false,
  };

  private readonly resolveCredential: ResolveGithubCredential;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: GithubTrackerBackendOptions) {
    this.resolveCredential = options.resolveCredential;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async token(connectionId: string): Promise<string> {
    const credential = await this.resolveCredential(connectionId);
    if (!credential.token) {
      throw new GithubTrackerAccessError(
        `github tracker: resolveCredential('${connectionId}') returned no usable token`,
      );
    }
    return credential.token;
  }

  private async request(
    binding: TrackerBinding,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await this.token(binding.connectionId);
    return githubRequest(this.fetchImpl, this.now, token, url, init);
  }

  /**
   * Repos this connection's token can see, packaged as bindings — what a
   * repo picker needs before it has a `TrackerBinding` to call
   * `list`/`get`/etc. against at all. `GET /user/repos`, paginated via the
   * same `Link`-header walk as `list` (not the Search API: this asks "what
   * can this token see", not "what matches a query", which is out of
   * scope for slice 1 per issue #213's non-goals).
   */
  async listBindings(connectionId: string): Promise<TrackerBinding[]> {
    const token = await this.token(connectionId);
    const bindings: TrackerBinding[] = [];
    let url: string | undefined = `${GITHUB_API_BASE}/user/repos?per_page=100`;
    while (url) {
      const response = await githubRequest(this.fetchImpl, this.now, token, url);
      const repos = (await response.json()) as Array<{ owner: { login: string }; name: string }>;
      for (const repo of repos) {
        bindings.push({ connectionId, target: { owner: repo.owner.login, repo: repo.name } });
      }
      url = parseNextLink(response.headers.get('link'));
    }
    return bindings;
  }

  async list(binding: TrackerBinding, filter: TrackerListFilter): Promise<TrackerListPage> {
    const target = requireGithubTarget(binding.target);
    const url = filter.cursor ?? issuesListUrl(target, filter);
    const response = await this.request(binding, url);
    const body = (await response.json()) as Record<string, unknown>[];
    const items = body
      .filter((raw) => !isPullRequestPayload(raw))
      .map((raw) => toTrackerItem(raw as unknown as GithubIssuePayload));
    return { items, nextCursor: parseNextLink(response.headers.get('link')) };
  }

  async get(binding: TrackerBinding, externalId: string): Promise<TrackerItemLive> {
    const target = requireGithubTarget(binding.target);
    const response = await this.request(binding, issueUrl(target, externalId));
    const raw = (await response.json()) as Record<string, unknown>;
    if (isPullRequestPayload(raw)) {
      throw new GithubTrackerAccessError(
        `github tracker: ${target.owner}/${target.repo}#${externalId} is a pull request, not an issue — GitHub's issues API serves both from the same endpoint, and this backend only surfaces issues`,
      );
    }
    return toTrackerItem(raw as unknown as GithubIssuePayload);
  }

  async create(binding: TrackerBinding, fields: Record<string, unknown>): Promise<TrackerItemLive> {
    const target = requireGithubTarget(binding.target);
    const title = fields.title;
    if (typeof title !== 'string' || title.length === 0) {
      throw new GithubTrackerAccessError(
        'github tracker: create() requires a non-empty string "title" field',
      );
    }
    const response = await this.request(
      binding,
      `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/issues`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pickIssueWriteFields({ ...fields, title })),
      },
    );
    const raw = (await response.json()) as Record<string, unknown>;
    return toTrackerItem(raw as unknown as GithubIssuePayload);
  }

  async update(
    binding: TrackerBinding,
    externalId: string,
    fields: Record<string, unknown>,
  ): Promise<TrackerItemLive> {
    const target = requireGithubTarget(binding.target);
    const response = await this.request(binding, issueUrl(target, externalId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pickIssueWriteFields(fields)),
    });
    const raw = (await response.json()) as Record<string, unknown>;
    return toTrackerItem(raw as unknown as GithubIssuePayload);
  }

  async addComment(binding: TrackerBinding, externalId: string, body: string): Promise<void> {
    const target = requireGithubTarget(binding.target);
    await this.request(binding, `${issueUrl(target, externalId)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  /**
   * The moves actually available from this issue's *current* state
   * (SPEC §7.10, issue #215) — `close_completed`/`close_not_planned` for
   * an open issue, `reopen` for a closed one. Always this fixed pair,
   * never a discovered per-project workflow: GitHub has no workflow
   * concept to discover in the first place.
   */
  async listTransitions(binding: TrackerBinding, externalId: string): Promise<TrackerTransition[]> {
    const target = requireGithubTarget(binding.target);
    const response = await this.request(binding, issueUrl(target, externalId));
    const raw = (await response.json()) as Record<string, unknown>;
    if (isPullRequestPayload(raw)) {
      throw new GithubTrackerAccessError(
        `github tracker: ${target.owner}/${target.repo}#${externalId} is a pull request, not an issue — GitHub's issues API serves both from the same endpoint, and this backend only surfaces issues`,
      );
    }
    return transitionsForState(String((raw as unknown as GithubIssuePayload).state));
  }

  /**
   * Applies one of `GITHUB_TRANSITIONS` by PATCHing `state`/`state_reason`
   * together (SPEC §7.10: "a transition is `PATCH .../issues/{n}
   * {state, state_reason}`"). Close-as-completed and close-as-not-planned
   * are distinct outcomes end to end — the returned/subsequently-read
   * item's `fields.stateReason` carries whichever one was applied, never
   * collapsed into a bare "closed".
   */
  async transition(
    binding: TrackerBinding,
    externalId: string,
    transitionId: string,
  ): Promise<void> {
    const target = requireGithubTarget(binding.target);
    const move = GITHUB_TRANSITIONS[transitionId];
    if (!move) {
      throw new GithubTrackerAccessError(
        `github tracker: unknown transitionId '${transitionId}' — GitHub's fixed set is close_completed/close_not_planned/reopen`,
      );
    }
    await this.request(binding, issueUrl(target, externalId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: move.state, state_reason: move.stateReason }),
    });
  }
}
