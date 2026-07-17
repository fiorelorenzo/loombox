import { describe, expect, it } from 'vitest';

import { PermissionQueue } from './permission-queue';
import type { AcpPermissionOption, AcpToolCallUpdate } from './types';

const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

function toolCall(id: string, extra: Partial<AcpToolCallUpdate> = {}): AcpToolCallUpdate {
  return { kind: 'tool_call', id, title: `tool ${id}`, ...extra };
}

describe('PermissionQueue: FIFO ordering', () => {
  it('queues requests for a session in arrival order', () => {
    const queue = new PermissionQueue();
    queue.enqueue({
      requestId: 'r1',
      sessionId: 's1',
      toolCall: toolCall('tc1'),
      options: OPTIONS,
    });
    queue.enqueue({
      requestId: 'r2',
      sessionId: 's1',
      toolCall: toolCall('tc2'),
      options: OPTIONS,
    });
    queue.enqueue({
      requestId: 'r3',
      sessionId: 's1',
      toolCall: toolCall('tc3'),
      options: OPTIONS,
    });

    expect(queue.list('s1').map((r) => r.requestId)).toEqual(['r1', 'r2', 'r3']);
    expect(queue.head('s1')?.requestId).toBe('r1');
  });

  it('keeps each session its own independent queue', () => {
    const queue = new PermissionQueue();
    queue.enqueue({ requestId: 'a1', sessionId: 'sA', toolCall: toolCall('tc'), options: OPTIONS });
    queue.enqueue({ requestId: 'b1', sessionId: 'sB', toolCall: toolCall('tc'), options: OPTIONS });

    expect(queue.list('sA').map((r) => r.requestId)).toEqual(['a1']);
    expect(queue.list('sB').map((r) => r.requestId)).toEqual(['b1']);
  });
});

