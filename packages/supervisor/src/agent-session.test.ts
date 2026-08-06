import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpTranscriptUpdate } from '@loombox/providers-core';

import { AgentSession } from './agent-session';
import { TranscriptStore } from './transcript-store';

/**
 * `seedTranscriptUpdates` (design spec `2026-08-05-zed-parity-decisions.md`
 * §3's C6-2; issue #746) is exercised through `fromPersisted()` rather than
 * `spawn()` — no live child process needed for a method that only touches
 * the in-memory cache and the on-disk log, and `fromPersisted()`'s own
 * `sessionId` is set synchronously (unlike `spawn()`'s, which resolves only
 * after a real ACP handshake).
 */
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-agent-session-test-'));
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
  turnId: 'turn:2',
  messageId: 'm2',
  text: 'World',
};

describe('AgentSession.seedTranscriptUpdates (issue #746)', () => {
  it('appends the seeded updates onto getTranscriptUpdates(), after whatever the session already had', () => {
    const store = new TranscriptStore({ stateDir });
    const session = AgentSession.fromPersisted(
      {
        v: 1,
        sessionId: 'sess_fork_target',
        providerId: 'claude',
        workspacePath: '/tmp/ws',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attention: { status: 'awaiting_input', updatedAt: new Date().toISOString() },
      },
      [CHUNK_A],
      store,
    );

    session.seedTranscriptUpdates([CHUNK_B]);

    expect(session.getTranscriptUpdates()).toEqual([CHUNK_A, CHUNK_B]);
  });

  it('persists every seeded update to the store, so a later restart replays it too', () => {
    const store = new TranscriptStore({ stateDir });
    store.createSession({
      sessionId: 'sess_fork_target',
      providerId: 'claude',
      workspacePath: '/tmp/ws',
    });
    const session = AgentSession.fromPersisted(store.readMeta('sess_fork_target')!, [], store);

    session.seedTranscriptUpdates([CHUNK_A, CHUNK_B]);

    expect(store.readTranscriptUpdates('sess_fork_target')).toEqual([CHUNK_A, CHUNK_B]);
  });

  it('never emits transcript_update — a caller replaying seeded history onward drives that itself', () => {
    const store = new TranscriptStore({ stateDir });
    const session = AgentSession.fromPersisted(
      {
        v: 1,
        sessionId: 'sess_fork_target',
        providerId: 'claude',
        workspacePath: '/tmp/ws',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attention: { status: 'awaiting_input', updatedAt: new Date().toISOString() },
      },
      [],
      store,
    );
    const seen: AcpTranscriptUpdate[] = [];
    session.on('transcript_update', (update: AcpTranscriptUpdate) => seen.push(update));

    session.seedTranscriptUpdates([CHUNK_A]);

    expect(seen).toEqual([]);
  });

  it('is a no-op on getTranscriptUpdates() for an empty seed list', () => {
    const store = new TranscriptStore({ stateDir });
    const session = AgentSession.fromPersisted(
      {
        v: 1,
        sessionId: 'sess_fork_target',
        providerId: 'claude',
        workspacePath: '/tmp/ws',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attention: { status: 'awaiting_input', updatedAt: new Date().toISOString() },
      },
      [CHUNK_A],
      store,
    );

    session.seedTranscriptUpdates([]);

    expect(session.getTranscriptUpdates()).toEqual([CHUNK_A]);
  });
});
