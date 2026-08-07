import { describe, expect, it } from 'vitest';
import {
  gitGraphCommitV1,
  gitGraphRequest,
  gitGraphResponse,
  gitGraphResponsePayloadV1,
  parseGitGraphRequestPayloadV1,
  parseGitGraphResponsePayloadV1,
  safeParseGitGraphRequestPayloadV1,
  safeParseGitGraphResponsePayloadV1,
} from './git-graph';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('gitGraphCommitV1', () => {
  it('accepts a root commit (no parents, no refs, not HEAD)', () => {
    expect(
      gitGraphCommitV1.safeParse({
        sha: 'a'.repeat(40),
        parents: [],
        authorName: 'loombox test',
        authorEmail: 'test@loombox.dev',
        authorDateIso: '2026-01-01T00:00:00Z',
        subject: 'root commit',
        refs: [],
        isHead: false,
      }).success,
    ).toBe(true);
  });

  it('accepts a merge commit (2+ parents) decorated with a branch and a tag', () => {
    expect(
      gitGraphCommitV1.safeParse({
        sha: 'b'.repeat(40),
        parents: ['c'.repeat(40), 'd'.repeat(40)],
        authorName: 'loombox test',
        authorEmail: 'test@loombox.dev',
        authorDateIso: '2026-01-02T00:00:00Z',
        subject: 'merge feature into main',
        refs: [
          { name: 'main', kind: 'branch' },
          { name: 'v1.0', kind: 'tag' },
        ],
        isHead: true,
      }).success,
    ).toBe(true);
  });

  it('accepts a remoteBranch ref', () => {
    expect(
      gitGraphCommitV1.safeParse({
        sha: 'e'.repeat(40),
        parents: [],
        authorName: 'loombox test',
        authorEmail: 'test@loombox.dev',
        authorDateIso: '2026-01-01T00:00:00Z',
        subject: 'x',
        refs: [{ name: 'origin/main', kind: 'remoteBranch' }],
        isHead: false,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty sha', () => {
    expect(
      gitGraphCommitV1.safeParse({
        sha: '',
        parents: [],
        authorName: '',
        authorEmail: '',
        authorDateIso: '2026-01-01T00:00:00Z',
        subject: '',
        refs: [],
        isHead: false,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown ref kind', () => {
    expect(
      gitGraphCommitV1.safeParse({
        sha: 'a'.repeat(40),
        parents: [],
        authorName: '',
        authorEmail: '',
        authorDateIso: '2026-01-01T00:00:00Z',
        subject: '',
        refs: [{ name: 'main', kind: 'branch-ish' }],
        isHead: false,
      }).success,
    ).toBe(false);
  });
});

describe('gitGraphRequestPayloadV1', () => {
  it('accepts an empty payload — every field is optional, defaulted node-side', () => {
    expect(safeParseGitGraphRequestPayloadV1({}).success).toBe(true);
  });

  it('accepts an explicit ref/limit/offset', () => {
    expect(
      safeParseGitGraphRequestPayloadV1({ ref: 'feature', limit: 25, offset: 50 }).success,
    ).toBe(true);
  });

  it('rejects a limit above GIT_GRAPH_MAX_LIMIT', () => {
    expect(safeParseGitGraphRequestPayloadV1({ limit: 500 }).success).toBe(false);
  });

  it('rejects a negative offset', () => {
    expect(safeParseGitGraphRequestPayloadV1({ offset: -1 }).success).toBe(false);
  });

  it('rejects an empty ref string', () => {
    expect(safeParseGitGraphRequestPayloadV1({ ref: '' }).success).toBe(false);
  });

  it('parseGitGraphRequestPayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitGraphRequestPayloadV1({ limit: -1 })).toThrow();
  });
});

describe('gitGraphResponsePayloadV1', () => {
  it('accepts the ok outcome with an empty commit list and a null nextOffset (an unborn HEAD)', () => {
    expect(
      gitGraphResponsePayloadV1.safeParse({ outcome: 'ok', commits: [], nextOffset: null }).success,
    ).toBe(true);
  });

  it('accepts the ok outcome with commits and a numeric nextOffset (more pages remain)', () => {
    expect(
      gitGraphResponsePayloadV1.safeParse({
        outcome: 'ok',
        commits: [
          {
            sha: 'a'.repeat(40),
            parents: [],
            authorName: 'loombox test',
            authorEmail: 'test@loombox.dev',
            authorDateIso: '2026-01-01T00:00:00Z',
            subject: 'x',
            refs: [],
            isHead: false,
          },
        ],
        nextOffset: 50,
      }).success,
    ).toBe(true);
  });

  it('accepts the error outcome', () => {
    expect(
      gitGraphResponsePayloadV1.safeParse({ outcome: 'error', message: 'no such ref' }).success,
    ).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseGitGraphResponsePayloadV1({ outcome: 'pending' }).success).toBe(false);
  });

  it('parseGitGraphResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitGraphResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });
});

describe('gitGraphRequest / gitGraphResponse (the top-level wire messages)', () => {
  it('gitGraphRequest accepts a fully-formed enveloped request', () => {
    expect(
      gitGraphRequest.safeParse({
        type: 'git_graph_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });

  it('gitGraphRequest rejects a missing envelope — unlike git_diff_request, this pair always carries one', () => {
    expect(
      gitGraphRequest.safeParse({
        type: 'git_graph_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('gitGraphResponse accepts a fully-formed enveloped response', () => {
    expect(
      gitGraphResponse.safeParse({
        type: 'git_graph_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });

  it('rejects the wrong literal type on either message', () => {
    expect(
      gitGraphRequest.safeParse({
        type: 'git_diff_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(false);
    expect(
      gitGraphResponse.safeParse({
        type: 'git_diff_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(false);
  });
});
