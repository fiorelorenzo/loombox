import { describe, expect, it, vi } from 'vitest';

import {
  discoverGithubBoardFields,
  GithubGraphQlError,
  GithubGraphQlSecondaryBudget,
  GithubGraphQlSecondaryRateLimitError,
  GRAPHQL_MUTATION_POINTS,
  GRAPHQL_QUERY_POINTS,
  githubGraphQlRequest,
  toTrackerBoard,
} from './github-projects-v2';
import { GithubTrackerRateLimitError, GithubTrackerRequestError } from './github-http-errors';

/**
 * `github-projects-v2.ts` (SPEC §7.10, issue #218) — the field-discovery
 * logic, the GraphQL request helper's error/rate-limit handling, and the
 * secondary-rate-limit budget, all unit-tested in isolation from
 * `GithubTrackerBackend` (that class's own wiring — `listBoards`/
 * `addBoardItem`/`moveBoardItemToCategory`/`moveBoardItemToIteration` — is
 * covered in `github-tracker-backend.test.ts`, and the real-relay,
 * real-credential-resolution path in
 * `node-daemon-tracker-live-github-boards.test.ts`, mirroring issue
 * #696's shape for GitHub's live tracker).
 *
 * **The board-fields fixture is recorded, not hand-written.** `LOOMBOX_BOARD_FIELDS`
 * below is `gh project field-list 4 --owner fiorelorenzo --format json`'s
 * real response against loombox's own project board (recorded
 * 2026-08-08), reshaped into this module's own GraphQL response
 * envelope (`type` -> `__typename`, dropped fields `gh`'s CLI adds that
 * the raw GraphQL query never asked for). It has 16 fields, four of
 * them single-select (`Status`, `Priority`, `Effort`, `Parallel`) — the
 * exact "which field is actually the workflow" ambiguity issue #218
 * warns against assuming away.
 */
const LOOMBOX_BOARD_FIELDS = [
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEdcs', name: 'Title' },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEdcw', name: 'Assignees' },
  {
    __typename: 'ProjectV2SingleSelectField',
    id: 'PVTSSF_lAHOAci1qs4Bdjw9zhYEdc0',
    name: 'Status',
    options: [
      { id: 'f75ad846', name: 'Todo' },
      { id: '47fc9ee4', name: 'In Progress' },
      { id: '98236657', name: 'Done' },
    ],
  },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEdc4', name: 'Labels' },
  {
    __typename: 'ProjectV2Field',
    id: 'PVTF_lAHOAci1qs4Bdjw9zhYEdc8',
    name: 'Linked pull requests',
  },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddA', name: 'Milestone' },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddE', name: 'Repository' },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddI', name: 'Reviewers' },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddM', name: 'Parent issue' },
  {
    __typename: 'ProjectV2Field',
    id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddQ',
    name: 'Sub-issues progress',
  },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddU', name: 'Created' },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddY', name: 'Updated' },
  { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEddc', name: 'Closed' },
  {
    __typename: 'ProjectV2SingleSelectField',
    id: 'PVTSSF_lAHOAci1qs4Bdjw9zhZbVog',
    name: 'Priority',
    options: [
      { id: 'c76fc317', name: 'P0' },
      { id: '015792f7', name: 'P1' },
      { id: 'ac34ba44', name: 'P2' },
      { id: 'cb687423', name: 'P3' },
    ],
  },
  {
    __typename: 'ProjectV2SingleSelectField',
    id: 'PVTSSF_lAHOAci1qs4Bdjw9zhZbVx0',
    name: 'Effort',
    options: [
      { id: '1917bf6c', name: 'S' },
      { id: '19da86ee', name: 'M' },
      { id: 'b53cfee4', name: 'L' },
      { id: 'fb6b2ee7', name: 'XL' },
    ],
  },
  {
    __typename: 'ProjectV2SingleSelectField',
    id: 'PVTSSF_lAHOAci1qs4Bdjw9zhZbVx8',
    name: 'Parallel',
    options: [
      { id: '8bb614bd', name: 'Yes' },
      { id: '2ececb59', name: 'No' },
    ],
  },
] as const;

