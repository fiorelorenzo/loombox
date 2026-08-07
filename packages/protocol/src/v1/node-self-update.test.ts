import { describe, expect, it } from 'vitest';
import {
  nodeSelfUpdateApplyRequest,
  nodeSelfUpdateApplyResponse,
  nodeSelfUpdateStatusAnnounce,
  nodeSelfUpdateStatusV1,
  nodeSelfUpdateSummaryV1,
} from './node-self-update';

describe('nodeSelfUpdateStatusV1', () => {
  it('accepts every NodeSelfUpdateMonitor verdict', () => {
    for (const status of ['current', 'update_available', 'unknown']) {
      expect(nodeSelfUpdateStatusV1.safeParse(status).success).toBe(true);
    }
  });

  it('rejects a target-lifecycle-only value ("behind"/"ahead" belong to targetVersionStatusV1, not here)', () => {
    expect(nodeSelfUpdateStatusV1.safeParse('behind').success).toBe(false);
    expect(nodeSelfUpdateStatusV1.safeParse('ahead').success).toBe(false);
  });
});

describe('nodeSelfUpdateSummaryV1', () => {
  it('parses a full "update available" summary', () => {
    const summary = {
      status: 'update_available' as const,
      currentVersion: '0.8.0',
      latestVersion: '0.9.0',
      checkedAt: 1_700_000_000_000,
    };
    expect(nodeSelfUpdateSummaryV1.parse(summary)).toEqual(summary);
  });

  it('parses a "current" summary with latestVersion omitted (equal to currentVersion, never sent redundantly is fine too)', () => {
    const summary = { status: 'current' as const, currentVersion: '0.8.0', checkedAt: 1 };
    expect(nodeSelfUpdateSummaryV1.parse(summary)).toEqual(summary);
  });

  it('rejects a summary missing currentVersion', () => {
    expect(nodeSelfUpdateSummaryV1.safeParse({ status: 'unknown', checkedAt: 1 }).success).toBe(
      false,
    );
  });
});

describe('nodeSelfUpdateStatusAnnounce', () => {
  it('parses a full push, unprompted (no requestId — never a reply)', () => {
    const message = {
      type: 'node_self_update_status' as const,
      protocolVersion: 1 as const,
      nodeId: 'node_1',
      status: 'update_available' as const,
      currentVersion: '0.8.0',
      latestVersion: '0.9.0',
      checkedAt: 1_700_000_000_000,
    };
    const result = nodeSelfUpdateStatusAnnounce.safeParse(message);
    expect(result.success).toBe(true);
    expect('requestId' in message).toBe(false);
  });

  it('is additive/version-safe: an extra unknown field is ignored, never leaked into the parsed result', () => {
    const result = nodeSelfUpdateStatusAnnounce.safeParse({
      type: 'node_self_update_status',
      protocolVersion: 1,
      nodeId: 'node_1',
      status: 'current',
      currentVersion: '0.8.0',
      checkedAt: 1,
      commitSha: 'not-a-real-field',
    });
    expect(result.success).toBe(true);
    if (result.success) expect('commitSha' in result.data).toBe(false);
  });
});

describe('nodeSelfUpdateApplyRequest', () => {
  it('parses a minimal request — no targetVersion field: it can only act on what the node itself already announced', () => {
    const message = {
      type: 'node_self_update_apply_request' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      nodeId: 'node_1',
    };
    const result = nodeSelfUpdateApplyRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['nodeId', 'protocolVersion', 'requestId', 'type'].sort(),
    );
  });

  it('rejects a request missing nodeId', () => {
    expect(
      nodeSelfUpdateApplyRequest.safeParse({
        type: 'node_self_update_apply_request',
        protocolVersion: 1,
        requestId: 'req_1',
      }).success,
    ).toBe(false);
  });
});

describe('nodeSelfUpdateApplyResponse', () => {
  it('parses a successful outcome with fromVersion/toVersion', () => {
    const message = {
      type: 'node_self_update_apply_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      nodeId: 'node_1',
      ok: true,
      fromVersion: '0.8.0',
      toVersion: '0.9.0',
      message: 'updated 0.8.0 -> 0.9.0; restarting to apply',
    };
    const result = nodeSelfUpdateApplyResponse.safeParse(message);
    expect(result.success).toBe(true);
    expect(result.success && 'envelope' in result.data).toBe(false);
  });

  it('parses a failed outcome with no toVersion — a failed attempt never reports having moved', () => {
    const message = {
      type: 'node_self_update_apply_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      nodeId: 'node_1',
      ok: false,
      fromVersion: '0.8.0',
      message: 'a session is actively working on a turn; try again once it settles',
    };
    expect(nodeSelfUpdateApplyResponse.parse(message)).toEqual(message);
  });

  it('is additive/version-safe: an extra unknown field is ignored, never leaked into the parsed result', () => {
    const result = nodeSelfUpdateApplyResponse.safeParse({
      type: 'node_self_update_apply_response',
      protocolVersion: 1,
      requestId: 'req_1',
      nodeId: 'node_1',
      ok: true,
      fromVersion: '0.8.0',
      toVersion: '0.9.0',
      message: 'ok',
      extra: 123,
    });
    expect(result.success).toBe(true);
    if (result.success) expect('extra' in result.data).toBe(false);
  });
});
