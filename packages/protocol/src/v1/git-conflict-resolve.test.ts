import { describe, expect, it } from 'vitest';
import {
  gitConflictHunkOriginV1,
  gitConflictHunkV1,
  gitConflictResolutionHunkV1,
  gitConflictResolveRequest,
  gitConflictResolveRequestPayloadV1,
  gitConflictResolveResponse,
  gitConflictResolveResponsePayloadV1,
  parseGitConflictResolveRequestPayloadV1,
  parseGitConflictResolveResponsePayloadV1,
  safeParseGitConflictResolveRequestPayloadV1,
  safeParseGitConflictResolveResponsePayloadV1,
} from './git-conflict-resolve';

const envelope = {
  resourceId: 'res-1',
  iv: 'aXY=',
  ciphertext: 'Y2lwaGVy',
  alg: 'AES-256-GCM' as const,
};

describe('gitConflictHunkOriginV1 (issue #237)', () => {
  it.each(['ours', 'theirs', 'rewritten'] as const)('accepts %s', (origin) => {
    expect(gitConflictHunkOriginV1.safeParse(origin).success).toBe(true);
  });

  it('rejects an unknown origin (never a silent invented fourth state)', () => {
    expect(gitConflictHunkOriginV1.safeParse('combined').success).toBe(false);
  });
});

describe('gitConflictHunkV1', () => {
  it('accepts a real two-way hunk with baseText null', () => {
    expect(
      gitConflictHunkV1.safeParse({
        index: 0,
        oursLabel: 'HEAD',
        theirsLabel: 'feature',
        oursText: 'a\n',
        theirsText: 'b\n',
        baseText: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a diff3-style hunk with real baseText', () => {
    expect(
      gitConflictHunkV1.safeParse({
        index: 0,
        oursLabel: 'HEAD',
        theirsLabel: 'feature',
        oursText: 'a\n',
        theirsText: 'b\n',
        baseText: 'original\n',
      }).success,
    ).toBe(true);
  });

  it('rejects a negative index', () => {
    expect(
      gitConflictHunkV1.safeParse({
        index: -1,
        oursLabel: 'HEAD',
        theirsLabel: 'feature',
        oursText: 'a\n',
        theirsText: 'b\n',
        baseText: null,
      }).success,
    ).toBe(false);
  });
});

describe('gitConflictResolutionHunkV1', () => {
  it('accepts a resolution with a derived origin', () => {
    expect(
      gitConflictResolutionHunkV1.safeParse({ index: 0, origin: 'ours', resolvedText: 'a\n' })
        .success,
    ).toBe(true);
  });

  it('rejects a missing origin', () => {
    expect(gitConflictResolutionHunkV1.safeParse({ index: 0, resolvedText: 'a\n' }).success).toBe(
      false,
    );
  });
});

describe('gitConflictResolveRequestPayloadV1', () => {
  it('accepts a path-carrying payload', () => {
    expect(gitConflictResolveRequestPayloadV1.safeParse({ path: 'a.ts' }).success).toBe(true);
  });

  it('rejects an empty path', () => {
    expect(gitConflictResolveRequestPayloadV1.safeParse({ path: '' }).success).toBe(false);
  });

  it('rejects a payload missing path', () => {
    expect(gitConflictResolveRequestPayloadV1.safeParse({}).success).toBe(false);
  });

  it('parseGitConflictResolveRequestPayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitConflictResolveRequestPayloadV1({})).toThrow();
  });

  it('safeParseGitConflictResolveRequestPayloadV1 never throws', () => {
    expect(safeParseGitConflictResolveRequestPayloadV1({}).success).toBe(false);
  });
});

describe('gitConflictResolveResponsePayloadV1', () => {
  const hunk = {
    index: 0,
    oursLabel: 'HEAD',
    theirsLabel: 'feature',
    oursText: 'a\n',
    theirsText: 'b\n',
    baseText: null,
  };

  it('accepts a real ok outcome', () => {
    expect(
      gitConflictResolveResponsePayloadV1.safeParse({
        outcome: 'ok',
        path: 'a.ts',
        baseHash: 'deadbeef',
        hunks: [hunk],
        resolution: [{ index: 0, origin: 'rewritten', resolvedText: 'merged\n' }],
        resolvedContent: 'merged\n',
      }).success,
    ).toBe(true);
  });

  it('rejects an ok outcome missing baseHash (the exact field a client needs to apply via fs_write_request)', () => {
    expect(
      gitConflictResolveResponsePayloadV1.safeParse({
        outcome: 'ok',
        path: 'a.ts',
        hunks: [hunk],
        resolution: [],
        resolvedContent: '',
      }).success,
    ).toBe(false);
  });

  it('accepts a too_large outcome carrying real counts', () => {
    expect(
      gitConflictResolveResponsePayloadV1.safeParse({
        outcome: 'too_large',
        path: 'huge.ts',
        message: 'too many hunks',
        hunkCount: 20,
        maxHunks: 12,
      }).success,
    ).toBe(true);
  });

  it('accepts an error outcome', () => {
    expect(
      gitConflictResolveResponsePayloadV1.safeParse({
        outcome: 'error',
        path: 'a.ts',
        message: 'no live agent',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown outcome', () => {
    expect(
      gitConflictResolveResponsePayloadV1.safeParse({ outcome: 'pending', path: 'a.ts' }).success,
    ).toBe(false);
  });

  it('parseGitConflictResolveResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitConflictResolveResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });

  it('safeParseGitConflictResolveResponsePayloadV1 never throws', () => {
    expect(safeParseGitConflictResolveResponsePayloadV1({ outcome: 'nope' }).success).toBe(false);
  });
});

describe('gitConflictResolveRequest / gitConflictResolveResponse wire shape', () => {
  it('gitConflictResolveRequest requires an envelope (path is real session content)', () => {
    expect(
      gitConflictResolveRequest.safeParse({
        type: 'git_conflict_resolve_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      gitConflictResolveRequest.safeParse({
        type: 'git_conflict_resolve_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('gitConflictResolveResponse requires an envelope', () => {
    expect(
      gitConflictResolveResponse.safeParse({
        type: 'git_conflict_resolve_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });
});
