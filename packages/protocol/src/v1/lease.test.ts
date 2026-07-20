import { describe, expect, it } from 'vitest';
import { leaseRelease, leaseReleaseResult, leaseRequest, leaseResult } from './lease';

describe('leaseRequest', () => {
  it('accepts an acquire request with an optional ttlMs', () => {
    const result = leaseRequest.safeParse({
      type: 'lease_request',
      protocolVersion: 1,
      requestId: 'req-1',
      sessionId: 'sess-1',
      nodeId: 'node-a',
      action: 'acquire',
      ttlMs: 30_000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a renew request without ttlMs (optional)', () => {
    const result = leaseRequest.safeParse({
      type: 'lease_request',
      protocolVersion: 1,
      requestId: 'req-2',
      sessionId: 'sess-1',
      nodeId: 'node-a',
      action: 'renew',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an action outside acquire/renew', () => {
    expect(
      leaseRequest.safeParse({
        type: 'lease_request',
        protocolVersion: 1,
        requestId: 'req-3',
        sessionId: 'sess-1',
        nodeId: 'node-a',
        action: 'reclaim',
      }).success,
    ).toBe(false);
  });

  it('rejects missing sessionId/nodeId/requestId', () => {
    expect(
      leaseRequest.safeParse({
        type: 'lease_request',
        protocolVersion: 1,
        requestId: 'req-4',
        sessionId: '',
        nodeId: 'node-a',
        action: 'acquire',
      }).success,
    ).toBe(false);
    expect(
      leaseRequest.safeParse({
        type: 'lease_request',
        protocolVersion: 1,
        requestId: 'req-5',
        sessionId: 'sess-1',
        nodeId: '',
        action: 'acquire',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-positive ttlMs', () => {
    expect(
      leaseRequest.safeParse({
        type: 'lease_request',
        protocolVersion: 1,
        requestId: 'req-6',
        sessionId: 'sess-1',
        nodeId: 'node-a',
        action: 'acquire',
        ttlMs: 0,
      }).success,
    ).toBe(false);
  });
});

describe('leaseResult', () => {
  it('parses a granted outcome', () => {
    const result = leaseResult.safeParse({
      type: 'lease_result',
      protocolVersion: 1,
      requestId: 'req-1',
      sessionId: 'sess-1',
      result: { outcome: 'granted', expiresAt: 12345 },
    });
    expect(result.success).toBe(true);
  });

  it('parses a denied outcome naming the current holder', () => {
    const result = leaseResult.safeParse({
      type: 'lease_result',
      protocolVersion: 1,
      requestId: 'req-2',
      sessionId: 'sess-1',
      result: { outcome: 'denied', heldBy: 'node-b', expiresAt: 99999 },
    });
    expect(result.success).toBe(true);
  });

  it('parses a denied outcome with no holder to report (renew on an unheld session)', () => {
    const result = leaseResult.safeParse({
      type: 'lease_result',
      protocolVersion: 1,
      requestId: 'req-3',
      sessionId: 'sess-1',
      result: { outcome: 'denied' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an outcome outside granted/denied', () => {
    expect(
      leaseResult.safeParse({
        type: 'lease_result',
        protocolVersion: 1,
        requestId: 'req-4',
        sessionId: 'sess-1',
        result: { outcome: 'pending' },
      }).success,
    ).toBe(false);
  });

  it('rejects granted without expiresAt', () => {
    expect(
      leaseResult.safeParse({
        type: 'lease_result',
        protocolVersion: 1,
        requestId: 'req-5',
        sessionId: 'sess-1',
        result: { outcome: 'granted' },
      }).success,
    ).toBe(false);
  });
});

describe('leaseRelease / leaseReleaseResult', () => {
  it('parses a release request', () => {
    const result = leaseRelease.safeParse({
      type: 'lease_release',
      protocolVersion: 1,
      requestId: 'req-1',
      sessionId: 'sess-1',
      nodeId: 'node-a',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a release request missing nodeId', () => {
    expect(
      leaseRelease.safeParse({
        type: 'lease_release',
        protocolVersion: 1,
        requestId: 'req-1',
        sessionId: 'sess-1',
        nodeId: '',
      }).success,
    ).toBe(false);
  });

  it('parses a release result for both the true and false case', () => {
    for (const released of [true, false]) {
      const result = leaseReleaseResult.safeParse({
        type: 'lease_release_result',
        protocolVersion: 1,
        requestId: 'req-1',
        sessionId: 'sess-1',
        released,
      });
      expect(result.success).toBe(true);
    }
  });
});
