import { describe, expect, it } from 'vitest';
import {
  safeParseTrackerConnectivityStatusPayloadV1,
  trackerConnectivityStatus,
} from './tracker-connectivity';
import { PROTOCOL_V1 } from './handshake';

describe('trackerConnectivityStatusPayloadV1 (issue #219)', () => {
  it('parses a reachable reading', () => {
    const result = safeParseTrackerConnectivityStatusPayloadV1({
      status: { state: 'reachable', provider: 'github', updatedAt: 1000 },
    });
    expect(result.success).toBe(true);
  });

  it('parses an unreachable reading', () => {
    const result = safeParseTrackerConnectivityStatusPayloadV1({
      status: { state: 'unreachable', provider: 'jira', updatedAt: 2000 },
    });
    expect(result.success).toBe(true);
  });

  it('parses an authFailed reading, distinct from unreachable', () => {
    const result = safeParseTrackerConnectivityStatusPayloadV1({
      status: { state: 'authFailed', provider: 'github', updatedAt: 3000 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a state outside the three known variants — never silently widens to a fourth', () => {
    const result = safeParseTrackerConnectivityStatusPayloadV1({
      status: { state: 'rateLimited', provider: 'github', updatedAt: 1000 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a provider outside github/jira', () => {
    const result = safeParseTrackerConnectivityStatusPayloadV1({
      status: { state: 'reachable', provider: 'linear', updatedAt: 1000 },
    });
    expect(result.success).toBe(false);
  });
});

describe('trackerConnectivityStatus wire message', () => {
  it('parses a well-formed message, session-scoped like ci_check_status', () => {
    const result = trackerConnectivityStatus.safeParse({
      type: 'tracker_connectivity_status',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess-1',
      envelope: { resourceId: 'sess-1', alg: 'AES-256-GCM', iv: 'aXY=', ciphertext: 'Y2lwaGVy' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a message with no sessionId', () => {
    const result = trackerConnectivityStatus.safeParse({
      type: 'tracker_connectivity_status',
      protocolVersion: PROTOCOL_V1,
      envelope: { resourceId: 'sess-1', alg: 'AES-256-GCM', iv: 'aXY=', ciphertext: 'Y2lwaGVy' },
    });
    expect(result.success).toBe(false);
  });
});
