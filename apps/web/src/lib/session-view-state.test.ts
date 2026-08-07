import { describe, expect, it } from 'vitest';
import type { SessionViewStatePayloadV1 } from '@loombox/protocol';
import type { TranscriptItem, TranscriptToolCallItem } from '@loombox/providers-core/browser';
import { invalidateStaleViewState } from './session-view-state';

function toolCall(id: string): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id,
    turnId: undefined,
    title: 'Read file',
    toolKind: 'read',
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
  };
}

function payload(overrides: Partial<SessionViewStatePayloadV1> = {}): SessionViewStatePayloadV1 {
  return {
    draft: '',
    panel: { kind: 'transcript' },
    lastViewedItemId: undefined,
    ...overrides,
  };
}

describe('invalidateStaleViewState (issue #198 — Happy-inspired per-session invalidate)', () => {
  it('passes a payload with no anchor through unchanged, without even looking at items', () => {
    const items: readonly TranscriptItem[] = [];
    const value = payload({ draft: 'still typing' });
    expect(invalidateStaleViewState(value, items)).toBe(value);
  });

  it('keeps an anchor that still resolves against this device\u2019s own synced transcript', () => {
    const items: readonly TranscriptItem[] = [toolCall('a'), toolCall('b'), toolCall('c')];
    const value = payload({ lastViewedItemId: 'b' });
    expect(invalidateStaleViewState(value, items)).toEqual(value);
  });

  it('drops an anchor that no longer resolves (evicted by the resync ring, or simply never synced by this device) back to undefined, everything else untouched', () => {
    const items: readonly TranscriptItem[] = [toolCall('x'), toolCall('y')];
    const value = payload({
      draft: 'unsent prompt',
      panel: { kind: 'file', path: 'src/index.ts' },
      lastViewedItemId: 'evicted-turn',
    });

    const invalidated = invalidateStaleViewState(value, items);

    expect(invalidated.lastViewedItemId).toBeUndefined();
    expect(invalidated.draft).toBe('unsent prompt');
    expect(invalidated.panel).toEqual({ kind: 'file', path: 'src/index.ts' });
  });

  it('drops an anchor against a completely empty transcript (a device that has not resynced anything yet)', () => {
    const value = payload({ lastViewedItemId: 'turn-1' });
    expect(invalidateStaleViewState(value, []).lastViewedItemId).toBeUndefined();
  });
});