describe('discoverGithubBoardFields against a real recorded board (loombox project #4, issue #218)', () => {
  it('discovers "Status" as the status field — the only one of four single-selects whose options all resolve to a workflow category', () => {
    const result = discoverGithubBoardFields(LOOMBOX_BOARD_FIELDS);

    expect(result.statusFieldUnavailableReason).toBeUndefined();
    expect(result.statusField).toEqual({
      id: 'PVTSSF_lAHOAci1qs4Bdjw9zhYEdc0',
      name: 'Status',
      columns: [
        { id: 'f75ad846', name: 'Todo', targetCategory: 'new' },
        { id: '47fc9ee4', name: 'In Progress', targetCategory: 'indeterminate' },
        { id: '98236657', name: 'Done', targetCategory: 'done' },
      ],
    });
  });

  it('reports no iteration field — loombox\u2019s own board genuinely has none', () => {
    expect(discoverGithubBoardFields(LOOMBOX_BOARD_FIELDS).iterationField).toBeUndefined();
  });

  it('toTrackerBoard packages the discovered fields with the project\u2019s own id/title', () => {
    const board = toTrackerBoard({
      id: 'PVT_kwHOAci1qs4Bdjw9',
      title: 'loombox roadmap',
      fields: { nodes: LOOMBOX_BOARD_FIELDS },
    });

    expect(board.id).toBe('PVT_kwHOAci1qs4Bdjw9');
    expect(board.name).toBe('loombox roadmap');
    expect(board.statusField?.name).toBe('Status');
    expect(board.statusFieldUnavailableReason).toBeUndefined();
  });
});

describe('discoverGithubBoardFields degrades honestly with no usable status field (issue #218 acceptance)', () => {
  const noStatusFields = LOOMBOX_BOARD_FIELDS.filter((field) => field.name !== 'Status');

  it('never invents a category from Priority/Effort/Parallel — none of their options are workflow vocabulary', () => {
    const result = discoverGithubBoardFields(noStatusFields);

    expect(result.statusField).toBeUndefined();
    expect(result.statusFieldUnavailableReason).toBeDefined();
  });

  it('the degrade reason names every rejected single-select field and its actual options', () => {
    const { statusFieldUnavailableReason } = discoverGithubBoardFields(noStatusFields);

    expect(statusFieldUnavailableReason).toContain('Priority');
    expect(statusFieldUnavailableReason).toContain('P0, P1, P2, P3');
    expect(statusFieldUnavailableReason).toContain('Effort');
    expect(statusFieldUnavailableReason).toContain('S, M, L, XL');
    expect(statusFieldUnavailableReason).toContain('Parallel');
    expect(statusFieldUnavailableReason).toContain('Yes, No');
  });

  it('a project with no single-select field at all gets a distinct, still-concrete reason', () => {
    const fieldsWithNoSingleSelect = LOOMBOX_BOARD_FIELDS.filter(
      (field) => field.__typename !== 'ProjectV2SingleSelectField',
    );

    const { statusField, statusFieldUnavailableReason } =
      discoverGithubBoardFields(fieldsWithNoSingleSelect);

    expect(statusField).toBeUndefined();
    expect(statusFieldUnavailableReason).toContain('no single-select field at all');
  });

  it('a single-select field with zero options is disqualified, not treated as a zero-column match', () => {
    const fields = [
      { __typename: 'ProjectV2SingleSelectField', id: 'f1', name: 'Empty', options: [] },
    ];

    const result = discoverGithubBoardFields(fields);

    expect(result.statusField).toBeUndefined();
    expect(result.statusFieldUnavailableReason).toContain('"Empty" (no options)');
  });
});

describe('discoverGithubBoardFields tie-breaking between multiple fully-qualifying single-select fields', () => {
  it('prefers a field literally named "status" (case-insensitive) over a same-shaped rival', () => {
    const fields = [
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'stage-field',
        name: 'Stage',
        options: [
          { id: 'o1', name: 'Todo' },
          { id: 'o2', name: 'Done' },
        ],
      },
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'status-field',
        name: 'status',
        options: [
          { id: 'o3', name: 'Todo' },
          { id: 'o4', name: 'Done' },
        ],
      },
    ];

    const result = discoverGithubBoardFields(fields);

    expect(result.statusField?.id).toBe('status-field');
  });

  it('without a "status"-named candidate, prefers the field with the most columns', () => {
    const fields = [
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'two-column',
        name: 'Stage',
        options: [
          { id: 'o1', name: 'Todo' },
          { id: 'o2', name: 'Done' },
        ],
      },
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'three-column',
        name: 'Workflow',
        options: [
          { id: 'o3', name: 'Todo' },
          { id: 'o4', name: 'In Progress' },
          { id: 'o5', name: 'Done' },
        ],
      },
    ];

    const result = discoverGithubBoardFields(fields);

    expect(result.statusField?.id).toBe('three-column');
  });
});

