import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  PROTOCOL_VERSION,
  type PromptInject,
  type SessionMeta,
  type WireMessage,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { reduceTranscript, RelayClient } from './relay-client';

/**
 * Stands in for the orchestrator node in packages/node/src/node-daemon.ts,
 * driven directly from the test instead of through a real supervisor/agent
 * (this suite is about the PWA client's reduction logic, not the agent
 * pipeline — that's covered by packages/node's own tests and
 * scripts/v0-e2e-harness.mjs's full loop). Speaks the node side of the wire
 * protocol: `node_hello`, `session_announce`, `session_update`, and receives
 * `prompt_inject`.
 */
class FakeNode {
  readonly received: WireMessage[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, nodeId: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve) => {
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({ type: 'node_hello', protocolVersion: PROTOCOL_VERSION, nodeId }),
        );
        resolve();
      });
    });
    this.socket.addEventListener('message', (event) => {
      this.received.push(JSON.parse(String(event.data)) as WireMessage);
    });
  }

  send(message: WireMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: WireMessage) => boolean,
    timeoutMs = 3000,
  ): Promise<WireMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('FakeNode: timed out waiting for a message');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }
}

function makeSessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    projectPath: '/home/dev/project',
    worktreePath: '/home/dev/project/.loombox/worktrees/sess_1',
    target: 'local',
    provider: 'claude',
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Waits until `predicate(get(store))` is true, or times out. */
async function waitForStore<T>(
  store: { subscribe: (run: (value: T) => void) => () => void },
  predicate: (value: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get(store);
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error('waitForStore: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let relay: StartedRelay;
let node: FakeNode | undefined;
let client: RelayClient | undefined;

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  client?.close();
  node?.close();
  client = undefined;
  node = undefined;
  await relay.close();
});

describe('reduceTranscript (pure reducer)', () => {
  it('appends a new entry on first sight of a messageId', () => {
    const entries = reduceTranscript([], {
      kind: 'agent_message_chunk',
      messageId: 'm1',
      text: 'Hello',
    });
    expect(entries).toEqual([{ id: 'm1', role: 'agent', text: 'Hello', done: false }]);
  });

  it('accumulates chunks by messageId in order', () => {
    let entries = reduceTranscript([], {
      kind: 'agent_message_chunk',
      messageId: 'm1',
      text: 'Hello',
    });
    entries = reduceTranscript(entries, {
      kind: 'agent_message_chunk',
      messageId: 'm1',
      text: ' world',
    });
    expect(entries).toEqual([{ id: 'm1', role: 'agent', text: 'Hello world', done: false }]);
  });

  it('keeps user and agent chunks as distinct entries even with different messageIds', () => {
    let entries = reduceTranscript([], { kind: 'user_message_chunk', messageId: 'u1', text: 'hi' });
    entries = reduceTranscript(entries, {
      kind: 'agent_message_chunk',
      messageId: 'm1',
      text: 'hey',
    });
    expect(entries).toEqual([
      { id: 'u1', role: 'user', text: 'hi', done: false },
      { id: 'm1', role: 'agent', text: 'hey', done: false },
    ]);
  });

  it('marks an entry done on agent_turn_end without altering its text', () => {
    let entries = reduceTranscript([], {
      kind: 'agent_message_chunk',
      messageId: 'm1',
      text: 'Hi',
    });
    entries = reduceTranscript(entries, { kind: 'agent_turn_end', messageId: 'm1' });
    expect(entries).toEqual([{ id: 'm1', role: 'agent', text: 'Hi', done: true }]);
  });

  it('appends a standalone entry for an error update', () => {
    const entries = reduceTranscript([], { kind: 'error', message: 'agent crashed' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role: 'error', text: 'agent crashed', done: true });
  });
});

// TODO(v1 Wave D, client v1): these exercise the v0 relay wire, which #321
// (relay v1) superseded. Rewrite against the protocol v1 wire when RelayClient
// migrates to it, then un-skip. The pure reduceTranscript tests above still run.
describe.skip('RelayClient', () => {
  it('connects, sends client_hello, and surfaces the initial session_list snapshot', async () => {
    client = new RelayClient({ relayUrl: relay.url, clientId: 'client-1' });
    client.connect();

    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, () => true); // snapshot arrives right after client_hello
    expect(get(client.sessions)).toEqual([]);
  });

  it('surfaces a session announced by a node after connecting, alongside the snapshot', async () => {
    node = new FakeNode(relay.url, 'node-1');
    await node.ready;

    client = new RelayClient({ relayUrl: relay.url, clientId: 'client-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const session = makeSessionMeta({ id: 'sess_announced' });
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_VERSION, session });

    const sessions = await waitForStore(client.sessions, (value) => value.length > 0);
    expect(sessions).toEqual([session]);
  });

  it('reduces two agent_message_chunk updates with the same messageId into one appended transcript entry', async () => {
    node = new FakeNode(relay.url, 'node-2');
    await node.ready;

    client = new RelayClient({ relayUrl: relay.url, clientId: 'client-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const session = makeSessionMeta({ id: 'sess_transcript' });
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_VERSION, session });
    await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);

    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.id,
      update: { kind: 'agent_message_chunk', messageId: 'msg_1', text: 'Hello' },
    });
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.id,
      update: { kind: 'agent_message_chunk', messageId: 'msg_1', text: ' world' },
    });

    const entries = await waitForStore(transcript, (value) => value[0]?.text === 'Hello world');
    expect(entries).toEqual([{ id: 'msg_1', role: 'agent', text: 'Hello world', done: false }]);

    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.id,
      update: { kind: 'agent_turn_end', messageId: 'msg_1' },
    });
    const done = await waitForStore(transcript, (value) => value[0]?.done === true);
    expect(done).toEqual([{ id: 'msg_1', role: 'agent', text: 'Hello world', done: true }]);
  });

  it('sendPrompt appends the user turn locally and makes the relay route a prompt_inject to the node', async () => {
    node = new FakeNode(relay.url, 'node-3');
    await node.ready;

    client = new RelayClient({ relayUrl: relay.url, clientId: 'client-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const session = makeSessionMeta({ id: 'sess_prompt' });
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_VERSION, session });
    await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    const busy = client.busyFor(session.id);
    expect(get(busy)).toBe(false);

    const promptId = client.sendPrompt(session.id, 'do the thing');

    // C: the relay routed the prompt_inject through to the node side.
    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInject;
    expect(routed).toMatchObject({
      type: 'prompt_inject',
      sessionId: session.id,
      promptId,
      text: 'do the thing',
    });

    // The composer's own turn is visible immediately, before any reply.
    const entries = get(transcript);
    expect(entries).toEqual([{ id: promptId, role: 'user', text: 'do the thing', done: false }]);
    expect(get(busy)).toBe(true);

    // The agent's streamed reply arrives and completes the turn; busy clears.
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.id,
      update: { kind: 'agent_message_chunk', messageId: 'msg_reply', text: 'ok, done' },
    });
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.id,
      update: { kind: 'agent_turn_end', messageId: 'msg_reply' },
    });

    await waitForStore(busy, (value) => value === false);
    const final = get(transcript);
    expect(final).toEqual([
      { id: promptId, role: 'user', text: 'do the thing', done: false },
      { id: 'msg_reply', role: 'agent', text: 'ok, done', done: true },
    ]);
  });

  it('does not send a wire frame while the socket is not yet open', () => {
    client = new RelayClient({ relayUrl: relay.url, clientId: 'client-5' });
    // sendPrompt before connect(): should not throw, and should still update local state.
    const promptId = client.sendPrompt('sess_never_connected', 'hello?');
    expect(get(client.transcriptFor('sess_never_connected'))).toEqual([
      { id: promptId, role: 'user', text: 'hello?', done: false },
    ]);
  });
});
