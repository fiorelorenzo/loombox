import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type SessionAnnounceV1,
  type SessionListV1,
  type SessionUpdateEnvelopeV1,
  type SessionWithPrivateEnvelope,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';

const execFileAsync = promisify(execFile);

type CryptoKey = webcrypto.CryptoKey;

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

// -----------------------------------------------------------------------
// Test-only crypto helpers standing in for a phone/PWA client. These are
// deliberately NOT calls into this package's own `session-keys.ts`/
// `crypto-envelope.ts` — they reimplement the same *documented* v1
// derivation contract (session-keys.ts's doc comment: path
// `['session', accountId, sessionId]`) directly against `@loombox/crypto`'s
// primitives, so a passing test proves two independent parties interoperate,
// not just that this package agrees with itself.
// -----------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function derivePhoneSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

async function phoneSeal(
  sessionId: string,
  value: unknown,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const envelope = await encryptEnvelope(sessionId, plaintext, key);
  return {
    resourceId: envelope.resourceId,
    iv: toBase64(envelope.iv),
    ciphertext: toBase64(envelope.ciphertext),
    alg: 'AES-256-GCM',
  };
}

async function phoneOpen<T>(
  sessionId: string,
  wire: EncryptedEnvelope,
  key: CryptoKey,
): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Asserts a wire envelope's ciphertext bytes contain none of `plainSubstrings` verbatim — the relay-sees-only-ciphertext assertion. */
function assertOpaque(wire: EncryptedEnvelope, plainSubstrings: string[]): void {
  const raw = Buffer.from(wire.ciphertext, 'base64').toString('latin1');
  for (const needle of plainSubstrings) {
    expect(raw.includes(needle)).toBe(false);
  }
}

