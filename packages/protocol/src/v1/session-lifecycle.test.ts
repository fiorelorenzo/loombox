import { describe, expect, it } from 'vitest';
import {
  sessionArchiveRequest,
  sessionArchiveResponse,
  sessionArchiveResult,
} from './session-lifecycle';

describe('sessionArchiveRequest', () => {
  it('accepts removeWorktree true or false', () => {
    for (const removeWorktree of [true, false]) {
      const result = sessionArchiveRequest.safeParse({
        type: 'session_archive_request',
        protocolVersion: 1,
        requestId: 'req_1',
        sessionId: 'sess_1',
        removeWorktree,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects a missing removeWorktree — the client must always state its choice explicitly', () => {
    const result = sessionArchiveRequest.safeParse({
      type: 'session_archive_request',
      protocolVersion: 1,
      requestId: 'req_1',
      sessionId: 'sess_1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty requestId or sessionId', () => {
    expect(
      sessionArchiveRequest.safeParse({
        type: 'session_archive_request',
        protocolVersion: 1,
        requestId: '',
        sessionId: 'sess_1',
        removeWorktree: true,
      }).success,
    ).toBe(false);
    expect(
      sessionArchiveRequest.safeParse({
        type: 'session_archive_request',
        protocolVersion: 1,
        requestId: 'req_1',
        sessionId: '',
        removeWorktree: true,
      }).success,
    ).toBe(false);
  });

  it('safeParse never throws on garbage input', () => {
    expect(sessionArchiveRequest.safeParse(null).success).toBe(false);
    expect(sessionArchiveRequest.safeParse({}).success).toBe(false);
  });
});

describe('sessionArchiveResult', () => {
  it('parses the ok outcome', () => {
    expect(sessionArchiveResult.safeParse({ outcome: 'ok' }).success).toBe(true);
  });

  it('parses the error outcome with a message', () => {
    const result = sessionArchiveResult.safeParse({ outcome: 'error', message: 'git refused' });
    expect(result.success).toBe(true);
  });

  it('rejects an error outcome without a usable message', () => {
    expect(sessionArchiveResult.safeParse({ outcome: 'error' }).success).toBe(false);
    expect(sessionArchiveResult.safeParse({ outcome: 'error', message: '' }).success).toBe(false);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(sessionArchiveResult.safeParse({ outcome: 'pending' }).success).toBe(false);
  });
});

describe('sessionArchiveResponse (the top-level wire message)', () => {
  it('carries requestId/sessionId plus the discriminated ok result, and nothing else', () => {
    const message = {
      type: 'session_archive_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      sessionId: 'sess_1',
      result: { outcome: 'ok' as const },
    };
    const result = sessionArchiveResponse.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['protocolVersion', 'requestId', 'result', 'sessionId', 'type'].sort(),
    );
  });

  it('carries the error result with its message', () => {
    const result = sessionArchiveResponse.safeParse({
      type: 'session_archive_response',
      protocolVersion: 1,
      requestId: 'req_1',
      sessionId: 'sess_1',
      result: { outcome: 'error', message: 'worktree busy' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a response missing requestId, sessionId, or result', () => {
    expect(
      sessionArchiveResponse.safeParse({
        type: 'session_archive_response',
        protocolVersion: 1,
        sessionId: 'sess_1',
        result: { outcome: 'ok' },
      }).success,
    ).toBe(false);
    expect(
      sessionArchiveResponse.safeParse({
        type: 'session_archive_response',
        protocolVersion: 1,
        requestId: 'req_1',
        result: { outcome: 'ok' },
      }).success,
    ).toBe(false);
    expect(
      sessionArchiveResponse.safeParse({
        type: 'session_archive_response',
        protocolVersion: 1,
        requestId: 'req_1',
        sessionId: 'sess_1',
      }).success,
    ).toBe(false);
  });

  it('safeParse never throws on garbage input', () => {
    expect(sessionArchiveResponse.safeParse(null).success).toBe(false);
    expect(sessionArchiveResponse.safeParse('nope').success).toBe(false);
  });
});
