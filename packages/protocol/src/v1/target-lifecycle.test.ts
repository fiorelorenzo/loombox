import { describe, expect, it } from 'vitest';
import {
  decommissionResultV1,
  decommissionTargetRequest,
  decommissionTargetResponse,
  targetUpdateRequest,
  targetUpdateResponse,
  targetVersionStatusV1,
} from './target-lifecycle';

describe('decommissionTargetRequest', () => {
  const valid = {
    type: 'decommission_target_request' as const,
    protocolVersion: 1 as const,
    requestId: 'req_1',
    nodeId: 'node_1',
    targetId: 'ssh:devbox',
  };

  it('parses a request with removeFiles omitted (defaults to nothing on the wire, node-side default is false)', () => {
    expect(decommissionTargetRequest.parse(valid)).toEqual(valid);
  });

  it('parses a request with removeFiles explicitly set', () => {
    const withRemoveFiles = { ...valid, removeFiles: true };
    expect(decommissionTargetRequest.parse(withRemoveFiles)).toEqual(withRemoveFiles);
  });

  it('rejects a request missing nodeId/targetId/requestId', () => {
    expect(decommissionTargetRequest.safeParse({ ...valid, nodeId: '' }).success).toBe(false);
    expect(decommissionTargetRequest.safeParse({ ...valid, targetId: '' }).success).toBe(false);
    expect(decommissionTargetRequest.safeParse({ ...valid, requestId: '' }).success).toBe(false);
  });

  it('is additive/version-safe: an extra unknown field is ignored, never leaked into the parsed result', () => {
    const result = decommissionTargetRequest.safeParse({ ...valid, host: '10.0.0.5' });
    expect(result.success).toBe(true);
    if (result.success) expect('host' in result.data).toBe(false);
  });
});

describe('decommissionResultV1', () => {
  it('parses a full step summary', () => {
    const result = {
      unitWasInstalled: true,
      unitStopped: true,
      unitDisabled: true,
      deviceKeyRevoked: true,
      filesRemoved: false,
    };
    expect(decommissionResultV1.parse(result)).toEqual(result);
  });
});

describe('decommissionTargetResponse', () => {
  it('parses an ok outcome carrying a result, no envelope', () => {
    const message = {
      type: 'decommission_target_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      nodeId: 'node_1',
      targetId: 'ssh:devbox',
      ok: true,
      result: {
        unitWasInstalled: true,
        unitStopped: true,
        unitDisabled: true,
        deviceKeyRevoked: true,
        filesRemoved: false,
      },
      message: 'decommissioned ssh:devbox',
    };
    const result = decommissionTargetResponse.safeParse(message);
    expect(result.success).toBe(true);
    expect(result.success && 'envelope' in result.data).toBe(false);
  });

  it('parses a failed outcome with no result', () => {
    const message = {
      type: 'decommission_target_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      nodeId: 'node_1',
      targetId: 'ssh:unknown',
      ok: false,
      message: 'unknown target "ssh:unknown"',
    };
    expect(decommissionTargetResponse.parse(message)).toEqual(message);
  });

  it('rejects a response with an empty message', () => {
    expect(
      decommissionTargetResponse.safeParse({
        type: 'decommission_target_response',
        protocolVersion: 1,
        requestId: 'req_1',
        nodeId: 'node_1',
        targetId: 'ssh:devbox',
        ok: false,
        message: '',
      }).success,
    ).toBe(false);
  });
});

describe('targetUpdateRequest', () => {
  it('parses a minimal request (routing metadata only)', () => {
    const message = {
      type: 'target_update_request' as const,
      protocolVersion: 1 as const,
      requestId: 'req_2',
      nodeId: 'node_1',
      targetId: 'ssh:devbox',
    };
    const result = targetUpdateRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['nodeId', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
    );
  });

  it('rejects a request missing targetId', () => {
    expect(
      targetUpdateRequest.safeParse({
        type: 'target_update_request',
        protocolVersion: 1,
        requestId: 'req_2',
        nodeId: 'node_1',
      }).success,
    ).toBe(false);
  });
});

describe('targetVersionStatusV1', () => {
  it('accepts every TargetUpdateMonitor status verdict', () => {
    for (const status of ['current', 'behind', 'ahead', 'unknown']) {
      expect(targetVersionStatusV1.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an outside value', () => {
    expect(targetVersionStatusV1.safeParse('stale').success).toBe(false);
  });
});

describe('targetUpdateResponse', () => {
  it('parses an ok outcome with a status/version, no envelope', () => {
    const message = {
      type: 'target_update_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_2',
      nodeId: 'node_1',
      targetId: 'ssh:devbox',
      ok: true,
      status: 'current' as const,
      remoteVersion: '1.2.0',
      installedVersion: '1.2.0',
      message: 'upgraded ssh:devbox to 1.2.0',
    };
    const result = targetUpdateResponse.safeParse(message);
    expect(result.success).toBe(true);
    expect(result.success && 'envelope' in result.data).toBe(false);
  });

  it('parses a not-configured failure with no status/version', () => {
    const message = {
      type: 'target_update_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_2',
      nodeId: 'node_1',
      targetId: 'ssh:devbox',
      ok: false,
      message: 'target updates are not configured on this node',
    };
    expect(targetUpdateResponse.parse(message)).toEqual(message);
  });

  it('is additive/version-safe: an extra unknown field is ignored, never leaked into the parsed result', () => {
    const result = targetUpdateResponse.safeParse({
      type: 'target_update_response',
      protocolVersion: 1,
      requestId: 'req_2',
      nodeId: 'node_1',
      targetId: 'ssh:devbox',
      ok: true,
      message: 'noop',
      artifactBytes: 123,
    });
    expect(result.success).toBe(true);
    if (result.success) expect('artifactBytes' in result.data).toBe(false);
  });
});
