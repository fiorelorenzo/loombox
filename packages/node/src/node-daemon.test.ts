import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_VERSION,
  type SessionAnnounce,
  type SessionUpdateEnvelope,
  type WireMessage,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';

import { createNode, type NodeDaemon } from './node-daemon';

const execFileAsync = promisify(execFile);

// Reuses the same hermetic fixture agent packages/providers/core,
// packages/providers/claude and packages/supervisor already exercise their
// tests against (not a real `claude` binary): relative path into the
// sibling package's test/fixtures, since it is deliberately not published
// via that package's `exports`.
const ECHO_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

/** A minimal PWA-like client over the global WebSocket, used only by this test. */
class TestClient {
  readonly messages: WireMessage[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, clientId: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve) => {
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({ type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId }),
        );
      });
      this.socket.addEventListener('message', (event) => {
        this.messages.push(JSON.parse(String(event.data)) as WireMessage);
        resolve();
      });
    });
  }

  send(message: WireMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Waits until a message matching `predicate` has arrived (checking history first), or times out. */
  async waitFor(
    predicate: (message: WireMessage) => boolean,
    timeoutMs = 3000,
  ): Promise<WireMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error('TestClient: timed out waiting for a matching message');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Counts messages matching `predicate` seen so far. */
  count(predicate: (message: WireMessage) => boolean): number {
    return this.messages.filter(predicate).length;
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

let relay: StartedRelay;
let projectPath: string;
let node: NodeDaemon | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  relay = await startRelay();

  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-test-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@loombox.dev'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'loombox test'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: projectPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'loombox test',
      GIT_AUTHOR_EMAIL: 'test@loombox.dev',
      GIT_COMMITTER_NAME: 'loombox test',
      GIT_COMMITTER_EMAIL: 'test@loombox.dev',
    },
  });
});

afterEach(async () => {
  node?.close();
  client?.close();
  node = undefined;
  client = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon', () => {
  it('registers with the relay, announces a created session, and pumps agent updates to a connected client', async () => {
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-1',
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    client = new TestClient(relay.url, 'client-1');
    await client.ready;

    const session = await node.createSession({ projectPath, provider: 'test-echo' });

    const announceMsg = await client.waitFor((m) => m.type === 'session_announce');
    const announce = announceMsg as SessionAnnounce;
    expect(announce.session.id).toBe(session.id);
    expect(announce.session.nodeId).toBe('node-1');
    expect(announce.session.target).toBe('local');
    expect(announce.session.provider).toBe('test-echo');

    await node.promptSession(session.id, 'hi there');

    const updateMsg = await client.waitFor((m) => {
      if (m.type !== 'session_update') return false;
      const { sessionId, update } = m as SessionUpdateEnvelope;
      return (
        sessionId === session.id &&
        update.kind === 'agent_message_chunk' &&
        update.text === 'Hello world'
      );
    });
    const update = updateMsg as SessionUpdateEnvelope;
    expect(update.update).toEqual({
      kind: 'agent_message_chunk',
      messageId: 'msg_agent_1',
      text: 'Hello world',
    });

    const turnEnd = await client.waitFor(
      (m) =>
        m.type === 'session_update' &&
        (m as SessionUpdateEnvelope).sessionId === session.id &&
        (m as SessionUpdateEnvelope).update.kind === 'agent_turn_end',
    );
    expect((turnEnd as SessionUpdateEnvelope).update).toEqual({
      kind: 'agent_turn_end',
      messageId: 'msg_agent_1',
    });
  });

  it('delivers a client prompt_inject to the owning session, producing a new turn of updates', async () => {
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-2',
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    client = new TestClient(relay.url, 'client-2');
    await client.ready;

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    await client.waitFor((m) => m.type === 'session_announce');

    client.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.id,
      promptId: 'prompt-1',
      text: 'go do the thing',
    });

    const update = (await client.waitFor(
      (m) =>
        m.type === 'session_update' &&
        (m as SessionUpdateEnvelope).sessionId === session.id &&
        (m as SessionUpdateEnvelope).update.kind === 'agent_message_chunk',
    )) as SessionUpdateEnvelope;
    expect(update.update).toMatchObject({ kind: 'agent_message_chunk', text: 'Hello' });
  });

  it('ignores a prompt_inject for a session this node does not own, without crashing', async () => {
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-3',
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    client = new TestClient(relay.url, 'client-3');
    await client.ready;

    client.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'sess_unknown',
      promptId: 'prompt-x',
      text: 'hello?',
    });

    // The node stays responsive: a real session created afterward still announces fine.
    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const announce = (await client.waitFor(
      (m) => m.type === 'session_announce',
    )) as SessionAnnounce;
    expect(announce.session.id).toBe(session.id);
  });

  it('reconnects after the relay connection drops and re-announces its sessions, without a process restart', async () => {
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-4',
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      reconnect: { initialBackoffMs: 20, maxBackoffMs: 200 },
    });

    client = new TestClient(relay.url, 'client-4');
    await client.ready;

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    await client.waitFor((m) => m.type === 'session_announce');
    expect(client.count((m) => m.type === 'session_announce')).toBe(1);

    node.simulateRelayDrop();

    // Wait for the reconnect to happen and the session to be re-announced.
    const deadline = Date.now() + 3000;
    while (client.count((m) => m.type === 'session_announce') < 2) {
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the node to reconnect and re-announce');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const announces = client.messages.filter(
      (m): m is SessionAnnounce => m.type === 'session_announce',
    );
    expect(announces).toHaveLength(2);
    expect(announces[1]?.session.id).toBe(session.id);

    // The reconnected node can still pump updates end to end.
    await node.promptSession(session.id, 'after reconnect');
    const update = (await client.waitFor(
      (m) =>
        m.type === 'session_update' &&
        (m as SessionUpdateEnvelope).sessionId === session.id &&
        (m as SessionUpdateEnvelope).update.kind === 'agent_message_chunk',
    )) as SessionUpdateEnvelope;
    expect(update.update).toMatchObject({ kind: 'agent_message_chunk' });
  });
});
