import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpTranscriptUpdate } from '@loombox/providers-core';

import { TRANSCRIPT_SCHEMA_VERSION, TranscriptStore } from './transcript-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-transcript-store-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const CHUNK_A: AcpTranscriptUpdate = {
  kind: 'agent_message_chunk',
  turnId: 'turn:1',
  messageId: 'm1',
  text: 'Hello',
};
const CHUNK_B: AcpTranscriptUpdate = {
  kind: 'agent_message_chunk',
  turnId: 'turn:1',
  messageId: 'm1',
  text: ' world',
};

describe('TranscriptStore', () => {
  it('creates a versioned session directory with metadata and an empty log', () => {
    const store = new TranscriptStore({ stateDir });

    const meta = store.createSession({
      sessionId: 'sess_1',
      providerId: 'test-echo',
      workspacePath: '/tmp/ws',
    });

    expect(meta.v).toBe(TRANSCRIPT_SCHEMA_VERSION);
    expect(meta.sessionId).toBe('sess_1');
    expect(meta.providerId).toBe('test-echo');
    expect(meta.attention.status).toBe('working');
    expect(store.readLog('sess_1')).toEqual([]);
    expect(store.listSessionIds()).toEqual(['sess_1']);
  });

  it('appends transcript updates and turn_end in order, each versioned, and readLog reconstructs the sequence', () => {
    const store = new TranscriptStore({ stateDir });
    store.createSession({ sessionId: 'sess_1', providerId: 'test-echo', workspacePath: '/tmp/ws' });

    store.appendTranscriptUpdate('sess_1', CHUNK_A);
    store.appendTranscriptUpdate('sess_1', CHUNK_B);
    store.appendTurnEnd('sess_1', { messageId: 'm1', stopReason: 'end_turn' });

    const log = store.readLog('sess_1');
    expect(log).toHaveLength(3);
    expect(log.every((entry) => entry.v === TRANSCRIPT_SCHEMA_VERSION)).toBe(true);
    expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(log[0]).toMatchObject({ type: 'transcript_update', update: CHUNK_A });
    expect(log[1]).toMatchObject({ type: 'transcript_update', update: CHUNK_B });
    expect(log[2]).toMatchObject({
      type: 'turn_end',
      turnEnd: { messageId: 'm1', stopReason: 'end_turn' },
    });

    expect(store.readTranscriptUpdates('sess_1')).toEqual([CHUNK_A, CHUNK_B]);
  });

  it('appendAttention appends a log entry AND updates session.json to the same snapshot', () => {
    const store = new TranscriptStore({ stateDir });
    store.createSession({ sessionId: 'sess_1', providerId: 'test-echo', workspacePath: '/tmp/ws' });

    store.appendAttention('sess_1', {
      status: 'permission_required',
      updatedAt: '2026-01-01T00:00:00.000Z',
      detail: { requestId: 'perm:1' },
    });

    const log = store.readLog('sess_1');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: 'attention',
      attention: { status: 'permission_required' },
    });

    const meta = store.readMeta('sess_1');
    expect(meta?.attention.status).toBe('permission_required');
    expect(meta?.attention.detail).toEqual({ requestId: 'perm:1' });
  });

  it('a fresh TranscriptStore instance pointed at the same stateDir reloads the same log and metadata, and continues seq numbering correctly', () => {
    const storeA = new TranscriptStore({ stateDir });
    storeA.createSession({
      sessionId: 'sess_1',
      providerId: 'test-echo',
      workspacePath: '/tmp/ws',
    });
    storeA.appendTranscriptUpdate('sess_1', CHUNK_A);
    storeA.appendAttention('sess_1', {
      status: 'awaiting_input',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });

    // Simulates a supervisor process restart: a brand new store instance, same directory on disk.
    const storeB = new TranscriptStore({ stateDir });
    expect(storeB.listSessionIds()).toEqual(['sess_1']);
    expect(storeB.readLog('sess_1')).toEqual(storeA.readLog('sess_1'));
    expect(storeB.readMeta('sess_1')?.attention.status).toBe('awaiting_input');

    // Continuing to append from the reloaded store must not reuse seq 1.
    storeB.appendTranscriptUpdate('sess_1', CHUNK_B);
    const log = storeB.readLog('sess_1');
    expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it('readLog drops a trailing corrupt/partial line instead of throwing', async () => {
    const store = new TranscriptStore({ stateDir });
    store.createSession({ sessionId: 'sess_1', providerId: 'test-echo', workspacePath: '/tmp/ws' });
    store.appendTranscriptUpdate('sess_1', CHUNK_A);

    const { appendFile } = await import('node:fs/promises');
    await appendFile(path.join(stateDir, 'sess_1', 'log.jsonl'), '{"v":1,"type":"transcript_up');

    const log = store.readLog('sess_1');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: 'transcript_update', update: CHUNK_A });
  });

  it('listSessionIds is empty for a stateDir that does not exist yet', () => {
    const store = new TranscriptStore({ stateDir: path.join(stateDir, 'not-created') });
    expect(store.listSessionIds()).toEqual([]);
  });

  describe('truncateTranscriptUpdates (design spec C6-3; issue #747)', () => {
    it('keeps entries through the Nth transcript_update plus its own turn_end, and drops everything after', () => {
      const store = new TranscriptStore({ stateDir });
      store.createSession({
        sessionId: 'sess_1',
        providerId: 'test-echo',
        workspacePath: '/tmp/ws',
      });

      store.appendTranscriptUpdate('sess_1', CHUNK_A); // turn 1, seq 1
      store.appendTurnEnd('sess_1', { messageId: 'm1', stopReason: 'end_turn' }); // seq 2
      const turn2Chunk: AcpTranscriptUpdate = { ...CHUNK_A, turnId: 'turn:2', messageId: 'm2' };
      store.appendTranscriptUpdate('sess_1', turn2Chunk); // turn 2, seq 3
      store.appendTurnEnd('sess_1', { messageId: 'm2', stopReason: 'end_turn' }); // seq 4

      store.truncateTranscriptUpdates('sess_1', 1);

      const log = store.readLog('sess_1');
      expect(log).toHaveLength(2);
      expect(log.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(store.readTranscriptUpdates('sess_1')).toEqual([CHUNK_A]);
    });

    it('continues seq numbering from the truncated tail, never the discarded entries', () => {
      const store = new TranscriptStore({ stateDir });
      store.createSession({
        sessionId: 'sess_1',
        providerId: 'test-echo',
        workspacePath: '/tmp/ws',
      });
      store.appendTranscriptUpdate('sess_1', CHUNK_A);
      store.appendTranscriptUpdate('sess_1', CHUNK_B);

      store.truncateTranscriptUpdates('sess_1', 1);
      store.appendTranscriptUpdate('sess_1', CHUNK_B);

      const log = store.readLog('sess_1');
      expect(log.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(store.readTranscriptUpdates('sess_1')).toEqual([CHUNK_A, CHUNK_B]);
    });

    it('a fresh instance pointed at the same stateDir sees the truncated log, not the discarded tail', () => {
      const storeA = new TranscriptStore({ stateDir });
      storeA.createSession({
        sessionId: 'sess_1',
        providerId: 'test-echo',
        workspacePath: '/tmp/ws',
      });
      storeA.appendTranscriptUpdate('sess_1', CHUNK_A);
      storeA.appendTranscriptUpdate('sess_1', CHUNK_B);
      storeA.truncateTranscriptUpdates('sess_1', 1);

      const storeB = new TranscriptStore({ stateDir });
      expect(storeB.readTranscriptUpdates('sess_1')).toEqual([CHUNK_A]);
    });

    it('keepCount 0 truncates to an empty log', () => {
      const store = new TranscriptStore({ stateDir });
      store.createSession({
        sessionId: 'sess_1',
        providerId: 'test-echo',
        workspacePath: '/tmp/ws',
      });
      store.appendTranscriptUpdate('sess_1', CHUNK_A);
      store.appendTurnEnd('sess_1', { messageId: 'm1', stopReason: 'end_turn' });

      store.truncateTranscriptUpdates('sess_1', 0);

      expect(store.readLog('sess_1')).toEqual([]);
      expect(store.readTranscriptUpdates('sess_1')).toEqual([]);
    });

    it('is a no-op for a session with no persisted log yet', () => {
      const store = new TranscriptStore({ stateDir });
      expect(() => store.truncateTranscriptUpdates('sess_missing', 0)).not.toThrow();
      expect(store.readLog('sess_missing')).toEqual([]);
    });
  });
});
