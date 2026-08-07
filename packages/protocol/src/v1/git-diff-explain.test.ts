import { describe, expect, it } from 'vitest';
import {
  gitDiffExplainRequest,
  gitDiffExplainRequestPayloadV1,
  gitDiffExplainResponse,
  gitDiffExplainResponsePayloadV1,
  gitDiffExplainScopeV1,
  parseGitDiffExplainRequestPayloadV1,
  parseGitDiffExplainResponsePayloadV1,
  safeParseGitDiffExplainRequestPayloadV1,
  safeParseGitDiffExplainResponsePayloadV1,
} from './git-diff-explain';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('gitDiffExplainScopeV1', () => {
  it('accepts a file scope', () => {
    expect(gitDiffExplainScopeV1.safeParse({ kind: 'file', path: 'src/a.ts' }).success).toBe(true);
  });

  it.each(['staged', 'unstaged'] as const)('accepts a hunk scope on the %s side', (side) => {
    expect(
      gitDiffExplainScopeV1.safeParse({ kind: 'hunk', path: 'src/a.ts', side, hunkIndex: 0 })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(gitDiffExplainScopeV1.safeParse({ kind: 'line', path: 'src/a.ts' }).success).toBe(false);
  });

  it('rejects a hunk scope with an unknown side', () => {
    expect(
      gitDiffExplainScopeV1.safeParse({
        kind: 'hunk',
        path: 'src/a.ts',
        side: 'both',
        hunkIndex: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a hunk scope with a negative hunkIndex', () => {
    expect(
      gitDiffExplainScopeV1.safeParse({
        kind: 'hunk',
        path: 'src/a.ts',
        side: 'staged',
        hunkIndex: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects a file scope with an empty path', () => {
    expect(gitDiffExplainScopeV1.safeParse({ kind: 'file', path: '' }).success).toBe(false);
  });

  it('rejects a hunk scope missing hunkIndex', () => {
    expect(
      gitDiffExplainScopeV1.safeParse({ kind: 'hunk', path: 'src/a.ts', side: 'staged' }).success,
    ).toBe(false);
  });
});

describe('gitDiffExplainRequestPayloadV1', () => {
  it('accepts a scope-carrying payload', () => {
    expect(
      gitDiffExplainRequestPayloadV1.safeParse({ scope: { kind: 'file', path: 'a.ts' } }).success,
    ).toBe(true);
  });

  it('rejects a payload missing scope', () => {
    expect(gitDiffExplainRequestPayloadV1.safeParse({}).success).toBe(false);
  });

  it('parseGitDiffExplainRequestPayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitDiffExplainRequestPayloadV1({ scope: { kind: 'nope' } })).toThrow();
  });

  it('safeParseGitDiffExplainRequestPayloadV1 never throws on an invalid payload', () => {
    expect(safeParseGitDiffExplainRequestPayloadV1({ scope: { kind: 'nope' } }).success).toBe(
      false,
    );
  });
});

describe('gitDiffExplainResponsePayloadV1', () => {
  it('accepts the ok outcome with an explanation', () => {
    expect(
      gitDiffExplainResponsePayloadV1.safeParse({
        outcome: 'ok',
        explanation: 'This renames the widget helper and adds a null guard.',
      }).success,
    ).toBe(true);
  });

  it('accepts the error outcome', () => {
    expect(
      safeParseGitDiffExplainResponsePayloadV1({
        outcome: 'error',
        message: 'This session has no live agent to explain a diff with.',
      }).success,
    ).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(gitDiffExplainResponsePayloadV1.safeParse({ outcome: 'pending' }).success).toBe(false);
  });

  it('rejects an ok outcome missing explanation', () => {
    expect(gitDiffExplainResponsePayloadV1.safeParse({ outcome: 'ok' }).success).toBe(false);
  });

  it('parseGitDiffExplainResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitDiffExplainResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });
});

describe('gitDiffExplainRequest / gitDiffExplainResponse (the top-level wire messages)', () => {
  it('gitDiffExplainRequest requires an envelope, unlike gitDiffRequest/gitHunkDiffRequest', () => {
    expect(
      gitDiffExplainRequest.safeParse({
        type: 'git_diff_explain_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      gitDiffExplainRequest.safeParse({
        type: 'git_diff_explain_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('gitDiffExplainResponse requires an envelope', () => {
    expect(
      gitDiffExplainResponse.safeParse({
        type: 'git_diff_explain_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });
});
