/* ---------------------------------------------------------------------
 * GitHub Projects v2 board support — live tracker slice 3 (SPEC §7.10;
 * issue #218), the GraphQL half of `./github-tracker-backend.ts`'s REST
 * issue backend. Everything in this file is pure or network-only
 * (`fetchImpl`/`now` injected, exactly like `github-tracker-backend.ts`'s
 * own `githubRequest`) — the stateful `GithubTrackerBackend` class wires
 * this module's pieces together as `listBoards`/`addBoardItem`/
 * `moveBoardItemToCategory`/`moveBoardItemToIteration`.
 *
 * **Why GraphQL at all.** Projects v2 has no REST surface — every read
 * and write here is GraphQL, confirmed field-for-field against the
 * public schema (`docs.github.com/public/fpt/schema.docs.graphql`):
 * `Mutation.addProjectV2ItemById` (line 26747, input line 824),
 * `Mutation.updateProjectV2ItemFieldValue` (input line 70283),
 * `ProjectV2SingleSelectField`/`.options` (line 42660/42689),
 * `ProjectV2IterationField`/`.configuration.iterations` (line
 * 42254/42313).
 *
 * **No universal "Status" field — discovered, never assumed.** A
 * Projects v2 board's columns are a single-select FIELD whose OPTIONS
 * are the statuses, and every project defines its own fields with its
 * own names (loombox's own project #4, read live via
 * `gh project field-list 4 --owner fiorelorenzo`, has sixteen fields —
 * `Status`, `Priority`, `Effort`, `Parallel`, ... — three of which are
 * single-select). `discoverGithubBoardFields` never picks a field by
 * name; it picks the single-select field whose OPTIONS all resolve
 * through `@loombox/protocol`'s own `categorizeKnownStatusName` (the
 * exact vocabulary a native record's own status already collapses
 * through — one table, never a second hand-written one). A project
 * whose only single-select fields are `Priority`/`Effort`-shaped (every
 * real option name here) has no column here to guess at, so
 * `statusField` comes back `undefined` with a concrete
 * `statusFieldUnavailableReason` naming exactly which fields were
 * looked at and why each was rejected — never a silent empty board and
 * never an invented category.
 *
 * **The "required extra round trip" (SPEC §7.10).** GitHub has no
 * "set by name" mutation: `updateProjectV2ItemFieldValue`'s `value`
 * takes a `singleSelectOptionId`/`iterationId`, which only exists once
 * that field's own `options`/`iterations` have been read — always via
 * `discoverGithubBoardFields` (through `listBoards`), never invented or
 * cached past a single `listBoards` call by this module itself.
 *
 * **Rate-limit budgeting.** The 5,000 pts/hr PRIMARY budget is GitHub's
 * own server-computed cost, surfaced through the identical
 * `x-ratelimit-remaining`/`x-ratelimit-reset` response headers
 * `github-tracker-backend.ts`'s REST path already checks (GitHub's
 * GraphQL endpoint sends the same headers) — `githubGraphQlRequest`
 * below reuses that exact check, raising the same
 * `GithubTrackerRateLimitError`. The 2,000 pts/min SECONDARY budget has
 * no response header at all (`docs.github.com/en/graphql/overview/
 * rate-limits-and-query-limits-for-the-graphql-api`: "GraphQL requests
 * without mutations cost 1 point, ... with mutations cost 5 points"),
 * so `GithubGraphQlSecondaryBudget` tracks spend locally in a rolling
 * 60s window and refuses a call BEFORE it goes out — the only way a
 * batched board update (many `moveBoardItemToCategory` calls in a tight
 * loop) can avoid tripping a limit GitHub never tells this backend it is
 * approaching.
 * --------------------------------------------------------------------- */

import { categorizeKnownStatusName } from '@loombox/protocol';
import type {
  TrackerBoard,
  TrackerBoardColumn,
  TrackerBoardIterationField,
  TrackerBoardStatusField,
} from '@loombox/shared';

import {
  computeRetryAfterMs,
  GithubTrackerRateLimitError,
  GithubTrackerRequestError,
} from './github-http-errors';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

