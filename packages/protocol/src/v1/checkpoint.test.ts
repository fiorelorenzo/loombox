import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  checkpointCreate,
  checkpointList,
  checkpointListResult,
  checkpointResult,
  checkpointRestore,
  checkpointRestorePreview,
  checkpointRestorePreviewResult,
  checkpointRestoreResult,
  gitCheckpointV1,
  parseCheckpointCreatePayloadV1,
  parseCheckpointListResultPayloadV1,
  parseCheckpointResultPayloadV1,
  parseCheckpointRestorePreviewResultPayloadV1,
  parseCheckpointRestoreResultPayloadV1,
  restorePreviewV1,
  restoreResultV1,
  safeParseCheckpointListResultPayloadV1,
} from './checkpoint';

const base = { protocolVersion: 1 as const, sessionId: 'sess-1', requestId: 'req-1' };
const validEnvelope = {
  resourceId: 'sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const validCheckpoint = {
  id: 'cp_1',
  sessionId: 'sess-1',
  message: 'before refactor',
  createdAt: 1700000000000,
  commit: 'abc123',
  baseCommit: 'def456',
  hasStagedChanges: false,
  hasUnstagedChanges: true,
  hasUntrackedFiles: false,
  isWorkInPlace: false,
};

describe('gitCheckpointV1', () => {
  it('parses a full checkpoint record', () => {
    expect(gitCheckpointV1.parse(validCheckpoint)).toEqual(validCheckpoint);
  });
});

describe('restorePreviewV1', () => {
  it('parses a preview with something to discard', () => {
    const preview = {
      checkpointId: 'cp_1',
      commitsSinceCheckpoint: 2,
      hasUncommittedChangesToDiscard: true,
      isWorkInPlace: true,
    };
    expect(restorePreviewV1.parse(preview)).toEqual(preview);
  });
});

describe('restoreResultV1', () => {
  it('parses what a restore actually did', () => {
    const result = { checkpointId: 'cp_1', discardedUncommittedChanges: true, commitsPreserved: 3 };
    expect(restoreResultV1.parse(result)).toEqual(result);
  });
});

describe('checkpoint_create/_list/_restore_preview/_restore and their replies — wire message shapes (issue #603)', () => {
  it('accepts every message shape', () => {
    for (const message of [
      { type: 'checkpoint_create', ...base, envelope: validEnvelope },
      { type: 'checkpoint_result', ...base, envelope: validEnvelope },
      { type: 'checkpoint_list', ...base },
      { type: 'checkpoint_list_result', ...base, envelope: validEnvelope },
      { type: 'checkpoint_restore_preview', ...base, checkpointId: 'cp_1' },
      { type: 'checkpoint_restore_preview_result', ...base, envelope: validEnvelope },
      { type: 'checkpoint_restore', ...base, checkpointId: 'cp_1', confirm: false },
      { type: 'checkpoint_restore_result', ...base, envelope: validEnvelope },
    ]) {
      expect(() => wireMessageV1.parse(message)).not.toThrow();
    }
  });

  it('rejects checkpoint_create with no envelope (a label must round-trip encrypted)', () => {
    expect(() => checkpointCreate.parse({ type: 'checkpoint_create', ...base })).toThrow();
  });

  it('checkpoint_list carries no envelope at all — asking carries no content', () => {
    const parsed = checkpointList.parse({ type: 'checkpoint_list', ...base });
    expect('envelope' in parsed).toBe(false);
  });

  it('checkpoint_restore_preview carries checkpointId as a plain field, no envelope', () => {
    const parsed = checkpointRestorePreview.parse({
      type: 'checkpoint_restore_preview',
      ...base,
      checkpointId: 'cp_1',
    });
    expect(parsed.checkpointId).toBe('cp_1');
    expect('envelope' in parsed).toBe(false);
  });

  it('checkpoint_restore requires confirm (no default) and carries checkpointId as a plain field, no envelope', () => {
    expect(() =>
      checkpointRestore.parse({ type: 'checkpoint_restore', ...base, checkpointId: 'cp_1' }),
    ).toThrow();
    const parsed = checkpointRestore.parse({
      type: 'checkpoint_restore',
      ...base,
      checkpointId: 'cp_1',
      confirm: true,
    });
    expect(parsed).toEqual({
      type: 'checkpoint_restore',
      ...base,
      checkpointId: 'cp_1',
      confirm: true,
    });
    expect('envelope' in parsed).toBe(false);
  });

  it('every *_result message requires an envelope', () => {
    for (const schema of [
      checkpointResult,
      checkpointListResult,
      checkpointRestorePreviewResult,
      checkpointRestoreResult,
    ]) {
      expect(() => schema.parse({ type: schema.shape.type.value, ...base })).toThrow();
      expect(() =>
        schema.parse({ type: schema.shape.type.value, ...base, envelope: validEnvelope }),
      ).not.toThrow();
    }
  });
});

