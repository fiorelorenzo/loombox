import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  parseSessionRewindPreviewResultPayloadV1,
  parseSessionRewindResultPayloadV1,
  rewindFileChangeV1,
  rewindPreviewV1,
  rewindResultV1,
  sessionRewind,
  sessionRewindPreview,
  sessionRewindPreviewResult,
  sessionRewindResult,
} from './rewind';

const base = { protocolVersion: 1 as const, sessionId: 'sess-1', requestId: 'req-1' };
const validEnvelope = {
  resourceId: 'sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const validFileChange = { path: 'src/app.ts', action: 'restore' as const };

describe('rewindFileChangeV1', () => {
  it('parses a restore action and a delete action', () => {
    expect(rewindFileChangeV1.parse(validFileChange)).toEqual(validFileChange);
    expect(rewindFileChangeV1.parse({ path: 'new.ts', action: 'delete' })).toEqual({
      path: 'new.ts',
      action: 'delete',
    });
  });

  it('rejects an action outside restore/delete', () => {
    expect(() => rewindFileChangeV1.parse({ path: 'x.ts', action: 'modify' })).toThrow();
  });
});

describe('rewindPreviewV1', () => {
  it('parses a full preview, including which files and how many turns are at risk', () => {
    const preview = {
      turn: 1,
      checkpointId: 'cp_2',
      isWorkInPlace: false,
      turnsAtRisk: 1,
      filesAtRisk: [validFileChange],
      commitsSinceCheckpoint: 0,
    };
    expect(rewindPreviewV1.parse(preview)).toEqual(preview);
  });

  it('rejects turnsAtRisk of 0 — a valid rewind target always discards at least one turn', () => {
    expect(() =>
      rewindPreviewV1.parse({
        turn: 1,
        checkpointId: 'cp_2',
        isWorkInPlace: false,
        turnsAtRisk: 0,
        filesAtRisk: [],
        commitsSinceCheckpoint: 0,
      }),
    ).toThrow();
  });

  it('accepts turn: 0 — rewinding to before any turn ran', () => {
    const preview = {
      turn: 0,
      checkpointId: 'cp_1',
      isWorkInPlace: false,
      turnsAtRisk: 2,
      filesAtRisk: [],
      commitsSinceCheckpoint: 0,
    };
    expect(rewindPreviewV1.parse(preview)).toEqual(preview);
  });
});

describe('rewindResultV1', () => {
  it('parses what a rewind actually did', () => {
    const result = {
      turn: 1,
      checkpointId: 'cp_2',
      turnsDiscarded: 1,
      filesChanged: [validFileChange],
      discardedUncommittedChanges: true,
      commitsPreserved: 0,
    };
    expect(rewindResultV1.parse(result)).toEqual(result);
  });
});

describe('session_rewind_preview/session_rewind and their replies — wire message shapes (issue #747)', () => {
  it('accepts every message shape', () => {
    for (const message of [
      { type: 'session_rewind_preview', ...base, turn: 1 },
      { type: 'session_rewind_preview_result', ...base, envelope: validEnvelope },
      { type: 'session_rewind', ...base, turn: 1, confirm: false },
      { type: 'session_rewind_result', ...base, envelope: validEnvelope },
    ]) {
      expect(() => wireMessageV1.parse(message)).not.toThrow();
    }
  });

  it('session_rewind_preview carries turn as a plain field, no envelope', () => {
    const parsed = sessionRewindPreview.parse({
      type: 'session_rewind_preview',
      ...base,
      turn: 3,
    });
    expect(parsed.turn).toBe(3);
    expect('envelope' in parsed).toBe(false);
  });

  it('session_rewind_preview rejects a negative or non-integer turn', () => {
    expect(() =>
      sessionRewindPreview.parse({ type: 'session_rewind_preview', ...base, turn: -1 }),
    ).toThrow();
    expect(() =>
      sessionRewindPreview.parse({ type: 'session_rewind_preview', ...base, turn: 1.5 }),
    ).toThrow();
  });

  it('session_rewind requires confirm (no default) and carries turn as a plain field, no envelope', () => {
    expect(() => sessionRewind.parse({ type: 'session_rewind', ...base, turn: 1 })).toThrow();
    const parsed = sessionRewind.parse({
      type: 'session_rewind',
      ...base,
      turn: 1,
      confirm: true,
    });
    expect(parsed).toEqual({ type: 'session_rewind', ...base, turn: 1, confirm: true });
    expect('envelope' in parsed).toBe(false);
  });

  it('every *_result message requires an envelope', () => {
    for (const schema of [sessionRewindPreviewResult, sessionRewindResult]) {
      expect(() => schema.parse({ type: schema.shape.type.value, ...base })).toThrow();
      expect(() =>
        schema.parse({ type: schema.shape.type.value, ...base, envelope: validEnvelope }),
      ).not.toThrow();
    }
  });
});

describe('session_rewind_preview_result payload', () => {
  it('parses ok, carrying the preview', () => {
    const preview = {
      turn: 1,
      checkpointId: 'cp_2',
      isWorkInPlace: false,
      turnsAtRisk: 1,
      filesAtRisk: [],
      commitsSinceCheckpoint: 0,
    };
    expect(parseSessionRewindPreviewResultPayloadV1({ outcome: 'ok', preview })).toEqual({
      outcome: 'ok',
      preview,
    });
  });

  it('parses error, naming one of rewindErrorTypeV1 reasons, including the two this file adds', () => {
    for (const errorType of ['turn_not_found', 'no_live_agent', 'unsupported_target'] as const) {
      const payload = { outcome: 'error' as const, errorType, message: 'nope' };
      expect(parseSessionRewindPreviewResultPayloadV1(payload)).toEqual(payload);
    }
  });
});

describe('session_rewind_result payload — three outcomes (issue #747)', () => {
  it('parses ok, carrying what the rewind actually did', () => {
    const result = {
      turn: 1,
      checkpointId: 'cp_2',
      turnsDiscarded: 1,
      filesChanged: [validFileChange],
      discardedUncommittedChanges: true,
      commitsPreserved: 0,
    };
    expect(parseSessionRewindResultPayloadV1({ outcome: 'ok', result })).toEqual({
      outcome: 'ok',
      result,
    });
  });

  it('parses confirmation_required, carrying the same preview shape session_rewind_preview returns — reusing #805 rather than a second confirm', () => {
    const preview = {
      turn: 1,
      checkpointId: 'cp_2',
      isWorkInPlace: true,
      turnsAtRisk: 1,
      filesAtRisk: [validFileChange],
      commitsSinceCheckpoint: 0,
    };
    expect(
      parseSessionRewindResultPayloadV1({ outcome: 'confirmation_required', preview }),
    ).toEqual({ outcome: 'confirmation_required', preview });
  });

  it('parses error, naming turn_not_found for an out-of-range target', () => {
    const payload = {
      outcome: 'error' as const,
      errorType: 'turn_not_found' as const,
      message: 'session sess-1 has no turn 9 to rewind to',
    };
    expect(parseSessionRewindResultPayloadV1(payload)).toEqual(payload);
  });
});
