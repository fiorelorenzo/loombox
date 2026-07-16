import { afterEach, describe, expect, it } from 'vitest';
import type {
  NodeHello,
  ClientHello,
  SessionAnnounce,
  SessionMeta,
  SessionList,
  SessionUpdateEnvelope,
  PromptInject,
  WireMessage,
} from '@loombox/protocol';
import { PROTOCOL_VERSION } from '@loombox/protocol';

import { startRelay } from './relay';

type Close = () => Promise<void>;

let closers: Close[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/** Opens a WebSocket and resolves once it's open. */
async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('ws connect error')), { once: true });
  });
  closers.push(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });
  return socket;
}

function send(socket: WebSocket, message: WireMessage): void {
  socket.send(JSON.stringify(message));
}

/** Resolves with the next parsed wire message received on the socket. */
function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data.toString()) as WireMessage);
      },
      { once: true },
    );
  });
}

function makeSessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    projectPath: '/home/dev/project',
    worktreePath: '/home/dev/project/.worktrees/sess_1',
    target: 'local',
    provider: 'claude',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('relay', () => {
  it('fans a session_announce from a node out to a connected client', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const node = await connect(url);
    const nodeHello: NodeHello = {
      type: 'node_hello',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: 'node_1',
    };
    send(node, nodeHello);

    const client = await connect(url);
    const clientHello: ClientHello = {
      type: 'client_hello',
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'client_1',
    };
    send(client, clientHello);
    // consume the initial (empty) session_list snapshot before the announce
    const initialSnapshot = (await nextMessage(client)) as SessionList;
    expect(initialSnapshot.type).toBe('session_list');
    expect(initialSnapshot.sessions).toEqual([]);

    const announce: SessionAnnounce = {
      type: 'session_announce',
      protocolVersion: PROTOCOL_VERSION,
      session: makeSessionMeta(),
    };
    send(node, announce);

    const received = (await nextMessage(client)) as SessionAnnounce;
    expect(received).toEqual(announce);
  });

  it('sends a freshly-connecting client a session_list snapshot of known sessions', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const node = await connect(url);
    send(node, {
      type: 'node_hello',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: 'node_1',
    });

    const session = makeSessionMeta({ id: 'sess_snapshot' });
    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_VERSION,
      session,
    });
    // give the relay a beat to register the session before the client connects
    await new Promise((resolve) => setTimeout(resolve, 50));

    const client = await connect(url);
    send(client, {
      type: 'client_hello',
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'client_2',
    });

    const snapshot = (await nextMessage(client)) as SessionList;
    expect(snapshot.type).toBe('session_list');
    expect(snapshot.sessions).toEqual([session]);
  });

  it('fans a session_update from a node out to a connected client', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const node = await connect(url);
    send(node, { type: 'node_hello', protocolVersion: PROTOCOL_VERSION, nodeId: 'node_1' });

    const client = await connect(url);
    send(client, { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client_3' });
    await nextMessage(client); // initial session_list snapshot

    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_VERSION,
      session: makeSessionMeta({ id: 'sess_update' }),
    });
    await nextMessage(client); // the announce

    const update: SessionUpdateEnvelope = {
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'sess_update',
      update: { kind: 'agent_message_chunk', messageId: 'msg_1', text: 'hi' },
    };
    send(node, update);

    const received = (await nextMessage(client)) as SessionUpdateEnvelope;
    expect(received).toEqual(update);
  });

  it('routes a client prompt_inject to the node owning that session', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const node = await connect(url);
    send(node, { type: 'node_hello', protocolVersion: PROTOCOL_VERSION, nodeId: 'node_1' });

    const client = await connect(url);
    send(client, { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client_4' });
    await nextMessage(client); // initial session_list snapshot

    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_VERSION,
      session: makeSessionMeta({ id: 'sess_prompt' }),
    });
    await nextMessage(client); // the announce

    const prompt: PromptInject = {
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'sess_prompt',
      promptId: 'prompt_1',
      text: 'do the thing',
    };
    send(client, prompt);

    const received = (await nextMessage(node)) as PromptInject;
    expect(received).toEqual(prompt);
  });

  it('ignores a prompt_inject for an unknown session instead of throwing', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const client = await connect(url);
    send(client, { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client_5' });
    await nextMessage(client); // initial session_list snapshot

    send(client, {
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'sess_nonexistent',
      promptId: 'prompt_2',
      text: 'hello?',
    });

    // the relay should still be responsive: a second client still gets a snapshot
    const client2 = await connect(url);
    send(client2, {
      type: 'client_hello',
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'client_6',
    });
    const snapshot = (await nextMessage(client2)) as SessionList;
    expect(snapshot.type).toBe('session_list');
  });

  it('drops a session from the registry when its owning node disconnects', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const node = await connect(url);
    send(node, { type: 'node_hello', protocolVersion: PROTOCOL_VERSION, nodeId: 'node_1' });
    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_VERSION,
      session: makeSessionMeta({ id: 'sess_gone' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    node.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const client = await connect(url);
    send(client, { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client_7' });
    const snapshot = (await nextMessage(client)) as SessionList;
    expect(snapshot.sessions).toEqual([]);
  });

  it('rejects an invalid first frame without crashing the relay', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const bad = await connect(url);
    bad.send(JSON.stringify({ type: 'not_a_real_message' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // relay is still alive and healthy for a well-formed connection
    const client = await connect(url);
    send(client, { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client_8' });
    const snapshot = (await nextMessage(client)) as SessionList;
    expect(snapshot.type).toBe('session_list');
  });
});
