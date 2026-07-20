import { describe, expect, it } from 'vitest';
import {
  createPermissionQueueState,
  enqueuePermissionRequest,
  type PermissionQueueState,
} from '@loombox/providers-core';

import {
  parseResolvingPushAction,
  pickPermissionOptionForAction,
  resolvePendingPushAction,
} from './push-action-routing';

describe('parseResolvingPushAction (#165)', () => {
  it('recognizes approve and deny', () => {
    expect(parseResolvingPushAction('approve')).toBe('approve');
    expect(parseResolvingPushAction('deny')).toBe('deny');
  });

  it('treats open, empty, missing, and unrecognized actions as nothing to resolve', () => {
    expect(parseResolvingPushAction('open')).toBeUndefined();
    expect(parseResolvingPushAction('')).toBeUndefined();
    expect(parseResolvingPushAction(null)).toBeUndefined();
    expect(parseResolvingPushAction(undefined)).toBeUndefined();
    expect(parseResolvingPushAction('nonsense')).toBeUndefined();
  });
});

describe('pickPermissionOptionForAction (#165)', () => {
  const options = [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'allow-always', name: 'Allow all edits', kind: 'allow_always' as const },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    { optionId: 'deny-always', name: 'Reject all', kind: 'reject_always' as const },
  ];

  it('prefers the once-tier option for approve/deny over the always tier', () => {
    expect(pickPermissionOptionForAction(options, 'approve')).toEqual(options[0]);
    expect(pickPermissionOptionForAction(options, 'deny')).toEqual(options[2]);
  });

  it('falls back to the always-tier option when a once-tier one is not offered', () => {
    const onlyAlways = [options[1], options[3]];
    expect(pickPermissionOptionForAction(onlyAlways, 'approve')).toEqual(options[1]);
    expect(pickPermissionOptionForAction(onlyAlways, 'deny')).toEqual(options[3]);
  });

  it('returns undefined when neither tier is offered', () => {
    expect(pickPermissionOptionForAction([], 'approve')).toBeUndefined();
  });
});

describe('resolvePendingPushAction (#165)', () => {
  function queueWithHead(): PermissionQueueState {
    const { state } = enqueuePermissionRequest(createPermissionQueueState(), {
      requestId: 'req-1',
      sessionId: 'sess-1',
      toolCall: { kind: 'tool_call', id: 'tc1', title: 'Edit src/foo.ts' },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
      enqueuedAt: 0,
    });
    return state;
  }

  it('resolves the FIFO head with the allow_once option on approve', () => {
    const queue = queueWithHead();
    expect(resolvePendingPushAction(queue, 'sess-1', 'approve')).toEqual({
      requestId: 'req-1',
      option: { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    });
  });

  it('resolves the FIFO head with the reject_once option on deny', () => {
    const queue = queueWithHead();
    expect(resolvePendingPushAction(queue, 'sess-1', 'deny')).toEqual({
      requestId: 'req-1',
      option: { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    });
  });

  it('returns undefined for the open action (just a deep link, nothing to resolve)', () => {
    const queue = queueWithHead();
    expect(resolvePendingPushAction(queue, 'sess-1', 'open')).toBeUndefined();
  });

  it('returns undefined when there is no pending request for the session (already resolved elsewhere, or not arrived yet)', () => {
    const queue = createPermissionQueueState();
    expect(resolvePendingPushAction(queue, 'sess-1', 'approve')).toBeUndefined();
  });

  it('returns undefined for an unrelated session id', () => {
    const queue = queueWithHead();
    expect(resolvePendingPushAction(queue, 'sess-2', 'approve')).toBeUndefined();
  });
});