describe('discoverGithubBoardFields iteration field discovery (issue #218\u2019s "iterations" half)', () => {
  it('discovers an iteration field\u2019s own iterations, field-for-field off the schema shape', () => {
    const fields = [
      {
        __typename: 'ProjectV2IterationField',
        id: 'iter-field',
        name: 'Sprint',
        configuration: {
          iterations: [
            { id: 'iter-1', title: 'Sprint 1', startDate: '2026-08-01', duration: 14 },
            { id: 'iter-2', title: 'Sprint 2', startDate: '2026-08-15', duration: 14 },
          ],
        },
      },
    ];

    const result = discoverGithubBoardFields(fields);

    expect(result.iterationField).toEqual({
      id: 'iter-field',
      name: 'Sprint',
      iterations: [
        { id: 'iter-1', title: 'Sprint 1', startDate: '2026-08-01', duration: 14 },
        { id: 'iter-2', title: 'Sprint 2', startDate: '2026-08-15', duration: 14 },
      ],
    });
  });

  it('status and iteration field discovery are independent — a board can have one, both, or neither', () => {
    const fields = [
      ...LOOMBOX_BOARD_FIELDS,
      {
        __typename: 'ProjectV2IterationField',
        id: 'iter-field',
        name: 'Sprint',
        configuration: { iterations: [] },
      },
    ];

    const result = discoverGithubBoardFields(fields);

    expect(result.statusField?.name).toBe('Status');
    expect(result.iterationField).toEqual({ id: 'iter-field', name: 'Sprint', iterations: [] });
  });
});

describe('GithubGraphQlSecondaryBudget (issue #218: 2,000 pts/min GraphQL secondary limit)', () => {
  it('reserves points silently while under budget', () => {
    const budget = new GithubGraphQlSecondaryBudget(() => 0);
    expect(() => budget.reserve(GRAPHQL_QUERY_POINTS)).not.toThrow();
    expect(() => budget.reserve(GRAPHQL_MUTATION_POINTS)).not.toThrow();
  });

  it('throws GithubGraphQlSecondaryRateLimitError, spending nothing, once a reservation would exceed 2,000 pts within the trailing 60s', () => {
    const now = 0;
    const budget = new GithubGraphQlSecondaryBudget(() => now);
    // 399 mutations * 5 pts = 1995 pts, leaving only 5 pts of headroom.
    for (let i = 0; i < 399; i += 1) budget.reserve(GRAPHQL_MUTATION_POINTS);

    // A 6th-point request rejects...
    expect(() => budget.reserve(6)).toThrow(GithubGraphQlSecondaryRateLimitError);
    // ...and did not spend: a request that exactly fits the remaining 5 pts still succeeds right after.
    expect(() => budget.reserve(5)).not.toThrow();
    expect(() => budget.reserve(1)).toThrow(GithubGraphQlSecondaryRateLimitError);
  });

  it('retryAfterMs is how long until the oldest charge in the window ages out', () => {
    let now = 0;
    const budget = new GithubGraphQlSecondaryBudget(() => now);
    budget.reserve(2000);
    now = 10_000;

    let caught: unknown;
    try {
      budget.reserve(1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GithubGraphQlSecondaryRateLimitError);
    // The oldest (only) charge was at t=0 and ages out of the 60s window at t=60_000; now is t=10_000.
    expect((caught as GithubGraphQlSecondaryRateLimitError).retryAfterMs).toBe(50_000);
  });

  it('a charge older than 60s no longer counts against the budget — the window genuinely slides', () => {
    let now = 0;
    const budget = new GithubGraphQlSecondaryBudget(() => now);
    budget.reserve(2000);
    now = 60_001;

    expect(() => budget.reserve(2000)).not.toThrow();
  });
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as Response;
}

describe('githubGraphQlRequest (issue #218)', () => {
  it('POSTs {query, variables} to /graphql with a bearer token and returns `data` on success', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/graphql');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ghp_tok');
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'query { viewer { login } }',
        variables: { x: 1 },
      });
      return jsonResponse(200, { data: { viewer: { login: 'octocat' } } });
    });

    const data = await githubGraphQlRequest(
      fetchImpl,
      () => 0,
      'ghp_tok',
      'query { viewer { login } }',
      { x: 1 },
    );

    expect(data).toEqual({ viewer: { login: 'octocat' } });
  });

  it('a 403 with x-ratelimit-remaining: 0 raises GithubTrackerRateLimitError — the identical primary-limit signal as REST', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        403,
        { message: 'rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'retry-after': '15' },
      ),
    );

    const error = await githubGraphQlRequest(fetchImpl, () => 0, 'ghp_tok', 'query {}', {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GithubTrackerRateLimitError);
    expect((error as GithubTrackerRateLimitError).retryAfterMs).toBe(15_000);
  });

  it('a non-2xx response with no rate-limit header raises GithubTrackerRequestError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { message: 'oops' }));

    const error = await githubGraphQlRequest(fetchImpl, () => 0, 'ghp_tok', 'query {}', {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GithubTrackerRequestError);
  });

  it('a 200 response with a populated `errors` array raises GithubGraphQlError — GraphQL\u2019s own failure mode HTTP status never surfaces', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { errors: [{ message: 'Could not resolve to a ProjectV2Owner' }] }),
    );

    const error = await githubGraphQlRequest(fetchImpl, () => 0, 'ghp_tok', 'query {}', {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GithubGraphQlError);
    expect((error as GithubGraphQlError).errors).toEqual([
      { message: 'Could not resolve to a ProjectV2Owner' },
    ]);
  });
});
