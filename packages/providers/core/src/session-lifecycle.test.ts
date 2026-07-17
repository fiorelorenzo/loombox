import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';
import { createTranscriptState, reduceTranscript } from './transcript';
import type { AcpMessageChunkUpdate, AcpToolCallUpdate, AcpTranscriptUpdate } from './types';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'resumable-acp-agent.mjs',
);

let activeClients: AcpClient[] = [];

function makeClient(): AcpClient {
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH] });
  activeClients.push(client);
  return client;
}

afterEach(() => {
  for (const client of activeClients) client.close();
  activeClients = [];
});

describe('AcpClient: session/resume + replay (issue #176)', () => {
  it('rounds-trips a resumed session with no duplicated or dropped items across an intentional gap', async () => {
    const client = makeClient();
    await client.initialize();

    const sessionId = await client.resumeSession('sess_resume_prior', '/tmp/loombox-resume-test');

    // The fixture streams: chunk "before-gap " (m1), a completed tool_call,
    // then a further chunk "after-gap" continuing the SAME message id — the
    // "gap" a client that wasn't listening in between must still coalesce
    // correctly, with nothing duplicated and nothing dropped.
    const history = client.getHistory(sessionId);
    expect(history).toHaveLength(3);
    expect(history.filter((u) => u.kind === 'tool_call')).toHaveLength(1);
    expect(history.filter((u) => u.kind === 'agent_message_chunk')).toHaveLength(2);

    const state = client.getTranscriptState(sessionId);
    expect(state.items).toHaveLength(2); // one coalesced message + one tool call, not three separate rows

    const message = state.items.find((item) => item.type === 'message');
    expect(message).toMatchObject({ text: 'before-gap after-gap' });

    const toolCall = state.items.find((item) => item.type === 'tool_call');
    expect(toolCall).toMatchObject({ id: 'tc1', status: 'completed' });
  });

  it('re-emits the buffered history via replay() so a late-attaching listener catches up', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.resumeSession('sess_resume_prior', '/tmp/loombox-resume-test');

    // A consumer that attaches only now (after resume already happened).
    const caughtUp: unknown[] = [];
    client.on('transcript_update', (payload: unknown) => caughtUp.push(payload));
    client.replay(sessionId);

    expect(caughtUp).toHaveLength(3);
  });

  it('does not re-store or re-reduce anything on replay (calling it twice does not double history)', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.resumeSession('sess_resume_prior', '/tmp/loombox-resume-test');

    client.replay(sessionId);
    client.replay(sessionId);

    expect(client.getHistory(sessionId)).toHaveLength(3);
  });
});

describe('AcpClient: session/list (issue #176)', () => {
  it('returns the canned roster the agent reports', async () => {
    const client = makeClient();
    await client.initialize();

    const sessions = await client.listSessions();
    expect(sessions).toEqual([
      { sessionId: 'sess_list_1', cwd: '/tmp/loombox-a', title: 'Alpha' },
      { sessionId: 'sess_list_2', cwd: '/tmp/loombox-b' },
    ]);
  });
});

describe('AcpClient: cancellation (issue #176 / #178)', () => {
  it('cancel() sends session/cancel and optimistically resolves every open permission request for that session', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-cancel-test');

    // Simulate a pending permission request for this session (independent of
    // the wire — PermissionQueue is exercised end-to-end in
    // permission-integration.test.ts).
    client.permissions.enqueue({
      requestId: 'r1',
      sessionId,
      toolCall: { kind: 'tool_call', id: 'tc1' },
      options: [],
    });

    const resolved: unknown[] = [];
    client.permissions.on('resolved', (result: unknown) => resolved.push(result));

    client.cancel(sessionId);

    expect(client.permissions.list(sessionId)).toEqual([]);
    expect(resolved).toEqual([
      { status: 'resolved', requestId: 'r1', sessionId, outcome: { outcome: 'cancelled' } },
    ]);
  });
});

describe('the v1 transcript reducer: live vs. replay equivalence (SPEC.md §7.24)', () => {
  it('produces the same in-memory state whether updates are applied one at a time (live) or replayed as one buffered batch', () => {
    const updates: AcpTranscriptUpdate[] = [
      { kind: 'agent_thought_chunk', turnId: 't1', messageId: 'thought1', text: 'thinking' },
      {
        kind: 'agent_message_chunk',
        turnId: 't1',
        messageId: 'm1',
        text: 'Hello',
      } as AcpMessageChunkUpdate,
      {
        kind: 'agent_message_chunk',
        turnId: 't1',
        messageId: 'm1',
        text: ' world',
      } as AcpMessageChunkUpdate,
      {
        kind: 'tool_call',
        id: 'tc1',
        turnId: 't1',
        title: 'Search',
        status: 'completed',
      } as AcpToolCallUpdate,
      { kind: 'plan_update', entries: [{ content: 'step 1', status: 'completed' }] },
    ];

    // Live: fold updates in one at a time, as AcpClient's notification
    // handler does as each 'session/update' line arrives.
    let liveState = createTranscriptState();
    for (const update of updates) {
      liveState = reduceTranscript(liveState, update);
    }

    // Replay: fold the exact same buffered array in one batch, as a
    // reconnecting consumer would process a persisted transcript.
    const replayedState = updates.reduce(reduceTranscript, createTranscriptState());

    expect(replayedState).toEqual(liveState);
  });
});