/** Raised when a 200 GraphQL response's own `errors` array is non-empty, or when it carries neither `data` nor `errors` — a failure mode HTTP status codes never surface (GitHub's GraphQL endpoint answers `200` for a resolver-level error like "no read access to this project" just as often as for success). */
export class GithubGraphQlError extends Error {
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  constructor(errors: ReadonlyArray<{ readonly message: string }>) {
    super(
      `github tracker: GraphQL request failed — ${
        errors.length > 0 ? errors.map((error) => error.message).join('; ') : '(no error message returned)'
      }`,
    );
    this.name = 'GithubGraphQlError';
    this.errors = errors;
  }
}

/** Raised by {@link GithubGraphQlSecondaryBudget.reserve} — proactive, never a server response (GitHub exposes no header for this budget, unlike the primary limit's `x-ratelimit-remaining`). Carries the same `retryAfterMs` shape as `GithubTrackerRateLimitError` so one retry-after-backoff code path covers both. */
export class GithubGraphQlSecondaryRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, spentPoints: number, requestedPoints: number) {
    super(
      `github tracker: GraphQL secondary rate limit would be exceeded (${spentPoints} pts already spent in the trailing 60s, ${requestedPoints} more requested, budget is ${GRAPHQL_SECONDARY_LIMIT_PER_MINUTE} pts/min) — retry in ${retryAfterMs}ms`,
    );
    this.name = 'GithubGraphQlSecondaryRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Point cost GitHub's GraphQL SECONDARY rate limit charges each request shape (`docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api`) — unrelated to the PRIMARY limit's own server-computed cost (surfaced via headers, never this table). */
export const GRAPHQL_QUERY_POINTS = 1;
export const GRAPHQL_MUTATION_POINTS = 5;
const GRAPHQL_SECONDARY_LIMIT_PER_MINUTE = 2000;
const SECONDARY_WINDOW_MS = 60_000;

/**
 * Client-side pacing for GitHub's GraphQL SECONDARY rate limit (SPEC
 * §7.10, issue #218) — see this module's own top comment for why this
 * exists only for the secondary budget, never the primary one. Tracks
 * every reservation in a rolling 60s window; `reserve` throws
 * {@link GithubGraphQlSecondaryRateLimitError} and spends NOTHING when
 * honoring it would exceed the window's budget, so a caller never sends
 * a request this backend already predicts will be rejected.
 */
export class GithubGraphQlSecondaryBudget {
  private readonly spent: Array<{ readonly atMs: number; readonly points: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Total points charged within the trailing 60s of `now()` — also prunes anything older, so this is the one place the window actually slides. */
  private spentInWindow(): number {
    const cutoff = this.now() - SECONDARY_WINDOW_MS;
    while (this.spent.length > 0 && this.spent[0]!.atMs < cutoff) this.spent.shift();
    return this.spent.reduce((total, entry) => total + entry.points, 0);
  }

  reserve(points: number): void {
    const spentSoFar = this.spentInWindow();
    if (spentSoFar + points > GRAPHQL_SECONDARY_LIMIT_PER_MINUTE) {
      const oldest = this.spent[0];
      const retryAfterMs = oldest
        ? Math.max(0, oldest.atMs + SECONDARY_WINDOW_MS - this.now())
        : SECONDARY_WINDOW_MS;
      throw new GithubGraphQlSecondaryRateLimitError(retryAfterMs, spentSoFar, points);
    }
    this.spent.push({ atMs: this.now(), points });
  }
}

/** POSTs one GraphQL operation and returns its `data`, after the identical primary-rate-limit header check `github-tracker-backend.ts`'s REST `githubRequest` already runs (SPEC §7.10; GitHub's GraphQL endpoint sends the same `x-ratelimit-*` headers as REST). Callers reserve SECONDARY budget themselves first — this function only ever talks to the network and the PRIMARY limit, never the local secondary tracker, so it stays reusable by a caller with a different secondary-budget policy. */
export async function githubGraphQlRequest<T>(
  fetchImpl: typeof fetch,
  now: () => number,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetchImpl(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'loombox',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new GithubTrackerRateLimitError(computeRetryAfterMs(response.headers, now()));
  }
  if (!response.ok) {
    throw new GithubTrackerRequestError(response.status, GITHUB_GRAPHQL_URL);
  }

  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors && body.errors.length > 0) throw new GithubGraphQlError(body.errors);
  if (body.data === undefined) {
    throw new GithubGraphQlError([{ message: 'response carried neither `data` nor `errors`' }]);
  }
  return body.data;
}

/**
 * Reads a Projects v2 board's own `id`/`title` plus every field's
 * `id`/`name` (`ProjectV2FieldCommon`, common to every field type), a
 * single-select field's `options`, and an iteration field's
 * `configuration.iterations` — everything {@link discoverGithubBoardFields}
 * needs, in one round trip (`fields(first: 100)`: SPEC §7.10 boards are
 * user-authored with a handful of fields, never approaching GitHub's own
 * 100-per-project practical ceiling for custom fields).
 */
export const PROJECT_V2_BOARD_QUERY = `
query LoomboxProjectV2Board($login: String!, $number: Int!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        title
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              options {
                id
                name
              }
            }
            ... on ProjectV2IterationField {
              configuration {
                iterations {
                  id
                  title
                  startDate
                  duration
                }
              }
            }
          }
        }
      }
    }
  }
}
`.trim();

/** `Mutation.addProjectV2ItemById` (SPEC §7.10; schema line 26747) — links an issue/PR onto a board. Idempotent per GitHub's own documented behavior: re-adding an already-linked item returns that item's existing id rather than erroring or duplicating it. */
export const ADD_PROJECT_V2_ITEM_MUTATION = `
mutation LoomboxAddProjectV2Item($contentId: ID!, $projectId: ID!) {
  addProjectV2ItemById(input: { contentId: $contentId, projectId: $projectId }) {
    item {
      id
    }
  }
}
`.trim();

/** `Mutation.updateProjectV2ItemFieldValue` (SPEC §7.10; schema line 69107/70283) — moves a card by setting one field's value on one item. `$value` is `ProjectV2FieldValue`'s own input shape (`{singleSelectOptionId}` for a column move, `{iterationId}` for an iteration move); the caller builds it, this mutation only ever forwards it verbatim. */
export const UPDATE_PROJECT_V2_ITEM_FIELD_VALUE_MUTATION = `
mutation LoomboxUpdateProjectV2ItemFieldValue(
  $projectId: ID!
  $itemId: ID!
  $fieldId: ID!
  $value: ProjectV2FieldValue!
) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }
  ) {
    projectV2Item {
      id
    }
  }
}
`.trim();

interface GithubProjectV2FieldOption {
  readonly id: string;
  readonly name: string;
}

interface GithubProjectV2Iteration {
  readonly id: string;
  readonly title: string;
  readonly startDate: string;
  readonly duration: number;
}

/** One entry of `PROJECT_V2_BOARD_QUERY`'s `fields.nodes` — every field type flows through this same shape; `options`/`configuration` are present only for the field types that actually have them (`__typename` says which). */
interface GithubProjectV2FieldNode {
  readonly __typename: string;
  readonly id: string;
  readonly name: string;
  readonly options?: readonly GithubProjectV2FieldOption[];
  readonly configuration?: {
    readonly iterations: readonly GithubProjectV2Iteration[];
  };
}

export interface GithubProjectV2BoardResponse {
  readonly repositoryOwner: {
    readonly projectV2: {
      readonly id: string;
      readonly title: string;
      readonly fields: { readonly nodes: readonly GithubProjectV2FieldNode[] };
    } | null;
  } | null;
}

export interface GithubAddProjectV2ItemResponse {
  readonly addProjectV2ItemById: { readonly item: { readonly id: string } | null };
}

const SINGLE_SELECT_TYPENAME = 'ProjectV2SingleSelectField';
const ITERATION_TYPENAME = 'ProjectV2IterationField';

/**
 * Discovers a candidate status field's columns, or reports exactly why
 * `field` doesn't qualify — `undefined` columns (not an empty array)
 * signals disqualification, since a genuinely empty single-select field
 * (`options: []`) is just as disqualified as one with unrecognized
 * options, and both need a caller-visible reason.
 */
function columnsFor(field: GithubProjectV2FieldNode): TrackerBoardColumn[] | undefined {
  const options = field.options ?? [];
  if (options.length === 0) return undefined;
  const columns: TrackerBoardColumn[] = [];
  for (const option of options) {
    const targetCategory = categorizeKnownStatusName(option.name);
    if (targetCategory === undefined) return undefined;
    columns.push({ id: option.id, name: option.name, targetCategory });
  }
  return columns;
}

/**
 * Picks the status field among several candidates that all fully
 * qualify (issue #218): a field literally named "status"
 * (case-insensitive) wins outright when one exists — the one naming
 * convention common enough to break a tie on, never enough on its own
 * to qualify a field whose OPTIONS don't map (`columnsFor` already
 * ruled those out before this function ever sees them). Otherwise the
 * candidate with the most columns wins, on the theory that a fuller
 * multi-stage vocabulary is more likely the project's real workflow
 * field than an incidental two-option one that also happens to map.
 */
function pickStatusField(
  candidates: ReadonlyArray<{ readonly id: string; readonly name: string; readonly columns: TrackerBoardColumn[] }>,
): TrackerBoardStatusField {
  const namedStatus = candidates.find((candidate) => candidate.name.trim().toLowerCase() === 'status');
  const chosen =
    namedStatus ??
    candidates.reduce((best, candidate) => (candidate.columns.length > best.columns.length ? candidate : best));
  return { id: chosen.id, name: chosen.name, columns: chosen.columns };
}

/**
 * Discovers `fields`' own status/iteration fields (issue #218) — the
 * core "genuinely unusual field model" logic this whole module exists
 * for. See this module's top comment for the discovery rule in full;
 * in short, a single-select field qualifies as the status field only
 * when EVERY one of its options resolves through
 * `categorizeKnownStatusName`, and `statusFieldUnavailableReason` names
 * every single-select field this discovery looked at and rejected (or
 * says there were none at all) when nothing qualifies — never a bare
 * `undefined` with no explanation.
 */
export function discoverGithubBoardFields(fields: readonly GithubProjectV2FieldNode[]): {
  statusField?: TrackerBoardStatusField;
  statusFieldUnavailableReason?: string;
  iterationField?: TrackerBoardIterationField;
} {
  const singleSelects = fields.filter((field) => field.__typename === SINGLE_SELECT_TYPENAME);
  const candidates: Array<{ id: string; name: string; columns: TrackerBoardColumn[] }> = [];
  const rejected: string[] = [];
  for (const field of singleSelects) {
    const columns = columnsFor(field);
    if (columns) {
      candidates.push({ id: field.id, name: field.name, columns });
    } else {
      const optionNames = (field.options ?? []).map((option) => option.name);
      rejected.push(
        `"${field.name}" (${optionNames.length > 0 ? optionNames.join(', ') : 'no options'})`,
      );
    }
  }

  const iterationNode = fields.find((field) => field.__typename === ITERATION_TYPENAME);
  const iterationField: TrackerBoardIterationField | undefined = iterationNode?.configuration
    ? {
        id: iterationNode.id,
        name: iterationNode.name,
        iterations: iterationNode.configuration.iterations.map((iteration) => ({
          id: iteration.id,
          title: iteration.title,
          startDate: iteration.startDate,
          duration: iteration.duration,
        })),
      }
    : undefined;

  if (candidates.length === 0) {
    const statusFieldUnavailableReason =
      singleSelects.length === 0
        ? 'this project defines no single-select field at all — Projects v2 has no built-in "Status" concept, only whatever single-select field(s) the project author created'
        : `none of this project's single-select field(s) has options that all map onto a recognizable workflow status (new/in-progress/done): ${rejected.join('; ')}`;
    return { statusFieldUnavailableReason, iterationField };
  }

  return { statusField: pickStatusField(candidates), iterationField };
}

/** `discoverGithubBoardFields` plus the board's own `id`/`title`, packaged as the `TrackerBoard` `GithubTrackerBackend.listBoards` returns. */
export function toTrackerBoard(project: {
  readonly id: string;
  readonly title: string;
  readonly fields: { readonly nodes: readonly GithubProjectV2FieldNode[] };
}): TrackerBoard {
  const { statusField, statusFieldUnavailableReason, iterationField } = discoverGithubBoardFields(
    project.fields.nodes,
  );
  return { id: project.id, name: project.title, statusField, statusFieldUnavailableReason, iterationField };
}

/** The `ProjectV2FieldValue` input `updateProjectV2ItemFieldValue`'s `$value` expects — exactly one of a column move (`singleSelectOptionId`) or an iteration move (`iterationId`), never both (SPEC §7.10). */
export type GithubProjectV2FieldValue =
  | { readonly singleSelectOptionId: string }
  | { readonly iterationId: string };