describe('checkpoint_result payload', () => {
  it('parses an ok outcome carrying the new checkpoint', () => {
    const payload = { outcome: 'ok' as const, checkpoint: validCheckpoint };
    expect(parseCheckpointResultPayloadV1(payload)).toEqual(payload);
  });

  it('parses an error outcome', () => {
    const payload = {
      outcome: 'error' as const,
      errorType: 'dirty_submodule' as const,
      message: 'submodule has uncommitted state',
    };
    expect(parseCheckpointResultPayloadV1(payload)).toEqual(payload);
  });
});

describe('checkpoint_list_result payload', () => {
  it('parses an ok outcome carrying zero or more checkpoints', () => {
    expect(parseCheckpointListResultPayloadV1({ outcome: 'ok', checkpoints: [] })).toEqual({
      outcome: 'ok',
      checkpoints: [],
    });
    expect(
      parseCheckpointListResultPayloadV1({ outcome: 'ok', checkpoints: [validCheckpoint] }),
    ).toEqual({ outcome: 'ok', checkpoints: [validCheckpoint] });
  });

  it('safeParse returns a failed result on garbage rather than throwing', () => {
    const result = safeParseCheckpointListResultPayloadV1({ outcome: 'ok', checkpoints: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('checkpoint_restore_preview_result payload', () => {
  it('parses an ok outcome carrying the preview', () => {
    const preview = {
      checkpointId: 'cp_1',
      commitsSinceCheckpoint: 0,
      hasUncommittedChangesToDiscard: true,
      isWorkInPlace: false,
    };
    expect(parseCheckpointRestorePreviewResultPayloadV1({ outcome: 'ok', preview })).toEqual({
      outcome: 'ok',
      preview,
    });
  });
});

describe('checkpoint_restore_result payload — three outcomes (issue #603)', () => {
  it('parses ok, carrying what the restore actually did', () => {
    const result = { checkpointId: 'cp_1', discardedUncommittedChanges: true, commitsPreserved: 1 };
    expect(parseCheckpointRestoreResultPayloadV1({ outcome: 'ok', result })).toEqual({
      outcome: 'ok',
      result,
    });
  });

  it('parses confirmation_required, carrying the preview a client must show before retrying with confirm: true', () => {
    const preview = {
      checkpointId: 'cp_1',
      commitsSinceCheckpoint: 0,
      hasUncommittedChangesToDiscard: true,
      isWorkInPlace: true,
    };
    expect(
      parseCheckpointRestoreResultPayloadV1({ outcome: 'confirmation_required', preview }),
    ).toEqual({ outcome: 'confirmation_required', preview });
  });

  it('parses error, naming one of the checkpointErrorTypeV1 reasons', () => {
    const payload = {
      outcome: 'error' as const,
      errorType: 'checkpoint_not_found' as const,
      message: 'no checkpoint "cp_missing" for session sess-1',
    };
    expect(parseCheckpointRestoreResultPayloadV1(payload)).toEqual(payload);
  });
});

describe('checkpoint_create payload', () => {
  it('parses an optional, trimmed label', () => {
    expect(parseCheckpointCreatePayloadV1({})).toEqual({});
    expect(parseCheckpointCreatePayloadV1({ message: '  before refactor  ' })).toEqual({
      message: 'before refactor',
    });
  });

  it('rejects a blank label rather than saving an empty string', () => {
    expect(() => parseCheckpointCreatePayloadV1({ message: '   ' })).toThrow();
  });
});
