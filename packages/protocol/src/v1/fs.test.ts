import { describe, expect, it } from 'vitest';
import {
  fsEntryV1,
  fsListRequest,
  fsListResponse,
  parseFsListRequestPayloadV1,
  parseFsListResponsePayloadV1,
  safeParseFsListRequestPayloadV1,
  safeParseFsListResponsePayloadV1,
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
