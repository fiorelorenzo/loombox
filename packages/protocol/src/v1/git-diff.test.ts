import { describe, expect, it } from 'vitest';
import {
  gitDiffFileV1,
  gitDiffRequest,
  gitDiffResponse,
  gitDiffResponsePayloadV1,
  parseGitDiffResponsePayloadV1,
  safeParseGitDiffResponsePayloadV1,
} from './git-diff';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('gitDiffFileV1', () => {
  it('accepts a modified file (non-null oldText, previousPath null)', () => {
    const result = gitDiffFileV1.safeParse({
      path: 'src/foo.ts',
      previousPath: null,
      status: 'modified',
      oldText: 'old\n',
      newText: 'new\n',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a new/untracked file (null oldText)', () => {
    expect(
      gitDiffFileV1.safeParse({
        path: 'src/new.ts',
        previousPath: null,
        status: 'added',
        oldText: null,
        newText: 'hello\n',
      }).success,
    ).toBe(true);
  });

  it('accepts a deleted file (empty newText)', () => {
    expect(
      gitDiffFileV1.safeParse({
        path: 'src/gone.ts',
        previousPath: null,
        status: 'deleted',
        oldText: 'bye\n',
        newText: '',
      }).success,
    ).toBe(true);
  });

  it('accepts a renamed file carrying a previousPath', () => {
    expect(
      gitDiffFileV1.safeParse({
        path: 'src/renamed.ts',
        previousPath: 'src/original.ts',
        status: 'renamed',
        oldText: 'content\n',
        newText: 'content\n',
      }).success,
    ).toBe(true);
  });

  it('accepts a binary change collapsed to the structural-only shape (oldText null, newText empty)', () => {
    expect(
      gitDiffFileV1.safeParse({
        path: 'assets/logo.png',
        previousPath: null,
        status: 'modified',
        oldText: null,
        newText: '',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty path', () => {
    expect(
      gitDiffFileV1.safeParse({
        path: '',
        previousPath: null,
        status: 'modified',
        oldText: '',
        newText: '',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(
      gitDiffFileV1.safeParse({
        path: 'a.ts',
        previousPath: null,
        status: 'copied',
        oldText: '',
        newText: '',
      }).success,
    ).toBe(false);
  });
});

describe('gitDiffResponsePayloadV1', () => {
  it('accepts the ok outcome with an empty file list (a clean worktree, never an error)', () => {
    const result = gitDiffResponsePayloadV1.safeParse({ outcome: 'ok', files: [] });
    expect(result.success).toBe(true);
  });

  it('accepts the ok outcome with a file list', () => {
    const result = gitDiffResponsePayloadV1.safeParse({
      outcome: 'ok',
      files: [
        {
          path: 'a.ts',
          previousPath: null,
          status: 'modified',
          oldText: 'a\n',
          newText: 'b\n',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts the error outcome', () => {
    const result = gitDiffResponsePayloadV1.safeParse({
      outcome: 'error',
      message: 'git is not available on this target',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseGitDiffResponsePayloadV1({ outcome: 'pending' }).success).toBe(false);
  });

  it('parseGitDiffResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitDiffResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });
});

describe('gitDiffRequest / gitDiffResponse (the top-level wire messages)', () => {
  it('gitDiffRequest carries only clear routing metadata — no envelope, no path filter', () => {
    const message = {
      type: 'git_diff_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      requestId: 'req-1',
    };
    const result = gitDiffRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
    );
  });

  it('rejects a request missing requestId/sessionId', () => {
    expect(
      gitDiffRequest.safeParse({
        type: 'git_diff_request',
        protocolVersion: 1,
        sessionId: '',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('gitDiffResponse carries only sessionId/requestId plus the opaque envelope', () => {
    const result = gitDiffResponse.safeParse({
      type: 'git_diff_response',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
    });
    expect(result.success).toBe(true);
  });
});
