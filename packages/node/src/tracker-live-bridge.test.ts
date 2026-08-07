import { describe, expect, it, vi } from 'vitest';
import type {
  TrackerBackend,
  TrackerBinding,
  TrackerItemLive,
  TrackerTransition,
} from '@loombox/shared';

import type { TrackerBackendResolutionError } from './tracker-backend-composition';
import {
  applyLiveTrackerCategoryMove,
  describeTrackerBackendResolutionError,
  LiveTrackerCategoryMoveError,
  liveItemToTrackerRecord,
  liveTrackerTypeDefinition,
  trackerBackendResolutionErrorToWireV1,
  trackerResolutionErrorPayload,
} from './tracker-live-bridge';

/**
 * `tracker-live-bridge.ts` (SPEC §7.10; issue #631) — the pure mapping
 * layer between a `TrackerBackend`'s `TrackerItemLive` results and the
 * native tracker's own `TrackerRecordV1`/`TrackerTypeDefinitionV1` wire
 * shape, plus the `TrackerBackendResolutionError` -> human text / wire
 * union conversions. Exercised directly (no relay, no node) since none
 * of it depends on either.
 */

function githubItem(overrides: Partial<TrackerItemLive> = {}): TrackerItemLive {
  return {
    externalId: '42',
    title: 'Ship it',
    url: 'https://github.com/fiorelorenzo/loombox/issues/42',
    fields: {
      state: 'open',
      stateReason: null,
      workflowCategory: 'new',
      body: 'body text',
      labels: [],
      assignees: [],
      milestone: null,
      author: { login: 'octocat' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      closedAt: null,
    },
    ...overrides,
  };
}

describe('liveTrackerTypeDefinition', () => {
  it('maps only title/workflowStatus roles onto fields.title/fields.workflowCategory, for both providers', () => {
    expect(liveTrackerTypeDefinition('github')).toEqual({
      id: 'github',
      label: 'GitHub Issue',
      builtin: true,
      roles: { title: 'title', workflowStatus: 'workflowCategory' },
    });
    expect(liveTrackerTypeDefinition('jira')).toEqual({
      id: 'jira',
      label: 'Jira Issue',
      builtin: true,
      roles: { title: 'title', workflowStatus: 'workflowCategory' },
    });
  });
});

describe('liveItemToTrackerRecord', () => {
  it('carries the item\u2019s title/url into fields, real createdAt/updatedAt, and a native record shape a role-driven UI can render unmodified', () => {
    const record = liveItemToTrackerRecord(githubItem(), 'github', 'github:github.com:1111');
    expect(record).toEqual({
      id: '42',
      primaryType: 'github',
      typeTags: [],
      issueNumber: 42,
      archived: false,
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
      fields: {
        state: 'open',
        stateReason: null,
        workflowCategory: 'new',
        body: 'body text',
        labels: [],
        assignees: [],
        milestone: null,
        author: { login: 'octocat' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        closedAt: null,
        title: 'Ship it',
        url: 'https://github.com/fiorelorenzo/loombox/issues/42',
      },
      system: {
        authorId: 'github:github.com:1111',
        linkedCommitSha: [],
        linkedPullRequests: [],
        linkedSessionIds: [],
        activity: [],
        comments: [],
      },
    });
  });

  it('parses a Jira-shaped issue key ("PROJ-123") into a trailing display issueNumber, never used to look anything up', () => {
    const item = githubItem({ externalId: 'PROJ-123', fields: { ...githubItem().fields } });
    const record = liveItemToTrackerRecord(item, 'jira', 'jira:site:1');
    expect(record.id).toBe('PROJ-123');
    expect(record.issueNumber).toBe(123);
  });

  it('falls back to 0 for an external id with no digits at all', () => {
    const item = githubItem({ externalId: 'no-digits-here' });
    const record = liveItemToTrackerRecord(item, 'github', 'github:github.com:1');
    expect(record.issueNumber).toBe(0);
  });

  it('falls back to the injected clock when createdAt/updatedAt are missing or unparseable', () => {
    const item = githubItem({
      fields: { ...githubItem().fields, createdAt: null, updatedAt: 'not-a-date' },
    });
    const record = liveItemToTrackerRecord(item, 'github', 'github:github.com:1', () => 12345);
    expect(record.createdAt).toBe(12345);
    expect(record.updatedAt).toBe(12345);
  });

  it('always reports archived: false \u2014 live mode has no archive concept to read', () => {
    const record = liveItemToTrackerRecord(githubItem(), 'github', 'github:github.com:1');
    expect(record.archived).toBe(false);
  });

  it('stamps system.authorId from the mode\u2019s own connectionId, never a fabricated user id, and leaves every system ledger empty', () => {
    const record = liveItemToTrackerRecord(githubItem(), 'github', 'github:github.com:1111');
    expect(record.system).toEqual({
      authorId: 'github:github.com:1111',
      linkedCommitSha: [],
      linkedPullRequests: [],
      linkedSessionIds: [],
      activity: [],
      comments: [],
    });
  });
});

/** A binding shape neither backend's own `requireXTarget` guard would reject \u2014 the exact fields never matter to `applyLiveTrackerCategoryMove` itself, which only ever forwards `binding` verbatim to whichever `TrackerBackend` method it calls. */
function fakeBinding(): TrackerBinding {
  return { connectionId: 'conn_1', target: { owner: 'fiorelorenzo', repo: 'loombox' } };
}

function fakeItem(fields: Record<string, unknown>): TrackerItemLive {
  return { externalId: '42', title: 'Ship it', url: 'https://example.test/42', fields };
}

/** A minimal `TrackerBackend` double \u2014 every method a `vi.fn`, so a test asserts exactly which ones a given move does or does not call. `listTransitions`/`transition` are present by default (a "both slice 1 and slice 2" backend, i.e. GitHub or Jira today); the capability-less fallback test below overrides them to `undefined` instead of omitting them, since `Partial<TrackerBackend>` would otherwise still carry this factory's own defaults. */
function fakeBackend(overrides: Partial<TrackerBackend> = {}): TrackerBackend {
  return {
    id: 'github',
    capabilities: {
      comments: true,
      transitions: true,
      boards: false,
      sprints: false,
      labels: false,
      milestones: false,
      customFields: false,
    },
    listBindings: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(async (_binding, _externalId, fields) => fakeItem(fields)),
    listTransitions: vi.fn(),
    transition: vi.fn(),
    ...overrides,
  };
}

/**
 * {@link applyLiveTrackerCategoryMove} (issue #696) \u2014 the live half of a
 * board move, exercised directly against a fake `TrackerBackend` (no
 * relay, no node, no real GitHub/Jira shape) since the function itself is
 * provider-agnostic: it only ever calls the four `TrackerBackend` methods
 * by name. The relay-level proof that a REAL board move reaches a REAL
 * (stubbed-HTTP) backend through this exact function lives in
 * `node-daemon-tracker-live.test.ts`/`node-daemon-tracker-live-jira.test.ts`
 * instead \u2014 this file's job is the branchy category-diff logic itself,
 * which is far cheaper to cover exhaustively here than through a full wire
 * round trip per case.
 */
describe('applyLiveTrackerCategoryMove (issue #696)', () => {
  it('a plain field edit with no workflowCategory key at all skips the read entirely and forwards fields unchanged', async () => {
    const backend = fakeBackend();

    const item = await applyLiveTrackerCategoryMove(backend, fakeBinding(), '42', {
      title: 'New title',
    });

    expect(backend.get).not.toHaveBeenCalled();
    expect(backend.listTransitions).not.toHaveBeenCalled();
    expect(backend.transition).not.toHaveBeenCalled();
    expect(backend.update).toHaveBeenCalledWith(fakeBinding(), '42', { title: 'New title' });
    expect(item.fields.title).toBe('New title');
  });

  it('resubmitting the SAME category unchanged reads it, then still only calls update \u2014 never a same-category transition attempt', async () => {
    const backend = fakeBackend({
      get: vi.fn(async () => fakeItem({ workflowCategory: 'new' })),
    });

    await applyLiveTrackerCategoryMove(backend, fakeBinding(), '42', {
      title: 'x',
      workflowCategory: 'new',
    });

    expect(backend.get).toHaveBeenCalledWith(fakeBinding(), '42');
    expect(backend.listTransitions).not.toHaveBeenCalled();
    expect(backend.transition).not.toHaveBeenCalled();
    expect(backend.update).toHaveBeenCalledWith(fakeBinding(), '42', {
      title: 'x',
      workflowCategory: 'new',
    });
  });

  it('a genuine move to a reachable category transitions first, then updates with the stale workflowCategory/state/stateReason fields stripped', async () => {
    const backend = fakeBackend({
      get: vi.fn(async () => fakeItem({ workflowCategory: 'new' })),
      listTransitions: vi.fn(async (): Promise<TrackerTransition[]> => [
        { id: 't-noop', name: 'stay new', targetCategory: 'new' },
        { id: 't-done', name: 'close it', targetCategory: 'done' },
      ]),
    });

    const item = await applyLiveTrackerCategoryMove(backend, fakeBinding(), '42', {
      title: 'Ship it',
      workflowCategory: 'done',
      state: 'stale-open',
      stateReason: null,
    });

    expect(backend.listTransitions).toHaveBeenCalledWith(fakeBinding(), '42');
    expect(backend.transition).toHaveBeenCalledWith(fakeBinding(), '42', 't-done');
    expect(backend.update).toHaveBeenCalledWith(fakeBinding(), '42', { title: 'Ship it' });
    expect(item.fields.title).toBe('Ship it');
  });

  it('a move to a category no discovered transition reaches throws LiveTrackerCategoryMoveError and never calls transition or update', async () => {
    const backend = fakeBackend({
      get: vi.fn(async () => fakeItem({ workflowCategory: 'new' })),
      listTransitions: vi.fn(async (): Promise<TrackerTransition[]> => [
        { id: 't-noop', name: 'stay new', targetCategory: 'new' },
      ]),
    });

    const error = await applyLiveTrackerCategoryMove(backend, fakeBinding(), '42', {
      workflowCategory: 'done',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LiveTrackerCategoryMoveError);
    expect((error as Error).message).toContain('done');
    expect((error as Error).message).toContain('new');
    expect(backend.transition).not.toHaveBeenCalled();
    expect(backend.update).not.toHaveBeenCalled();
  });

  it('a move with zero discovered transitions at all (nothing available from the current status) says so rather than listing an empty set', async () => {
    const backend = fakeBackend({
      get: vi.fn(async () => fakeItem({ workflowCategory: 'done' })),
      listTransitions: vi.fn(async () => []),
    });

    const error = await applyLiveTrackerCategoryMove(backend, fakeBinding(), '42', {
      workflowCategory: 'new',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LiveTrackerCategoryMoveError);
    expect((error as Error).message).toMatch(/no transitions are available/i);
  });

  it('a backend missing listTransitions/transition (capability-less) falls back to a plain field patch, exactly as before this function existed', async () => {
    const backend = fakeBackend({ listTransitions: undefined, transition: undefined });

    const item = await applyLiveTrackerCategoryMove(backend, fakeBinding(), '42', {
      workflowCategory: 'done',
    });

    expect(backend.get).not.toHaveBeenCalled();
    expect(backend.update).toHaveBeenCalledWith(fakeBinding(), '42', { workflowCategory: 'done' });
    expect(item.fields.workflowCategory).toBe('done');
  });
});

const EVERY_RESOLUTION_ERROR: TrackerBackendResolutionError[] = [
  { kind: 'nativeMode' },
  { kind: 'accountNotConnected', connectionId: 'conn-1' },
  { kind: 'accountPinRequired', capability: 'github' },
  { kind: 'accountPinMalformed', capability: 'github', pinnedAccountId: 'bad-id' },
  { kind: 'accountPinDangling', capability: 'github', pinnedAccountId: 'gone' },
  {
    kind: 'accountHostMismatch',
    capability: 'github',
    pinnedAccountId: 'acct-1',
    expectedHost: 'github.com',
    actualHost: 'ghe.example.com',
  },
  { kind: 'accountAmbiguous', capability: 'github', candidateAccountIds: ['a', 'b'] },
  { kind: 'accountPinOptedOut', capability: 'github' },
  { kind: 'connectionPinMismatch', connectionId: 'conn-1', pinnedAccountId: 'conn-2' },
  { kind: 'credentialUnavailable', connectionId: 'conn-1' },
  { kind: 'credentialSourceUnsupported', connectionId: 'conn-1', credentialSource: 'oauth_3lo' },
];

describe('describeTrackerBackendResolutionError', () => {
  it('returns non-empty, kind-specific text for every resolution error kind', () => {
    const messages = EVERY_RESOLUTION_ERROR.map(describeTrackerBackendResolutionError);
    for (const message of messages) {
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
    // Every kind gets its own distinct wording \u2014 never one generic string
    // standing in for all eleven.
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('interpolates the specific capability/host/connectionId into the message, not just the kind', () => {
    expect(
      describeTrackerBackendResolutionError({
        kind: 'accountHostMismatch',
        capability: 'jira',
        pinnedAccountId: 'acct-1',
        expectedHost: 'a.atlassian.net',
        actualHost: 'b.atlassian.net',
      }),
    ).toContain('a.atlassian.net');
  });
});

describe('trackerBackendResolutionErrorToWireV1', () => {
  it('mirrors every node-side error field-for-field onto the wire union', () => {
    for (const error of EVERY_RESOLUTION_ERROR) {
      expect(trackerBackendResolutionErrorToWireV1(error)).toEqual(error);
    }
  });
});

describe('trackerResolutionErrorPayload', () => {
  it('combines the human message and the wire reason into one {outcome, message, reason} payload', () => {
    const error: TrackerBackendResolutionError = {
      kind: 'credentialUnavailable',
      connectionId: 'github:github.com:1',
    };
    expect(trackerResolutionErrorPayload(error)).toEqual({
      outcome: 'error',
      message: describeTrackerBackendResolutionError(error),
      reason: trackerBackendResolutionErrorToWireV1(error),
    });
  });
});
