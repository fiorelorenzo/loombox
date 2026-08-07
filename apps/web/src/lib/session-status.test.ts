import { describe, expect, it } from 'vitest';

import { sessionStatusLabelWithReason, SESSION_STATUS_UNKNOWN_LABEL } from './session-status';

describe('sessionStatusLabelWithReason', () => {
  it('returns the unknown-status label when status is undefined, regardless of reason', () => {
    expect(sessionStatusLabelWithReason(undefined, 'anything')).toBe(SESSION_STATUS_UNKNOWN_LABEL);
  });

  it('returns the bare label when there is no reason', () => {
    expect(sessionStatusLabelWithReason('working', undefined)).toBe('Working');
    expect(sessionStatusLabelWithReason('error', undefined)).toBe('Error');
  });

  it('appends a reason for the original three statuses (error/paused/queued, issues #730/#251/#255)', () => {
    expect(sessionStatusLabelWithReason('error', 'spawn failed')).toBe('Error: spawn failed');
    expect(sessionStatusLabelWithReason('paused', 'Spend cap reached: $12.50 of $10.00')).toBe(
      'Paused: Spend cap reached: $12.50 of $10.00',
    );
    expect(sessionStatusLabelWithReason('queued', 'position 2 of 3 waiting for a slot')).toBe(
      'Queued: position 2 of 3 waiting for a slot',
    );
  });

  it('appends a reason for "exited" (issue #271: a mid-session crash\'s exit code)', () => {
    expect(sessionStatusLabelWithReason('exited', 'agent process exited (exit code 1)')).toBe(
      'Exited: agent process exited (exit code 1)',
    );
  });

  it('appends a reason for the "still active" statuses issue #271\'s stall diagnosis targets', () => {
    expect(
      sessionStatusLabelWithReason('working', 'target unreachable — last checked 30s ago'),
    ).toBe('Working: target unreachable — last checked 30s ago');
    expect(
      sessionStatusLabelWithReason('starting', 'target unreachable — last checked 30s ago'),
    ).toBe('Starting…: target unreachable — last checked 30s ago');
    expect(
      sessionStatusLabelWithReason('awaiting_input', 'target unreachable — last checked 30s ago'),
    ).toBe('Awaiting you: target unreachable — last checked 30s ago');
    expect(
      sessionStatusLabelWithReason(
        'permission_required',
        'target unreachable — last checked 30s ago',
      ),
    ).toBe('Needs permission: target unreachable — last checked 30s ago');
  });

  it('appends a reason for "disconnected" (issue #271: the agent process did not survive a node restart)', () => {
    expect(sessionStatusLabelWithReason('disconnected', 'resume it to continue')).toBe(
      'Disconnected: resume it to continue',
    );
  });

  it('never fabricates text when the caller passes no reason, even for a now-eligible status — the plain label is exactly what it was before issue #271', () => {
    expect(sessionStatusLabelWithReason('working', undefined)).toBe('Working');
    expect(sessionStatusLabelWithReason('starting', undefined)).toBe('Starting…');
    expect(sessionStatusLabelWithReason('disconnected', undefined)).toBe('Disconnected');
  });
});
