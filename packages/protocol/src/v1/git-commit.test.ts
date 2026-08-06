import { describe, expect, it } from 'vitest';
import {
  gitCommitDraftRequest,
  gitCommitDraftResponse,
  gitCommitDraftResponsePayloadV1,
  gitCommitRequest,
  gitCommitRequestPayloadV1,
  gitCommitResponse,
  gitCommitResponsePayloadV1,
  parseGitCommitDraftResponsePayloadV1,
  parseGitCommitRequestPayloadV1,
  parseGitCommitResponsePayloadV1,
  safeParseGitCommitDraftResponsePayloadV1,
  safeParseGitCommitRequestPayloadV1,
  safeParseGitCommitResponsePayloadV1,
} from './git-commit';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('gitCommitDraftResponsePayloadV1', () => {
  it('accepts the ok outcome with a drafted message', () => {
    expect(
      gitCommitDraftResponsePayloadV1.safeParse({ outcome: 'ok', message: 'Add widget support' })
        .success,
    ).toBe(true);
  });

  it('accepts the error outcome', () => {
    expect(
      gitCommitDraftResponsePayloadV1.safeParse({
        outcome: 'error',
        message: 'Nothing staged to draft a commit message for.',
      }).success,
    ).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseGitCommitDraftResponsePayloadV1({ outcome: 'pending' }).success).toBe(false);
  });

  it('rejects an ok outcome missing message', () => {
    expect(gitCommitDraftResponsePayloadV1.safeParse({ outcome: 'ok' }).success).toBe(false);
  });

  it('parseGitCommitDraftResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitCommitDraftResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });
});

describe('gitCommitRequestPayloadV1', () => {
  it('accepts a non-empty message', () => {
    expect(gitCommitRequestPayloadV1.safeParse({ message: 'Add widget support' }).success).toBe(
      true,
    );
  });

  it('rejects an empty message', () => {
    expect(safeParseGitCommitRequestPayloadV1({ message: '' }).success).toBe(false);
  });

  it('rejects a missing message', () => {
    expect(gitCommitRequestPayloadV1.safeParse({}).success).toBe(false);
  });

  it('parseGitCommitRequestPayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitCommitRequestPayloadV1({ message: '' })).toThrow();
  });
});

describe('gitCommitResponsePayloadV1', () => {
  it('accepts the ok outcome with a sha', () => {
    expect(gitCommitResponsePayloadV1.safeParse({ outcome: 'ok', sha: 'deadbeef' }).success).toBe(
      true,
    );
  });

  it('accepts the error outcome', () => {
    expect(
      safeParseGitCommitResponsePayloadV1({
        outcome: 'error',
        message: 'nothing staged to commit',
      }).success,
    ).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(gitCommitResponsePayloadV1.safeParse({ outcome: 'pending' }).success).toBe(false);
  });

  it('rejects an ok outcome missing sha', () => {
    expect(gitCommitResponsePayloadV1.safeParse({ outcome: 'ok' }).success).toBe(false);
  });

  it('parseGitCommitResponsePayloadV1 throws on an invalid payload', () => {
    expect(() => parseGitCommitResponsePayloadV1({ outcome: 'nope' })).toThrow();
  });
});

describe('gitCommitDraftRequest / gitCommitDraftResponse (the top-level wire messages)', () => {
  it('gitCommitDraftRequest carries no envelope — asking carries no content', () => {
    const request = {
      type: 'git_commit_draft_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'sess-1',
      requestId: 'req-1',
    };
    expect(gitCommitDraftRequest.safeParse(request).success).toBe(true);
    expect('envelope' in request).toBe(false);
  });

  it('rejects a gitCommitDraftRequest missing requestId', () => {
    expect(
      gitCommitDraftRequest.safeParse({
        type: 'git_commit_draft_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
      }).success,
    ).toBe(false);
  });

  it('gitCommitDraftResponse requires an envelope', () => {
    expect(
      gitCommitDraftResponse.safeParse({
        type: 'git_commit_draft_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      gitCommitDraftResponse.safeParse({
        type: 'git_commit_draft_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });
});

describe('gitCommitRequest / gitCommitResponse (the top-level wire messages)', () => {
  it('gitCommitRequest requires an envelope, unlike gitCommitDraftRequest', () => {
    expect(
      gitCommitRequest.safeParse({
        type: 'git_commit_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      gitCommitRequest.safeParse({
        type: 'git_commit_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('gitCommitResponse requires an envelope', () => {
    expect(
      gitCommitResponse.safeParse({
        type: 'git_commit_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });
});
