import { describe, expect, it } from 'vitest';

import { reasonForAttentionState } from './attention-reason';

describe('reasonForAttentionState (issue #271)', () => {
  it('reads the crash message off an error detail', () => {
    expect(reasonForAttentionState({ status: 'error', detail: { message: 'boom' } })).toBe('boom');
  });

  it('names the exit code off an exited detail', () => {
    expect(reasonForAttentionState({ status: 'exited', detail: { code: 1 } })).toBe(
      'agent process exited (exit code 1)',
    );
  });

  it('reports "unknown" for an exited detail with no numeric code (e.g. killed by signal, code null)', () => {
    expect(reasonForAttentionState({ status: 'exited', detail: { code: null } })).toBe(
      'agent process exited (exit code unknown)',
    );
    expect(reasonForAttentionState({ status: 'exited', detail: undefined })).toBe(
      'agent process exited (exit code unknown)',
    );
  });

  it('still names exit code 0 (a clean exit is still a fact worth stating, never suppressed as "nothing to say")', () => {
    expect(reasonForAttentionState({ status: 'exited', detail: { code: 0 } })).toBe(
      'agent process exited (exit code 0)',
    );
  });

  it('returns undefined for an error detail with no usable message rather than inventing one', () => {
    expect(reasonForAttentionState({ status: 'error', detail: {} })).toBeUndefined();
    expect(reasonForAttentionState({ status: 'error', detail: { message: '' } })).toBeUndefined();
    expect(reasonForAttentionState({ status: 'error', detail: undefined })).toBeUndefined();
  });

  it('returns undefined for every other status — never fabricates a reason for a normal transition', () => {
    expect(reasonForAttentionState({ status: 'working' })).toBeUndefined();
    expect(reasonForAttentionState({ status: 'awaiting_input' })).toBeUndefined();
    expect(
      reasonForAttentionState({ status: 'permission_required', detail: { requestId: 'r1' } }),
    ).toBeUndefined();
  });
});
