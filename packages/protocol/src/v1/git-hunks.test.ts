import { describe, expect, it } from 'vitest';
import {
  gitHunkActionRequest,
  gitHunkActionRequestPayloadV1,
  gitHunkActionResponse,
  gitHunkActionResponsePayloadV1,
  gitHunkDiffRequest,
  gitHunkDiffResponse,
  gitHunkDiffResponsePayloadV1,
  gitHunkFileV1,
  gitHunkV1,
  parseGitHunkActionRequestPayloadV1,
  parseGitHunkActionResponsePayloadV1,
  parseGitHunkDiffResponsePayloadV1,
  safeParseGitHunkActionRequestPayloadV1,
  safeParseGitHunkActionResponsePayloadV1,
  safeParseGitHunkDiffResponsePayloadV1,
} from './git-hunks';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

function modifiedHunk(): unknown {
  return {
    header: '@@ -2,7 +2,7 @@ line1',
    oldStart: 2,
    oldLines: 7,
    newStart: 2,
    newLines: 7,
    lines: [
      { kind: 'context', text: 'line2' },
      { kind: 'removed', text: 'line5' },
      { kind: 'added', text: 'line5-CHANGED' },
      { kind: 'context', text: 'line6' },
    ],
  };
}

describe('gitHunkV1', () => {
  it('accepts a well-formed hunk', () => {
    expect(gitHunkV1.safeParse(modifiedHunk()).success).toBe(true);
  });

  it('accepts a synthetic whole-new-file hunk (oldStart/oldLines both 0)', () => {
    expect(
      gitHunkV1.safeParse({
        header: '@@ -0,0 +1,3 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: 'added', text: 'a' },
          { kind: 'added', text: 'b' },
          { kind: 'added', text: 'c' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown line kind', () => {
    expect(
      gitHunkV1.safeParse({
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ kind: 'moved', text: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a negative line number', () => {
    expect(
      gitHunkV1.safeParse({
        header: '@@ -1,1 +1,1 @@',
        oldStart: -1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [],
      }).success,
    ).toBe(false);
  });
});

describe('gitHunkFileV1', () => {
  it('accepts a partially staged file (hunks on both sides)', () => {
    expect(
      gitHunkFileV1.safeParse({
        path: 'src/foo.ts',
        previousPath: null,
        status: 'modified',
        staged: [modifiedHunk()],
        unstaged: [modifiedHunk()],
      }).success,
    ).toBe(true);
  });

  it('accepts a fully unstaged file (staged empty)', () => {
    expect(
      gitHunkFileV1.safeParse({
        path: 'src/foo.ts',
        previousPath: null,
        status: 'modified',
        staged: [],
        unstaged: [modifiedHunk()],
      }).success,
    ).toBe(true);
  });

  it('accepts a renamed file carrying a previousPath', () => {
    expect(
      gitHunkFileV1.safeParse({
        path: 'new.ts',
        previousPath: 'old.ts',
        status: 'renamed',
        staged: [],
        unstaged: [],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty path', () => {
    expect(
      gitHunkFileV1.safeParse({
        path: '',
        previousPath: null,
        status: 'modified',
        staged: [],
        unstaged: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(
      gitHunkFileV1.safeParse({
        path: 'x.ts',
        previousPath: null,
        status: 'conflicted',
        staged: [],
        unstaged: [],
      }).success,
    ).toBe(false);
  });
});

describe('gitHunkDiffResponsePayloadV1', () => {
  it('accepts the ok outcome with an empty file list', () => {
    expect(gitHunkDiffResponsePayloadV1.safeParse({ outcome: 'ok', files: [] }).success).toBe(true);
  });

  it('accepts the ok outcome with a file list', () => {
    expect(
      gitHunkDiffResponsePayloadV1.safeParse({
        outcome: 'ok',
        files: [
          {
            path: 'a.ts',
            previousPath: null,
            status: 'modified',
            staged: [modifiedHunk()],
            unstaged: [],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts the error outcome', () => {
    expect(
      gitHunkDiffResponsePayloadV1.safeParse({ outcome: 'error', message: 'not a repo' }).success,
    ).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseGitHunkDiffResponsePayloadV1({ outcome: 'pending' }).success).toBe(false);
  });

  it('parseGitHunkDiffResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitHunkDiffResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });
});

describe('gitHunkActionRequestPayloadV1', () => {
  it.each(['stage', 'unstage', 'discard'] as const)('accepts action %s', (action) => {
    expect(
      gitHunkActionRequestPayloadV1.safeParse({ path: 'a.ts', hunkIndex: 0, action }).success,
    ).toBe(true);
  });

  it('rejects an unknown action', () => {
    expect(
      safeParseGitHunkActionRequestPayloadV1({ path: 'a.ts', hunkIndex: 0, action: 'commit' })
        .success,
    ).toBe(false);
  });

  it('rejects a negative hunkIndex', () => {
    expect(
      gitHunkActionRequestPayloadV1.safeParse({ path: 'a.ts', hunkIndex: -1, action: 'stage' })
        .success,
    ).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(
      gitHunkActionRequestPayloadV1.safeParse({ path: '', hunkIndex: 0, action: 'stage' }).success,
    ).toBe(false);
  });

  it('parseGitHunkActionRequestPayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitHunkActionRequestPayloadV1({ action: 'nope' })).toThrow();
  });
});

describe('gitHunkActionResponsePayloadV1', () => {
  it('accepts the ok outcome', () => {
    expect(gitHunkActionResponsePayloadV1.safeParse({ outcome: 'ok' }).success).toBe(true);
  });

  it('accepts the error outcome', () => {
    expect(
      safeParseGitHunkActionResponsePayloadV1({ outcome: 'error', message: 'stale hunkIndex' })
        .success,
    ).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(gitHunkActionResponsePayloadV1.safeParse({ outcome: 'pending' }).success).toBe(false);
  });

  it('parseGitHunkActionResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitHunkActionResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });
});

describe('gitHunkDiffRequest / gitHunkDiffResponse (the top-level wire messages)', () => {
  it('gitHunkDiffRequest carries no envelope — asking carries no content', () => {
    const request = {
      type: 'git_hunk_diff_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'sess-1',
      requestId: 'req-1',
    };
    expect(gitHunkDiffRequest.safeParse(request).success).toBe(true);
    expect('envelope' in request).toBe(false);
  });

  it('rejects a gitHunkDiffRequest missing requestId', () => {
    expect(
      gitHunkDiffRequest.safeParse({
        type: 'git_hunk_diff_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
      }).success,
    ).toBe(false);
  });

  it('gitHunkDiffResponse requires an envelope', () => {
    expect(
      gitHunkDiffResponse.safeParse({
        type: 'git_hunk_diff_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });
});

describe('gitHunkActionRequest / gitHunkActionResponse (the top-level wire messages)', () => {
  it('gitHunkActionRequest requires an envelope, unlike gitHunkDiffRequest', () => {
    expect(
      gitHunkActionRequest.safeParse({
        type: 'git_hunk_action_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      gitHunkActionRequest.safeParse({
        type: 'git_hunk_action_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('gitHunkActionResponse requires an envelope', () => {
    expect(
      gitHunkActionResponse.safeParse({
        type: 'git_hunk_action_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });
});
