import { describe, expect, it } from 'vitest';

import type { SessionStatusV1 } from '@loombox/protocol';

import {
  type ConcurrencySession,
  queuePositionReasons,
  summarizeTargetConcurrency,
} from './target-concurrency';

function session(id: string, nodeId = 'node-1', targetId = 'local'): ConcurrencySession {
  return { id, nodeId, targetId };
}

describe('summarizeTargetConcurrency (issue #255)', () => {
  it('counts slot-holding statuses as running and queued as queued, per target', () => {
    const sessions = [
      session('a'),
      session('b'),
      session('c'),
      session('d', 'node-1', 'ssh:devbox'),
    ];
    const statuses = new Map<string, SessionStatusV1>([
      ['a', 'working'],
      ['b', 'awaiting_input'],
      ['c', 'queued'],
      ['d', 'starting'],
    ]);
    const snapshot = summarizeTargetConcurrency(sessions, (id) => statuses.get(id));
    expect(snapshot.get('node-1:local')).toEqual({ running: 2, queued: 1 });
    expect(snapshot.get('node-1:ssh:devbox')).toEqual({ running: 1, queued: 0 });
  });

  it('excludes exited/error/disconnected sessions (no slot held, nothing to count)', () => {
    const sessions = [session('a'), session('b'), session('c')];
    const statuses = new Map<string, SessionStatusV1>([
      ['a', 'exited'],
      ['b', 'error'],
      ['c', 'disconnected'],
    ]);
    const snapshot = summarizeTargetConcurrency(sessions, (id) => statuses.get(id));
    expect(snapshot.has('node-1:local')).toBe(false);
  });

  it('a session with no status yet is excluded rather than counted as running', () => {
    const snapshot = summarizeTargetConcurrency([session('a')], () => undefined);
    expect(snapshot.has('node-1:local')).toBe(false);
  });
});

describe('queuePositionReasons (issue #255)', () => {
  it('a lone queued session on its target reads the short form, no position', () => {
    const reasons = queuePositionReasons(
      [session('a')],
      () => 'queued',
      () => '2026-08-07T00:00:00.000Z',
    );
    expect(reasons.get('a')).toBe('waiting for a slot');
  });

  it('ranks multiple queued sessions on the same target oldest-first by their statusUpdatedAt', () => {
    const sessions = [session('newer'), session('older'), session('newest')];
    const statuses = new Map<string, SessionStatusV1>([
      ['newer', 'queued'],
      ['older', 'queued'],
      ['newest', 'queued'],
    ]);
    const updatedAt = new Map([
      ['newer', '2026-08-07T00:01:00.000Z'],
      ['older', '2026-08-07T00:00:00.000Z'],
      ['newest', '2026-08-07T00:02:00.000Z'],
    ]);
    const reasons = queuePositionReasons(
      sessions,
      (id) => statuses.get(id),
      (id) => updatedAt.get(id),
    );
    expect(reasons.get('older')).toBe('position 1 of 3 waiting for a slot');
    expect(reasons.get('newer')).toBe('position 2 of 3 waiting for a slot');
    expect(reasons.get('newest')).toBe('position 3 of 3 waiting for a slot');
  });

  it('keeps two different targets’ queues fully independent', () => {
    const sessions = [
      session('a', 'node-1', 'local'),
      session('b', 'node-1', 'ssh:devbox'),
    ];
    const reasons = queuePositionReasons(
      sessions,
      () => 'queued',
      () => '2026-08-07T00:00:00.000Z',
    );
    expect(reasons.get('a')).toBe('waiting for a slot');
    expect(reasons.get('b')).toBe('waiting for a slot');
  });

  it('never returns a reason for a non-queued session', () => {
    const reasons = queuePositionReasons(
      [session('a')],
      () => 'working',
      () => undefined,
    );
    expect(reasons.has('a')).toBe(false);
  });

  it('breaks a timestamp tie deterministically by session id', () => {
    const sessions = [session('zeta'), session('alpha')];
    const reasons = queuePositionReasons(
      sessions,
      () => 'queued',
      () => '2026-08-07T00:00:00.000Z',
    );
    expect(reasons.get('alpha')).toBe('position 1 of 2 waiting for a slot');
    expect(reasons.get('zeta')).toBe('position 2 of 2 waiting for a slot');
  });
});
