import { describe, expect, it } from 'vitest';
import {
  parseTargetFsListRequestPayloadV1,
  parseTargetFsListResponsePayloadV1,
  safeParseTargetFsListRequestPayloadV1,
  safeParseTargetFsListResponsePayloadV1,
  targetFsListRequest,
  targetFsListResponse,
} from './target-fs';

const envelope = {
  resourceId: 'target-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('targetFsListRequestPayloadV1', () => {
  it('accepts any path, including the empty "let the node pick" path', () => {
    expect(() => parseTargetFsListRequestPayloadV1({ path: '' })).not.toThrow();
    expect(() =>
      parseTargetFsListRequestPayloadV1({ path: '/home/lorenzo/projects' }),
    ).not.toThrow();
  });

  it('safeParse never throws on garbage input', () => {
    expect(safeParseTargetFsListRequestPayloadV1(null).success).toBe(false);
    expect(safeParseTargetFsListRequestPayloadV1({}).success).toBe(false);
  });
});

describe('targetFsListResponsePayloadV1', () => {
  it('parses the ok outcome with entries, reusing fsEntryV1 (dirs and files alike)', () => {
    const result = parseTargetFsListResponsePayloadV1({
      outcome: 'ok',
      path: '/home/lorenzo',
      entries: [
        { name: 'projects', kind: 'dir', size: 0 },
        { name: '.bashrc', kind: 'file', size: 220 },
      ],
    });
    expect(result.outcome).toBe('ok');
  });

  it('parses the error outcome', () => {
    const result = parseTargetFsListResponsePayloadV1({
      outcome: 'error',
      path: '/root',
      message: 'permission denied',
    });
    expect(result.outcome).toBe('error');
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseTargetFsListResponsePayloadV1({ outcome: 'pending', path: '' }).success).toBe(
      false,
    );
  });

  it('rejects ok without entries', () => {
    expect(safeParseTargetFsListResponsePayloadV1({ outcome: 'ok', path: '' }).success).toBe(false);
  });
});

describe('targetFsListRequest / targetFsListResponse (the top-level wire messages)', () => {
  it('targetFsListRequest carries only clear routing metadata (nodeId+targetId+requestId) plus the opaque envelope — never a path field', () => {
    const message = {
      type: 'target_fs_list_request' as const,
      protocolVersion: 1 as const,
      nodeId: 'node_1',
      targetId: 'local',
      requestId: 'req_1',
      envelope,
    };
    const result = targetFsListRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['envelope', 'nodeId', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
    );
  });

  it('rejects a request missing nodeId/targetId/requestId', () => {
    expect(
      targetFsListRequest.safeParse({
        type: 'target_fs_list_request',
        protocolVersion: 1,
        nodeId: '',
        targetId: 'local',
        requestId: 'req_1',
        envelope,
      }).success,
    ).toBe(false);
    expect(
      targetFsListRequest.safeParse({
        type: 'target_fs_list_request',
        protocolVersion: 1,
        nodeId: 'node_1',
        targetId: 'local',
        envelope,
      }).success,
    ).toBe(false);
  });

  it('targetFsListResponse carries only targetId/requestId plus the opaque envelope', () => {
    const result = targetFsListResponse.safeParse({
      type: 'target_fs_list_response',
      protocolVersion: 1,
      targetId: 'local',
      requestId: 'req_1',
      envelope,
    });
    expect(result.success).toBe(true);
  });

  it('is additive/version-safe: an extra unknown field never leaks a path — parse still only recognizes the declared fields', () => {
    const result = targetFsListRequest.safeParse({
      type: 'target_fs_list_request',
      protocolVersion: 1,
      nodeId: 'node_1',
      targetId: 'local',
      requestId: 'req_1',
      envelope,
      path: '/etc/passwd', // must never be a real field this schema reads
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('path' in result.data).toBe(false);
    }
  });
});

describe('targetFsListResultV1.gitRepo', () => {
  it('is optional, so a node predating the field still produces a valid listing', () => {
    const parsed = parseTargetFsListResponsePayloadV1({
      outcome: 'ok',
      path: '/srv/app',
      entries: [],
    });
    expect(parsed.outcome).toBe('ok');
    if (parsed.outcome !== 'ok') throw new Error('unreachable');
    expect(parsed.gitRepo).toBeUndefined();
  });

  it('round-trips both answers, since "not a repo" is a normal project (SPEC 6)', () => {
    for (const gitRepo of [true, false]) {
      const parsed = parseTargetFsListResponsePayloadV1({
        outcome: 'ok',
        path: '/srv/app',
        entries: [],
        gitRepo,
      });
      if (parsed.outcome !== 'ok') throw new Error('unreachable');
      expect(parsed.gitRepo).toBe(gitRepo);
    }
  });
});
