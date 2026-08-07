import { describe, expect, it } from 'vitest';

import { CiAutoIterateController } from './ci-auto-iterate';

/**
 * `CiAutoIterateController` in isolation (SPEC §7.14/§7.15; issue #246) —
 * no `NodeDaemon`, no `CiCheckWatcher`, no network: every call here feeds
 * it the two facts a real caller would already have in hand (a headSha and
 * an up-to-the-moment eligibility read), mirroring `ci-check-watcher.test.ts`'s
 * own fully-decoupled style for `CiCheckWatcher`.
 */

describe('CiAutoIterateController (SPEC §7.14/§7.15; issue #246)', () => {
  it('a new failure proceeds, incrementing attempts and appending to history', () => {
    const controller = new CiAutoIterateController({ now: () => 1000 });
    const { proceed, state } = controller.onFailure('sess-1', 'sha-a', true);
    expect(proceed).toBe(true);
    expect(state).toEqual({
      active: true,
      attempts: 1,
      maxAttempts: 5,
      stoppedReason: undefined,
      history: [{ attempt: 1, headSha: 'sha-a', promptedAt: 1000 }],
    });
  });

  it('a subsequent green check ends the loop and resets attempts/history for the next one', () => {
    const controller = new CiAutoIterateController({ now: () => 1000 });
    controller.onFailure('sess-1', 'sha-a', true);

    const greenState = controller.onGreen('sess-1');
    expect(greenState).toEqual({
      active: false,
      attempts: 0,
      maxAttempts: 5,
      stoppedReason: 'green',
      history: [],
    });

    // A later new failure (a later commit, a flake) starts counting from 1
    // again, not inheriting the prior loop's attempt count.
    const { proceed, state } = controller.onFailure('sess-1', 'sha-b', true);
    expect(proceed).toBe(true);
    expect(state.attempts).toBe(1);
    expect(state.history).toEqual([{ attempt: 1, headSha: 'sha-b', promptedAt: 1000 }]);
  });

  it('onGreen is a no-op (returns undefined) for a session that was never touched or never active', () => {
    const controller = new CiAutoIterateController();
    expect(controller.onGreen('never-seen')).toBeUndefined();
  });

  it('the attempt cap ends the loop and stays sticky across further new failures', () => {
    const controller = new CiAutoIterateController({ maxAttempts: 2, now: () => 1000 });

    expect(controller.onFailure('sess-1', 'sha-a', true).proceed).toBe(true);
    expect(controller.onFailure('sess-1', 'sha-b', true).proceed).toBe(true);

    const third = controller.onFailure('sess-1', 'sha-c', true);
    expect(third.proceed).toBe(false);
    expect(third.state).toEqual({
      active: false,
      attempts: 2,
      maxAttempts: 2,
      stoppedReason: 'max_attempts',
      // Never spent a third attempt — history stops at the cap.
      history: [
        { attempt: 1, headSha: 'sha-a', promptedAt: 1000 },
        { attempt: 2, headSha: 'sha-b', promptedAt: 1000 },
      ],
    });

    // Sticky: yet another new failure still refuses, never exceeding the cap.
    const fourth = controller.onFailure('sess-1', 'sha-d', true);
    expect(fourth.proceed).toBe(false);
    expect(fourth.state.attempts).toBe(2);
    expect(fourth.state.stoppedReason).toBe('max_attempts');
  });

  it('a user stop ends the loop immediately and stays sticky across further new failures', () => {
    const controller = new CiAutoIterateController({ now: () => 1000 });
    controller.onFailure('sess-1', 'sha-a', true);

    const stopped = controller.stopByUser('sess-1');
    expect(stopped.active).toBe(false);
    expect(stopped.stoppedReason).toBe('user_stop');

    // Even a brand-new failure, fully eligible, is refused — sticky.
    const next = controller.onFailure('sess-1', 'sha-b', true);
    expect(next.proceed).toBe(false);
    expect(next.state.stoppedReason).toBe('user_stop');
    // No new attempt was spent on the refused failure.
    expect(next.state.attempts).toBe(1);
  });

  it('a green check clears a prior user stop, letting a later new failure iterate again', () => {
    const controller = new CiAutoIterateController({ now: () => 1000 });
    controller.stopByUser('sess-1');

    const greenState = controller.onGreen('sess-1');
    expect(greenState?.stoppedReason).toBe('green');

    const { proceed } = controller.onFailure('sess-1', 'sha-a', true);
    expect(proceed).toBe(true);
  });

  it('an ineligible failure is skipped without spending an attempt, and is rechecked fresh on the next new failure', () => {
    const controller = new CiAutoIterateController({ now: () => 1000 });

    const skipped = controller.onFailure('sess-1', 'sha-a', false);
    expect(skipped.proceed).toBe(false);
    expect(skipped.state).toEqual({
      active: false,
      attempts: 0,
      maxAttempts: 5,
      stoppedReason: 'ineligible',
      history: [],
    });

    // Not sticky: the very next new failure, now eligible, proceeds normally.
    const next = controller.onFailure('sess-1', 'sha-b', true);
    expect(next.proceed).toBe(true);
    expect(next.state.attempts).toBe(1);
  });

  it('reset() clears sticky state (max attempts or a user stop) for a fresh PR watch', () => {
    const controller = new CiAutoIterateController({ maxAttempts: 1, now: () => 1000 });
    controller.onFailure('sess-1', 'sha-a', true);
    expect(controller.onFailure('sess-1', 'sha-b', true).state.stoppedReason).toBe('max_attempts');

    controller.reset('sess-1');
    const state = controller.getState('sess-1');
    expect(state).toEqual({
      active: false,
      attempts: 0,
      maxAttempts: 1,
      stoppedReason: undefined,
      history: [],
    });

    expect(controller.onFailure('sess-1', 'sha-c', true).proceed).toBe(true);
  });

  it('forget() drops all tracking; getState for an unknown session reads as a fresh, untouched loop', () => {
    const controller = new CiAutoIterateController({ maxAttempts: 3 });
    controller.onFailure('sess-1', 'sha-a', true);
    controller.forget('sess-1');

    expect(controller.getState('sess-1')).toEqual({
      active: false,
      attempts: 0,
      maxAttempts: 3,
      stoppedReason: undefined,
      history: [],
    });
  });

  it('tracks independent sessions independently', () => {
    const controller = new CiAutoIterateController({ maxAttempts: 1, now: () => 1000 });
    controller.onFailure('sess-1', 'sha-a', true);
    const secondSession = controller.onFailure('sess-2', 'sha-x', true);
    expect(secondSession.proceed).toBe(true);
    expect(secondSession.state.attempts).toBe(1);
  });

  it('defaults maxAttempts to 5', () => {
    const controller = new CiAutoIterateController();
    expect(controller.getState('sess-1').maxAttempts).toBe(5);
  });
});
