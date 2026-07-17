import { describe, expect, it } from 'vitest';

import {
  cancelAllPermissionRequests,
  createPermissionQueueState,
  enqueuePermissionRequest,
  headPermissionRequest,
  isPermissionRequestActionable,
  listPermissionRequests,
  resolvePermissionRequest,
  type PermissionQueueState,
} from './permission-queue-state';
import type { AcpPermissionOption, AcpToolCallUpdate } from './types';

const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

function toolCall(id: string, extra: Partial<AcpToolCallUpdate> = {}): AcpToolCallUpdate {
  return { kind: 'tool_call', id, title: `tool ${id}`, ...extra };
}

function enqueue(
  state: PermissionQueueState,
  requestId: string,
  sessionId: string,
  extra: Partial<AcpToolCallUpdate> = {},
): PermissionQueueState {
  return enqueuePermissionRequest(state, {
    requestId,
    sessionId,
    toolCall: toolCall(`tc-${requestId}`, extra),
    options: OPTIONS,
  }).state;
}

describe('permission-queue-state: purity', () => {
  it('never mutates the state passed in — a late reader still sees the old value', () => {
    const before = createPermissionQueueState();
    const after = enqueue(before, 'r1', 's1');
    expect(listPermissionRequests(before, 's1')).toEqual([]);
    expect(listPermissionRequests(after, 's1').map((r) => r.requestId)).toEqual(['r1']);
  });
});

describe('permission-queue-state: FIFO ordering', () => {
  it('queues requests for a session in arrival order', () => {
    let state = createPermissionQueueState();
    state = enqueue(state, 'r1', 's1');
    state = enqueue(state, 'r2', 's1');
    state = enqueue(state, 'r3', 's1');

    expect(listPermissionRequests(state, 's1').map((r) => r.requestId)).toEqual(['r1', 'r2', 'r3']);
    expect(headPermissionRequest(state, 's1')?.requestId).toBe('r1');
  });

  it('keeps each session its own independent queue', () => {
    let state = createPermissionQueueState();
    state = enqueue(state, 'a1', 'sA');
    state = enqueue(state, 'b1', 'sB');

    expect(listPermissionRequests(state, 'sA').map((r) => r.requestId)).toEqual(['a1']);
    expect(listPermissionRequests(state, 'sB').map((r) => r.requestId)).toEqual(['b1']);
  });

  it('throws on enqueuing the same request id twice', () => {
    const state = enqueue(createPermissionQueueState(), 'r1', 's1');
    expect(() => enqueue(state, 'r1', 's1')).toThrow();
  });
});

describe('permission-queue-state: resolve', () => {
  it('resolving removes the request everywhere (no longer in list/head)', () => {
    const state = enqueue(createPermissionQueueState(), 'r1', 's1');
    const { state: next, result } = resolvePermissionRequest(state, 'r1', {
      outcome: 'selected',
      optionId: 'allow',
    });

    expect(result).toEqual({
      status: 'resolved',
      requestId: 'r1',
      sessionId: 's1',
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(listPermissionRequests(next, 's1')).toEqual([]);
    expect(headPermissionRequest(next, 's1')).toBeUndefined();
  });

  it('a stale resolve against an already-resolved id returns "stale", not a silent success', () => {
    let state = enqueue(createPermissionQueueState(), 'r1', 's1');
    state = resolvePermissionRequest(state, 'r1', { outcome: 'selected', optionId: 'allow' }).state;

    const second = resolvePermissionRequest(state, 'r1', { outcome: 'selected', optionId: 'deny' });
    expect(second.result).toEqual({ status: 'stale', requestId: 'r1' });
  });

  it('a resolve against an id that never existed also returns "stale"', () => {
    const { result } = resolvePermissionRequest(createPermissionQueueState(), 'unknown', {
      outcome: 'cancelled',
    });
    expect(result).toEqual({ status: 'stale', requestId: 'unknown' });
  });

  it('denying one request leaves siblings from the same turn queued, unresolved, in original order', () => {
    let state = createPermissionQueueState();
    state = enqueue(state, 'r1', 's1');
    state = enqueue(state, 'r2', 's1');
    state = enqueue(state, 'r3', 's1');

    state = resolvePermissionRequest(state, 'r1', { outcome: 'selected', optionId: 'deny' }).state;

    expect(listPermissionRequests(state, 's1').map((r) => r.requestId)).toEqual(['r2', 'r3']);
    expect(headPermissionRequest(state, 's1')?.requestId).toBe('r2');
  });
});

describe('permission-queue-state: Stop / cancelAll', () => {
  it('resolves every open request for a session as cancelled, immediately, leaving other sessions untouched', () => {
    let state = createPermissionQueueState();
    state = enqueue(state, 'r1', 's1');
    state = enqueue(state, 'r2', 's1');
    state = enqueue(state, 'r3', 's1');
    state = enqueue(state, 'other', 's2');

    const { state: next, results } = cancelAllPermissionRequests(state, 's1');

    expect(results).toEqual([
      { status: 'resolved', requestId: 'r1', sessionId: 's1', outcome: { outcome: 'cancelled' } },
      { status: 'resolved', requestId: 'r2', sessionId: 's1', outcome: { outcome: 'cancelled' } },
      { status: 'resolved', requestId: 'r3', sessionId: 's1', outcome: { outcome: 'cancelled' } },
    ]);
    expect(listPermissionRequests(next, 's1')).toEqual([]);
    expect(listPermissionRequests(next, 's2').map((r) => r.requestId)).toEqual(['other']);
  });

  it('is a no-op (empty result) when the session has no pending requests', () => {
    const { results } = cancelAllPermissionRequests(
      createPermissionQueueState(),
      'nothing-pending',
    );
    expect(results).toEqual([]);
  });
});

describe('permission-queue-state: nested visibility', () => {
  it('only the current FIFO head is actionable, nested request or not', () => {
    let state = createPermissionQueueState();
    state = enqueuePermissionRequest(state, {
      requestId: 'r-parent',
      sessionId: 's1',
      toolCall: toolCall('parent1'),
      options: OPTIONS,
    }).state;
    state = enqueuePermissionRequest(state, {
      requestId: 'r-child',
      sessionId: 's1',
      toolCall: toolCall('child1', { parentToolCallId: 'parent1' }),
      options: OPTIONS,
    }).state;

    expect(isPermissionRequestActionable(state, 'r-parent')).toBe(true);
    expect(isPermissionRequestActionable(state, 'r-child')).toBe(false);

    state = resolvePermissionRequest(state, 'r-parent', {
      outcome: 'selected',
      optionId: 'allow',
    }).state;

    expect(isPermissionRequestActionable(state, 'r-child')).toBe(true);
  });

  it('carries parentToolCallId on the queued item for a UI to force open the ancestor chain', () => {
    const { request } = enqueuePermissionRequest(createPermissionQueueState(), {
      requestId: 'r-child',
      sessionId: 's1',
      toolCall: toolCall('child1', { parentToolCallId: 'parent1' }),
      options: OPTIONS,
    });
    expect(request.parentToolCallId).toBe('parent1');
  });

  it('isActionable is false for an unknown/already-resolved id', () => {
    expect(isPermissionRequestActionable(createPermissionQueueState(), 'never-existed')).toBe(
      false,
    );
  });
});
