import { describe, expect, it } from 'vitest';
import {
  sessionArchiveRequest,
  sessionArchiveResponse,
  sessionArchiveResult,
  sessionForkRequest,
  sessionForkResponse,
  sessionForkResult,
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

const validEnvelope = {
  resourceId: 'session:sess_new',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

describe('sessionForkRequest', () => {
  it('accepts the shape session_create shares, plus sourceSessionId', () => {
    const result = sessionForkRequest.safeParse({
      type: 'session_fork_request',
      protocolVersion: 1,
      requestId: 'req_1',
      sessionId: 'sess_new',
      sourceSessionId: 'sess_1',
      targetId: 'local',
      provider: 'claude',
      privateEnvelope: validEnvelope,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty requestId, sessionId, or sourceSessionId', () => {
    const base = {
      type: 'session_fork_request' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      sessionId: 'sess_new',
      sourceSessionId: 'sess_1',
      targetId: 'local',
      provider: 'claude',
      privateEnvelope: validEnvelope,
    };
    expect(sessionForkRequest.safeParse({ ...base, requestId: '' }).success).toBe(false);
    expect(sessionForkRequest.safeParse({ ...base, sessionId: '' }).success).toBe(false);
    expect(sessionForkRequest.safeParse({ ...base, sourceSessionId: '' }).success).toBe(false);
  });

  it('rejects a request missing its private envelope — a fork always carries title/projectPath/forkFromTurnId', () => {
    const { privateEnvelope: _drop, ...withoutEnvelope } = {
      type: 'session_fork_request' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      sessionId: 'sess_new',
      sourceSessionId: 'sess_1',
      targetId: 'local',
      provider: 'claude',
      privateEnvelope: validEnvelope,
    };
    expect(sessionForkRequest.safeParse(withoutEnvelope).success).toBe(false);
  });

  it('safeParse never throws on garbage input', () => {
    expect(sessionForkRequest.safeParse(null).success).toBe(false);
    expect(sessionForkRequest.safeParse({}).success).toBe(false);
  });
});

describe('sessionForkResult', () => {
  it('parses the ok outcome', () => {
    expect(sessionForkResult.safeParse({ outcome: 'ok' }).success).toBe(true);
  });

  it('parses the error outcome with a message', () => {
    const result = sessionForkResult.safeParse({
      outcome: 'error',
      message: 'no active agent for the source session',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an error outcome without a usable message', () => {
    expect(sessionForkResult.safeParse({ outcome: 'error', message: '' }).success).toBe(false);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(sessionForkResult.safeParse({ outcome: 'pending' }).success).toBe(false);
  });
});

describe('sessionForkResponse (the top-level wire message)', () => {
  it('carries requestId/sessionId plus the discriminated ok result, and nothing else', () => {
    const message = {
      type: 'session_fork_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      sessionId: 'sess_new',
      result: { outcome: 'ok' as const },
    };
    const result = sessionForkResponse.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['protocolVersion', 'requestId', 'result', 'sessionId', 'type'].sort(),
    );
  });

  it('carries the error result with its message', () => {
    const result = sessionForkResponse.safeParse({
      type: 'session_fork_response',
      protocolVersion: 1,
      requestId: 'req_1',
      sessionId: 'sess_new',
      result: { outcome: 'error', message: 'turn "turn_9" not found in the source transcript' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a response missing requestId, sessionId, or result', () => {
    expect(
      sessionForkResponse.safeParse({
        type: 'session_fork_response',
        protocolVersion: 1,
        sessionId: 'sess_new',
        result: { outcome: 'ok' },
      }).success,
    ).toBe(false);
    expect(
      sessionForkResponse.safeParse({
        type: 'session_fork_response',
        protocolVersion: 1,
        requestId: 'req_1',
        result: { outcome: 'ok' },
      }).success,
    ).toBe(false);
    expect(
      sessionForkResponse.safeParse({
        type: 'session_fork_response',
        protocolVersion: 1,
        requestId: 'req_1',
        sessionId: 'sess_new',
      }).success,
    ).toBe(false);
  });

  it('safeParse never throws on garbage input', () => {
    expect(sessionForkResponse.safeParse(null).success).toBe(false);
    expect(sessionForkResponse.safeParse('nope').success).toBe(false);
  });
});
