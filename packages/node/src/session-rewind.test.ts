import { describe, expect, it } from 'vitest';
import type { AcpTranscriptUpdate } from '@loombox/providers-core';
import type { GitCheckpoint } from '@loombox/supervisor';
import {
  AUTO_CHECKPOINT_MESSAGE_PREFIX,
  buildTurnCheckpointIndex,
  orderedTurnIds,
  parseAutoCheckpointTurnNumber,
  resolveRewindCheckpoint,
  turnIdForTurnNumber,
} from './session-rewind';

function checkpoint(message: string, id = message): GitCheckpoint {
  return {
    id,
    sessionId: 'sess_1',
    message,
    createdAt: 0,
    commit: 'c',
    baseCommit: 'b',
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasUntrackedFiles: false,
  };
}

function messageChunk(turnId: string, messageId: string, text: string): AcpTranscriptUpdate {
  return { kind: 'agent_message_chunk', turnId, messageId, text };
}

describe('parseAutoCheckpointTurnNumber', () => {
  it('parses the turn number out of an auto-checkpoint label', () => {
    expect(parseAutoCheckpointTurnNumber(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}1`)).toBe(1);
    expect(parseAutoCheckpointTurnNumber(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}42`)).toBe(42);
  });

  it('returns undefined for a manual checkpoint label', () => {
    expect(parseAutoCheckpointTurnNumber('before refactor')).toBeUndefined();
  });

  it('returns undefined for a malformed or zero/negative turn number', () => {
    expect(parseAutoCheckpointTurnNumber(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}`)).toBeUndefined();
    expect(parseAutoCheckpointTurnNumber(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}0`)).toBeUndefined();
    expect(parseAutoCheckpointTurnNumber(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}-1`)).toBeUndefined();
    expect(parseAutoCheckpointTurnNumber(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}abc`)).toBeUndefined();
  });
});

describe('buildTurnCheckpointIndex / resolveRewindCheckpoint (issue #747)', () => {
  it('maps each turn number to its own auto-checkpoint, regardless of list order', () => {
    const cp1 = checkpoint(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}1`);
    const cp2 = checkpoint(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}2`);
    const index = buildTurnCheckpointIndex([cp2, cp1]);
    expect(index.get(1)).toBe(cp1);
    expect(index.get(2)).toBe(cp2);
  });

  it('excludes manual (non-auto) checkpoints from the index', () => {
    const auto = checkpoint(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}1`);
    const manual = checkpoint('before refactor', 'manual-1');
    const index = buildTurnCheckpointIndex([auto, manual]);
    expect(index.size).toBe(1);
    expect(index.get(1)).toBe(auto);
  });

  it('resolveRewindCheckpoint(turn) is the checkpoint before turn + 1 — keeps turn N, discards later ones', () => {
    const cp1 = checkpoint(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}1`);
    const cp2 = checkpoint(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}2`);
    const cp3 = checkpoint(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}3`);
    const checkpoints = [cp1, cp2, cp3];

    expect(resolveRewindCheckpoint(checkpoints, 0)).toBe(cp1); // before any turn ran
    expect(resolveRewindCheckpoint(checkpoints, 1)).toBe(cp2); // keeps turn 1's effects
    expect(resolveRewindCheckpoint(checkpoints, 2)).toBe(cp3); // keeps turns 1-2's effects
  });

  it('resolveRewindCheckpoint is undefined when there is nothing to rewind to (at or past the latest turn, or turn 0 with no checkpoint yet)', () => {
    const checkpoints = [checkpoint(`${AUTO_CHECKPOINT_MESSAGE_PREFIX}1`)];
    expect(resolveRewindCheckpoint(checkpoints, 1)).toBeUndefined(); // turn 1 is the latest — nothing after it
    expect(resolveRewindCheckpoint([], 0)).toBeUndefined(); // no auto-checkpoint taken yet at all
  });
});

describe('orderedTurnIds / turnIdForTurnNumber', () => {
  it('collects distinct turnIds in first-appearance order', () => {
    const updates = [
      messageChunk('turn:1', 'm1', 'a'),
      messageChunk('turn:1', 'm1', 'b'),
      messageChunk('turn:2', 'm2', 'c'),
    ];
    expect(orderedTurnIds(updates)).toEqual(['turn:1', 'turn:2']);
    expect(turnIdForTurnNumber(updates, 1)).toBe('turn:1');
    expect(turnIdForTurnNumber(updates, 2)).toBe('turn:2');
  });

  it('is undefined for a turn number the transcript never reached', () => {
    const updates = [messageChunk('turn:1', 'm1', 'a')];
    expect(turnIdForTurnNumber(updates, 2)).toBeUndefined();
  });

  it('is empty/undefined for an empty transcript', () => {
    expect(orderedTurnIds([])).toEqual([]);
    expect(turnIdForTurnNumber([], 1)).toBeUndefined();
  });
});