/** A minimal encrypted-PWA-like client over the global WebSocket, speaking the v1 handshake. */
class TestPhone {
  readonly messages: WireMessageV1[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, opts: { deviceId: string; devicePublicKey: string; authToken: string }) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({
            type: 'initialize',
            protocolVersion: PROTOCOL_V1,
            role: 'client',
            authToken: opts.authToken,
            deviceId: opts.deviceId,
            devicePublicKey: opts.devicePublicKey,
          }),
        );
      });
      this.socket.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data)) as { type?: string };
        if (!settled && parsed.type === 'initialize_result') {
          settled = true;
          resolve();
          return;
        }
        this.messages.push(parsed as WireMessageV1);
      });
      this.socket.addEventListener('error', () => {
        if (!settled) reject(new Error(`TestPhone: cannot reach ${url}`));
      });
    });
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Waits until a message matching `predicate` has arrived (checking history first), or times out. */
  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 3000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error('TestPhone: timed out waiting for a matching message');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Waits until at least `count` messages match `predicate`. */
  async waitForCount(
    predicate: (message: WireMessageV1) => boolean,
    count: number,
    timeoutMs = 3000,
  ): Promise<WireMessageV1[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.filter(predicate);
      if (found.length >= count) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `TestPhone: timed out waiting for ${count} matching messages (saw ${found.length})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  count(predicate: (message: WireMessageV1) => boolean): number {
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

/** Waits until `node` has completed the relay handshake at least once. */
function waitForConnected(node: NodeDaemon): Promise<void> {
  return new Promise((resolve) => node.once('connected', resolve));
}

/** Polls `session_list_request` until `sessionId` shows up (client-initiated `session_create` has no direct ack). */
async function waitForSessionInList(
  phone: TestPhone,
  sessionId: string,
  timeoutMs = 5000,
): Promise<SessionWithPrivateEnvelope> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const list = [...phone.messages]
      .reverse()
      .find((m): m is SessionListV1 => m.type === 'session_list');
    const entry = list?.sessions.find((s) => s.session.id === sessionId);
    if (entry) return entry;
    if (Date.now() > deadline) {
      throw new Error(`waitForSessionInList: timed out waiting for session ${sessionId}`);
    }
  }
}

let relay: StartedRelay;
let projectPath: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;
let phoneB: TestPhone | undefined;

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
  phone?.close();
  phoneB?.close();
  node = undefined;
  phone = undefined;
  phoneB = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon (protocol v1, E2E encrypted)', () => {
  it('announces a session with clear routing metadata and an encrypted title/path envelope, and pumps agent updates as ciphertext a resumed client can decrypt', async () => {
    const amk = generateAmk();
    const accountId = 'acct-announce-and-pump';

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-1',
      deviceId: 'device-node-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({
      projectPath,
      provider: 'test-echo',
      title: 'my session',
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    // A. the phone observes the running session without having started it,
    // via the account-scoped snapshot — and the snapshot's clear metadata
    // carries no title/projectPath (SPEC §8's metadata boundary).
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const listMsg = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    const entry = listMsg.sessions.find((s) => s.session.id === session.id);
    expect(entry).toBeDefined();
    expect(entry?.session).not.toHaveProperty('title');
    expect(entry?.session).not.toHaveProperty('projectPath');
    expect(entry?.session.nodeId).toBe('node-1');
    expect(entry?.session.targetId).toBe('local');
    expect(entry?.session.accountId).toBe(accountId);
    expect(entry?.session.provider).toBe('test-echo');

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const decryptedMeta = await phoneOpen<{ title: string; projectPath: string }>(
      session.id,
      entry!.privateEnvelope,
      key,
    );
    expect(decryptedMeta).toEqual({ title: 'my session', projectPath: session.projectPath });
    // The relay only ever carried this ciphertext: the title/path are not recoverable from it.
    assertOpaque(entry!.privateEnvelope, ['my session', session.projectPath]);

    // Subscribe (session_resume) so this client starts receiving live fan-out.
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    const announce = (await phone.waitFor(
      (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
    )) as SessionAnnounceV1;
    expect(announce.session).not.toHaveProperty('title');

    // B. output the phone did not initiate (an operator-side prompt via the
    // node's direct API) streams to it live, as ciphertext it can decrypt.
    await node.promptSession(session.id, 'hi there');

    const chunkMessages = (await phone.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
      2,
    )) as SessionUpdateEnvelopeV1[];

    // The relay never carried plaintext: the raw frame has only an opaque
    // envelope, no 'kind'/'text' fields sitting next to it.
    for (const message of chunkMessages) {
      expect(message).not.toHaveProperty('text');
      expect(message).not.toHaveProperty('kind');
      assertOpaque(message.envelope, ['Hello', 'world']);
    }

    const decryptedChunks = await Promise.all(
      chunkMessages
        .sort((a, b) => a.seq - b.seq)
        .map((message) =>
          phoneOpen<{ kind: string; text: string }>(session.id, message.envelope, key),
        ),
    );
    expect(decryptedChunks.every((update) => update.kind === 'agent_message_chunk')).toBe(true);
    expect(decryptedChunks.map((update) => update.text).join('')).toBe('Hello world');
  });

  it("delivers a phone's encrypted prompt_inject to the owning session, producing a new turn of ciphertext updates", async () => {
    const amk = generateAmk();
    const accountId = 'acct-prompt-inject';

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-2',
      deviceId: 'device-node-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(session.id, { text: 'go do the thing' }, key);
    assertOpaque(envelope, ['go do the thing']);
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-1',
      envelope,
    });

    const chunkMessages = (await phone.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
      2,
    )) as SessionUpdateEnvelopeV1[];
    const decryptedChunks = await Promise.all(
      chunkMessages
        .sort((a, b) => a.seq - b.seq)
        .map((message) =>
          phoneOpen<{ kind: string; text: string }>(session.id, message.envelope, key),
        ),
    );
    expect(decryptedChunks.map((update) => update.text).join('')).toBe('Hello world');
  });

  it('creates a session from a client session_create, routed via the target the node announced, and the resulting session is fully usable', async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-create';

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-3',
      deviceId: 'device-node-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node); // ensures target_announce landed before session_create routing needs it

    const sessionId = 'sess-from-client-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'client session', projectPath },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-echo',
      privateEnvelope,
    });

    const entry = await waitForSessionInList(phone, sessionId);
    expect(entry.session.nodeId).toBe('node-3');
    expect(entry.session.provider).toBe('test-echo');
    const decryptedMeta = await phoneOpen<{ title: string; projectPath: string }>(
      sessionId,
      entry.privateEnvelope,
      key,
    );
    expect(decryptedMeta).toEqual({ title: 'client session', projectPath });

    // The session is a real, working one: prompting it directly produces output.
    await node.promptSession(sessionId, 'hi');
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
    await phone.waitFor((m) => m.type === 'session_announce');
    await phone.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === sessionId,
      1,
    );
  });

  it('resyncs a client after it drops: the relay replays buffered ciphertext for the seq range it missed', async () => {
    const amk = generateAmk();
    const accountId = 'acct-resync';

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-4',
      deviceId: 'device-node-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    await node.promptSession(session.id, 'first turn');
    const firstTurnChunks = (await phone.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
      2,
    )) as SessionUpdateEnvelopeV1[];
    const lastSeenSeq = Math.max(...firstTurnChunks.map((m) => m.seq));

    // The phone drops (network loss) without unsubscribing.
    phone.close();

    // The node keeps working while the phone is gone; the relay still
    // buffers these encrypted updates in its per-session resync ring even
    // though nobody is currently subscribed to receive them live.
    await node.promptSession(session.id, 'second turn, while the phone was offline');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The phone reconnects and resyncs from where it left off.
    phoneB = new TestPhone(relay.url, {
      deviceId: 'device-phone-4', // same device identity reconnecting
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phoneB.ready;
    phoneB.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phoneB.waitFor((m) => m.type === 'session_announce');
    phoneB.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      sinceSeq: lastSeenSeq,
    });

    const replayed = (await phoneB.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
      2,
    )) as SessionUpdateEnvelopeV1[];
    expect(replayed.every((m) => m.seq > lastSeenSeq)).toBe(true);

    const decryptedReplay = await Promise.all(
      replayed
        .sort((a, b) => a.seq - b.seq)
        .map((message) =>
          phoneOpen<{ kind: string; text: string }>(session.id, message.envelope, key),
        ),
    );
    expect(decryptedReplay.map((update) => update.text).join('')).toBe('Hello world');
    for (const message of replayed) {
      assertOpaque(message.envelope, ['Hello', 'world']);
    }
  });

  it('reconnects after the relay connection drops and re-announces its targets and sessions, without a process restart', async () => {
    const amk = generateAmk();
    const accountId = 'acct-reconnect';

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-5',
      deviceId: 'device-node-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      reconnect: { initialBackoffMs: 20, maxBackoffMs: 200 },
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');
    expect(phone.count((m) => m.type === 'session_announce')).toBe(1);

    // The relay's session/target STORE survives a node disconnect (it is a
    // ciphertext store, not connection-scoped state) — only the *routing*
    // entry mapping this node's id to a live connection is cleared when its
    // socket drops. So the real, observable effect of "reconnect
    // re-announces" in v1 is that ROUTING to this node works again after a
    // drop, not an unsolicited push to an already-subscribed client (the
    // relay never fans a node's `session_announce`/`target_announce` out to
    // clients at all — a client only ever receives one via its own
    // `session_resume`/`session_list_request`). Prove routing is restored by
    // driving a fresh client-initiated `prompt_inject` through the relay
    // after the drop and confirming it still reaches the agent.
    const connectedAgain = new Promise<void>((resolve) => node!.once('connected', resolve));
    node.simulateRelayDrop();
    await connectedAgain;

    const envelope = await phoneSeal(session.id, { text: 'after reconnect' }, key);
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-after-reconnect',
      envelope,
    });

    const chunkMessage = (await phone.waitFor(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
    )) as SessionUpdateEnvelopeV1;
    const decrypted = await phoneOpen<{ kind: string }>(session.id, chunkMessage.envelope, key);
    expect(decrypted.kind).toBe('agent_message_chunk');
  });
});
