import { describe, expect, it } from 'vitest';
import type { TrackerItemLive } from '@loombox/shared';

import type { TrackerBackendResolutionError } from './tracker-backend-composition';
import {
  describeTrackerBackendResolutionError,
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