describe('PermissionQueue: resolve', () => {
  it('resolving removes the request everywhere (no longer in list/head)', () => {
    const queue = new PermissionQueue();
    queue.enqueue({
      requestId: 'r1',
      sessionId: 's1',
      toolCall: toolCall('tc1'),
      options: OPTIONS,
    });

    const result = queue.resolve('r1', { outcome: 'selected', optionId: 'allow' });

    expect(result).toEqual({
      status: 'resolved',
      requestId: 'r1',
      sessionId: 's1',
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(queue.list('s1')).toEqual([]);
    expect(queue.head('s1')).toBeUndefined();
  });

  it('emits "resolved" exactly once so every subscriber observes the same resolution', () => {
    const queue = new PermissionQueue();
    queue.enqueue({
      requestId: 'r1',
      sessionId: 's1',
      toolCall: toolCall('tc1'),
      options: OPTIONS,
    });

    const seen: unknown[] = [];
    queue.on('resolved', (result: unknown) => seen.push(result));
    queue.resolve('r1', { outcome: 'selected', optionId: 'allow' });

    expect(seen).toHaveLength(1);
  });

  it('a stale approve/deny against an already-resolved id returns "stale", not a silent success', () => {
    const queue = new PermissionQueue();
    queue.enqueue({
      requestId: 'r1',
      sessionId: 's1',
      toolCall: toolCall('tc1'),
      options: OPTIONS,
    });
    queue.resolve('r1', { outcome: 'selected', optionId: 'allow' });

    const second = queue.resolve('r1', { outcome: 'selected', optionId: 'deny' });
    expect(second).toEqual({ status: 'stale', requestId: 'r1' });
  });

  it('a resolve against an id that never existed also returns "stale"', () => {
    const queue = new PermissionQueue();
    expect(queue.resolve('unknown', { outcome: 'cancelled' })).toEqual({
      status: 'stale',
      requestId: 'unknown',
    });
  });

  it('denying one request leaves siblings from the same turn queued, unresolved, in original order', () => {
    const queue = new PermissionQueue();
    queue.enqueue({
      requestId: 'r1',
      sessionId: 's1',
      toolCall: toolCall('tc1'),
      options: OPTIONS,
    });
    queue.enqueue({
      requestId: 'r2',
      sessionId: 's1',
      toolCall: toolCall('tc2'),
      options: OPTIONS,
    });
    queue.enqueue({
      requestId: 'r3',
      sessionId: 's1',
      toolCall: toolCall('tc3'),
      options: OPTIONS,
    });

    queue.resolve('r1', { outcome: 'selected', optionId: 'deny' });

    expect(queue.list('s1').map((r) => r.requestId)).toEqual(['r2', 'r3']);
    expect(queue.head('s1')?.requestId).toBe('r2');
  });
});

describe('PermissionQueue: Stop / cancelAll', () => {
  it('resolves every open request for a session as cancelled, immediately', () => {
    const queue = new PermissionQueue();
    queue.enqueue({
      requestId: 'r1',
      sessionId: 's1',
      toolCall: toolCall('tc1'),
      options: OPTIONS,
    });
    queue.enqueue({
      requestId: 'r2',
      sessionId: 's1',
      toolCall: toolCall('tc2'),
      options: OPTIONS,
    });
    queue.enqueue({
      requestId: 'other',
      sessionId: 's2',
      toolCall: toolCall('tc3'),
      options: OPTIONS,
    });

    const results = queue.cancelAll('s1');

    expect(results).toEqual([
      { status: 'resolved', requestId: 'r1', sessionId: 's1', outcome: { outcome: 'cancelled' } },
      { status: 'resolved', requestId: 'r2', sessionId: 's1', outcome: { outcome: 'cancelled' } },
    ]);
    expect(queue.list('s1')).toEqual([]);
    // A different session's queue is untouched by another session's Stop.
    expect(queue.list('s2').map((r) => r.requestId)).toEqual(['other']);
  });

  it('is a no-op (empty result) when the session has no pending requests', () => {
    const queue = new PermissionQueue();
    expect(queue.cancelAll('nothing-pending')).toEqual([]);
  });
});

describe('PermissionQueue: nested visibility', () => {
  it('only the current FIFO head is actionable, nested request or not', () => {
    const queue = new PermissionQueue();
    const parentCall = toolCall('parent1');
    const nestedCall = toolCall('child1', { parentToolCallId: 'parent1' });

    queue.enqueue({
      requestId: 'r-parent',
      sessionId: 's1',
      toolCall: parentCall,
      options: OPTIONS,
    });
    queue.enqueue({
      requestId: 'r-child',
      sessionId: 's1',
      toolCall: nestedCall,
      options: OPTIONS,
    });

    // Parent is head: only the parent request is actionable yet.
    expect(queue.isActionable('r-parent')).toBe(true);
    expect(queue.isActionable('r-child')).toBe(false);

    queue.resolve('r-parent', { outcome: 'selected', optionId: 'allow' });

    // Now the nested request has become the head, and only now is actionable.
    expect(queue.isActionable('r-child')).toBe(true);
  });

  it('carries parentToolCallId on the queued item for a UI to force open the ancestor chain', () => {
    const queue = new PermissionQueue();
    const nestedCall = toolCall('child1', { parentToolCallId: 'parent1' });
    const request = queue.enqueue({
      requestId: 'r-child',
      sessionId: 's1',
      toolCall: nestedCall,
      options: OPTIONS,
    });

    expect(request.parentToolCallId).toBe('parent1');
  });

  it('isActionable is false for an unknown/already-resolved id', () => {
    const queue = new PermissionQueue();
    expect(queue.isActionable('never-existed')).toBe(false);
  });
});

describe('PermissionQueue: duplicate ids', () => {
  it('throws on enqueuing the same request id twice', () => {
    const queue = new PermissionQueue();
    queue.enqueue({
      requestId: 'r1',
      sessionId: 's1',
      toolCall: toolCall('tc1'),
      options: OPTIONS,
    });
    expect(() =>
      queue.enqueue({
        requestId: 'r1',
        sessionId: 's1',
        toolCall: toolCall('tc1'),
        options: OPTIONS,
      }),
    ).toThrow();
  });
});
