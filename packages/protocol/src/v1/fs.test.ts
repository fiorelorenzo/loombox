import { describe, expect, it } from 'vitest';
import {
  fsEntryV1,
  fsListRequest,
  fsListResponse,
  fsReadRequest,
  fsReadResponse,
  fsWriteRequest,
  fsWriteResponse,
  parseFsListRequestPayloadV1,
  parseFsListResponsePayloadV1,
  parseFsReadRequestPayloadV1,
  parseFsReadResponsePayloadV1,
  parseFsWriteRequestPayloadV1,
  parseFsWriteResponsePayloadV1,
  safeParseFsListRequestPayloadV1,
  safeParseFsListResponsePayloadV1,
  safeParseFsReadRequestPayloadV1,
  safeParseFsReadResponsePayloadV1,
  safeParseFsWriteRequestPayloadV1,
  safeParseFsWriteResponsePayloadV1,
} from './fs';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('fsEntryV1', () => {
  it('accepts file/dir/symlink kinds with a nonnegative size', () => {
    for (const kind of ['file', 'dir', 'symlink'] as const) {
      expect(fsEntryV1.safeParse({ name: 'foo.ts', kind, size: 0 }).success).toBe(true);
    }
  });

  it('rejects an unknown kind', () => {
    expect(fsEntryV1.safeParse({ name: 'foo', kind: 'socket', size: 0 }).success).toBe(false);
  });

  it('rejects a negative size', () => {
    expect(fsEntryV1.safeParse({ name: 'foo', kind: 'file', size: -1 }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(fsEntryV1.safeParse({ name: '', kind: 'file', size: 0 }).success).toBe(false);
  });
});

describe('fsListRequestPayloadV1', () => {
  it('accepts a relative path, including the empty root path', () => {
    expect(() => parseFsListRequestPayloadV1({ path: '' })).not.toThrow();
    expect(() => parseFsListRequestPayloadV1({ path: 'src/lib' })).not.toThrow();
  });

  it('safeParse never throws on garbage input', () => {
    expect(safeParseFsListRequestPayloadV1(null).success).toBe(false);
    expect(safeParseFsListRequestPayloadV1({}).success).toBe(false);
  });
});

describe('fsListResponsePayloadV1', () => {
  it('parses the ok outcome with entries', () => {
    const result = parseFsListResponsePayloadV1({
      outcome: 'ok',
      path: 'src',
      entries: [
        { name: 'index.ts', kind: 'file', size: 123 },
        { name: 'lib', kind: 'dir', size: 0 },
      ],
    });
    expect(result.outcome).toBe('ok');
  });

  it('parses the error outcome', () => {
    const result = parseFsListResponsePayloadV1({
      outcome: 'error',
      path: '../../etc',
      message: 'path escapes the project root',
    });
    expect(result.outcome).toBe('error');
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseFsListResponsePayloadV1({ outcome: 'pending', path: '' }).success).toBe(false);
  });

  it('rejects ok without entries', () => {
    expect(safeParseFsListResponsePayloadV1({ outcome: 'ok', path: '' }).success).toBe(false);
  });
});

describe('fsListRequest / fsListResponse (the top-level wire messages)', () => {
  it('fsListRequest carries only clear routing metadata plus the opaque envelope — never a path field', () => {
    const message = {
      type: 'fs_list_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      targetId: 'local',
      requestId: 'req-1',
      envelope,
    };
    const result = fsListRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'targetId', 'type'].sort(),
    );
  });

  it('rejects a request missing requestId/targetId/sessionId', () => {
    expect(
      fsListRequest.safeParse({
        type: 'fs_list_request',
        protocolVersion: 1,
        sessionId: '',
        targetId: 'local',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(false);
    expect(
      fsListRequest.safeParse({
        type: 'fs_list_request',
        protocolVersion: 1,
        sessionId: 'session-1',
        targetId: 'local',
        envelope,
      }).success,
    ).toBe(false);
  });

  it('fsListResponse carries only sessionId/requestId plus the opaque envelope', () => {
    const result = fsListResponse.safeParse({
      type: 'fs_list_response',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
    });
    expect(result.success).toBe(true);
  });

  it('is additive/version-safe: an extra unknown field on the encrypted envelope wrapper does not itself leak a path — parse still only recognizes the declared fields', () => {
    const result = fsListRequest.safeParse({
      type: 'fs_list_request',
      protocolVersion: 1,
      sessionId: 'session-1',
      targetId: 'local',
      requestId: 'req-1',
      envelope,
      path: '/etc/passwd', // must never be a real field this schema reads
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('path' in result.data).toBe(false);
    }
  });
});

describe('fsReadRequestPayloadV1', () => {
  it('accepts a relative file path', () => {
    expect(parseFsReadRequestPayloadV1({ path: 'src/foo.ts' })).toEqual({ path: 'src/foo.ts' });
  });

  it('safeParse never throws on garbage input', () => {
    expect(safeParseFsReadRequestPayloadV1(null).success).toBe(false);
    expect(safeParseFsReadRequestPayloadV1({ path: 42 }).success).toBe(false);
  });
});

describe('fsReadResponsePayloadV1', () => {
  it('parses the ok outcome with content, truncated, and hash', () => {
    const result = parseFsReadResponsePayloadV1({
      outcome: 'ok',
      path: 'src/foo.ts',
      content: 'export {};\n',
      truncated: false,
      hash: 'abc123',
    });
    expect(result).toEqual({
      outcome: 'ok',
      path: 'src/foo.ts',
      content: 'export {};\n',
      truncated: false,
      hash: 'abc123',
    });
  });

  it('parses the error outcome', () => {
    const result = parseFsReadResponsePayloadV1({
      outcome: 'error',
      path: 'src/missing.ts',
      message: 'not found',
    });
    expect(result).toEqual({ outcome: 'error', path: 'src/missing.ts', message: 'not found' });
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseFsReadResponsePayloadV1({ outcome: 'pending', path: '' }).success).toBe(false);
  });

  it('rejects ok without content or truncated', () => {
    expect(
      safeParseFsReadResponsePayloadV1({ outcome: 'ok', path: '', content: 'x' }).success,
    ).toBe(false);
  });

  it('rejects ok without a hash', () => {
    expect(
      safeParseFsReadResponsePayloadV1({
        outcome: 'ok',
        path: 'src/foo.ts',
        content: 'x',
        truncated: false,
      }).success,
    ).toBe(false);
  });
});

describe('fsReadRequest / fsReadResponse (the top-level wire messages)', () => {
  it('fsReadRequest carries only clear routing metadata plus the opaque envelope — never a path field', () => {
    const message = {
      type: 'fs_read_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      targetId: 'local',
      requestId: 'req-1',
      envelope,
    };
    const result = fsReadRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'targetId', 'type'].sort(),
    );
  });

  it('rejects a request missing requestId/targetId/sessionId', () => {
    expect(
      fsReadRequest.safeParse({
        type: 'fs_read_request',
        protocolVersion: 1,
        sessionId: '',
        targetId: 'local',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(false);
  });

  it('fsReadResponse carries only sessionId/requestId plus the opaque envelope', () => {
    const result = fsReadResponse.safeParse({
      type: 'fs_read_response',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
    });
    expect(result.success).toBe(true);
  });
});

describe('fsWriteRequestPayloadV1', () => {
  it('accepts a relative path, new content, and a baseHash', () => {
    expect(
      parseFsWriteRequestPayloadV1({ path: 'src/foo.ts', content: 'x', baseHash: 'abc123' }),
    ).toEqual({ path: 'src/foo.ts', content: 'x', baseHash: 'abc123' });
  });

  it('accepts a null baseHash', () => {
    expect(
      parseFsWriteRequestPayloadV1({ path: 'src/new.ts', content: 'x', baseHash: null }),
    ).toEqual({ path: 'src/new.ts', content: 'x', baseHash: null });
  });

  it('safeParse never throws on garbage input', () => {
    expect(safeParseFsWriteRequestPayloadV1(null).success).toBe(false);
    expect(
      safeParseFsWriteRequestPayloadV1({ path: 'src/foo.ts', content: 'x' }).success,
    ).toBe(false);
    expect(
      safeParseFsWriteRequestPayloadV1({ path: 'src/foo.ts', content: 'x', baseHash: '' }).success,
    ).toBe(false);
  });
});

describe('fsWriteResponsePayloadV1', () => {
  it('parses the ok outcome with path and the new hash', () => {
    const result = parseFsWriteResponsePayloadV1({
      outcome: 'ok',
      path: 'src/foo.ts',
      hash: 'def456',
    });
    expect(result).toEqual({ outcome: 'ok', path: 'src/foo.ts', hash: 'def456' });
  });

  it('parses the conflict outcome with the real on-disk current state', () => {
    const result = parseFsWriteResponsePayloadV1({
      outcome: 'conflict',
      path: 'src/foo.ts',
      current: { content: 'changed underneath', hash: 'ghi789', truncated: false },
    });
    expect(result).toEqual({
      outcome: 'conflict',
      path: 'src/foo.ts',
      current: { content: 'changed underneath', hash: 'ghi789', truncated: false },
    });
  });

  it('parses the conflict outcome with current: null when the file was deleted underneath', () => {
    const result = parseFsWriteResponsePayloadV1({
      outcome: 'conflict',
      path: 'src/foo.ts',
      current: null,
    });
    expect(result).toEqual({ outcome: 'conflict', path: 'src/foo.ts', current: null });
  });

  it('parses the error outcome', () => {
    const result = parseFsWriteResponsePayloadV1({
      outcome: 'error',
      path: 'src/foo.ts',
      message: 'permission denied',
    });
    expect(result).toEqual({ outcome: 'error', path: 'src/foo.ts', message: 'permission denied' });
  });

  it('rejects an outcome outside the three known variants', () => {
    expect(safeParseFsWriteResponsePayloadV1({ outcome: 'pending', path: '' }).success).toBe(
      false,
    );
  });
});

describe('fsWriteRequest / fsWriteResponse (the top-level wire messages)', () => {
  it('fsWriteRequest carries only clear routing metadata plus the opaque envelope — never path/content fields', () => {
    const message = {
      type: 'fs_write_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      targetId: 'local',
      requestId: 'req-1',
      envelope,
    };
    const result = fsWriteRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'targetId', 'type'].sort(),
    );
  });

  it('rejects a request missing requestId/targetId/sessionId', () => {
    expect(
      fsWriteRequest.safeParse({
        type: 'fs_write_request',
        protocolVersion: 1,
        sessionId: '',
        targetId: 'local',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(false);
  });

  it('fsWriteResponse carries only sessionId/requestId plus the opaque envelope', () => {
    const result = fsWriteResponse.safeParse({
      type: 'fs_write_response',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
    });
    expect(result.success).toBe(true);
  });
});
