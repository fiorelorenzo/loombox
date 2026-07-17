import type { webcrypto } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';
import { createTranscriptState, reduceTranscript } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type ConfigOption,
  type EncryptedEnvelope,
  type PermissionResponse,
  type PromptInjectV1,
  type SessionMetaPublic,
  type WireMessageV1,
} from '@loombox/protocol';
import { createRelayAuth, startRelay, type RelayAuth, type StartedRelay } from '@loombox/relay';

import { RelayClient, type ClientSessionMeta } from './relay-client';
import { AuthStore, createInMemoryAuthStorage } from './auth-store';
import { createInMemoryAmkStorage, loadOrCreateAmk } from './amk-store';

type CryptoKey = webcrypto.CryptoKey;

// -----------------------------------------------------------------------
// Test-only crypto helpers standing in for a node. Deliberately NOT calls
// into RelayClient's own imports of @loombox/crypto's deriveSessionKey/
// sealJson/openJson — reimplementing the same *documented* v1 derivation
// contract (packages/crypto/src/session-keys.ts's doc comment: path
// ['session', accountId, sessionId]) directly against the lower-level
// primitives, exactly like packages/node/src/node-daemon.test.ts's
// TestPhone does for the client side. A passing test this way proves two
// independent parties interoperate, not just that RelayClient agrees with
// itself.
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

async function deriveNodeSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

async function nodeSeal(
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

async function nodeOpen<T>(sessionId: string, wire: EncryptedEnvelope, key: CryptoKey): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** A minimal encrypted-node-like peer over the global WebSocket, speaking the v1 handshake's `role: 'node'` side. */
class FakeNode {
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
            role: 'node',
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
        if (!settled) reject(new Error(`FakeNode: cannot reach ${url}`));
      });
    });
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 3000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
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

/**
 * Waits until a store's value is no longer reference-equal to `previous`.
 * `RelayClient` always sets/updates its stores with a fresh array/object, so
 * this reliably detects "another inbound wire message was processed" even
 * when its decrypted content happens to equal what was already there —
 * used to deterministically wait for `session_resume`'s `session_announce`
 * reply (confirming the relay subscribed this client) before a test
 * triggers a `session_update` from the node side, avoiding a race between
 * two independent WebSocket connections.
 */
async function waitForStoreChange<T>(
  store: { subscribe: (run: (value: T) => void) => () => void },
  previous: T,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get(store);
    if (value !== previous) return value;
    if (Date.now() > deadline) throw new Error('waitForStoreChange: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeSessionMeta(overrides: Partial<SessionMetaPublic> = {}): SessionMetaPublic {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    targetId: 'local',
    accountId: 'acct-test',
    provider: 'claude',
    createdAt: Date.now(),
    ...overrides,
  };
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

describe('reduceTranscript (pure reducer, re-exported from @loombox/providers-core)', () => {
  it('appends a new message item on first sight of a (turnId, kind, messageId)', () => {
    const state = reduceTranscript(createTranscriptState(), {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'Hello',
    });
    expect(state.items).toEqual([
      {
        type: 'message',
        id: 't1::agent_message_chunk::m1',
        kind: 'agent_message_chunk',
        turnId: 't1',
        messageId: 'm1',
        text: 'Hello',
      },
    ]);
  });

  it('accumulates chunks with the same (turnId, kind, messageId) in order', () => {
    let state = reduceTranscript(createTranscriptState(), {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'Hello',
    });
    state = reduceTranscript(state, {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: ' world',
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: 'Hello world' });
  });
});

describe('RelayClient', () => {
  it('connects, sends initialize, and surfaces the initial (empty) session_list snapshot', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-empty',
      deviceId: 'client-1',
    });
    client.connect();

    await waitForStore(client.status, (status) => status === 'open');
    const sessions = await waitForStore(client.sessions, () => true);
    expect(sessions).toEqual([]);
  });

  it('surfaces a session announced by a node before the client connects, decrypting its title/projectPath', async () => {
    const amk = generateAmk();
    const accountId = 'acct-list';

    node = new FakeNode(relay.url, {
      deviceId: 'node-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_announced', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'my session', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const sessions = (await waitForStore(
      client.sessions,
      (value) => value.length > 0,
    )) as ClientSessionMeta[];
    expect(sessions).toEqual([{ ...session, title: 'my session', projectPath: '/proj' }]);
    // Never exposes the wire envelope itself, only the values it decrypted to.
    expect(sessions[0]).not.toHaveProperty('privateEnvelope');
  });

  it('decrypts and reduces a live session_update stream after subscribing via transcriptFor', async () => {
    const amk = generateAmk();
    const accountId = 'acct-transcript';

    node = new FakeNode(relay.url, {
      deviceId: 'node-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_transcript', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'live', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);

    // transcriptFor() sent session_resume; wait for its session_announce
    // reply to land (confirming the relay actually subscribed this client)
    // before triggering updates from the node side, avoiding a race between
    // the two independent WebSocket connections.
    await waitForStoreChange(client.sessions, initialSessions);

    const chunk1Envelope = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 'turn-1', messageId: 'msg-1', text: 'Hello' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: chunk1Envelope,
    });
    const chunk2Envelope = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 'turn-1', messageId: 'msg-1', text: ' world' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: chunk2Envelope,
    });

    const state = await waitForStore(transcript, (value) => {
      const first = value.items[0];
      return first?.type === 'message' && first.text === 'Hello world';
    });
    expect(state.items).toEqual([
      {
        type: 'message',
        id: 'turn-1::agent_message_chunk::msg-1',
        kind: 'agent_message_chunk',
        turnId: 'turn-1',
        messageId: 'msg-1',
        text: 'Hello world',
      },
    ]);
  });

  it('sendPrompt appends the user turn locally and makes the relay route a decryptable prompt_inject to the node', async () => {
    const amk = generateAmk();
    const accountId = 'acct-prompt';

    node = new FakeNode(relay.url, {
      deviceId: 'node-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_prompt', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);

    const promptId = client.sendPrompt(session.id, 'do the thing');

    // The composer's own turn is visible immediately, before any reply.
    expect(get(transcript).items).toEqual([
      {
        type: 'message',
        id: `${promptId}::user_message_chunk::${promptId}`,
        kind: 'user_message_chunk',
        turnId: promptId,
        messageId: promptId,
        text: 'do the thing',
      },
    ]);

    // The relay routed the (encrypted) prompt_inject through to the node,
    // and the node independently derives the same key and decrypts it back
    // to the original text — proving real interop, not self-consistency.
    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(routed.sessionId).toBe(session.id);
    expect(routed.promptId).toBe(promptId);
    const decrypted = await nodeOpen<{ text: string }>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({ text: 'do the thing' });

    // The relay only ever carried ciphertext.
    const raw = Buffer.from(routed.envelope.ciphertext, 'base64').toString('latin1');
    expect(raw.includes('do the thing')).toBe(false);
  });

  it('decrypts a live permission_request and enqueues it onto permissionQueueFor, FIFO', async () => {
    const amk = generateAmk();
    const accountId = 'acct-permission';

    node = new FakeNode(relay.url, {
      deviceId: 'node-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_permission', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-6' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    ];
    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc1', title: 'Edit foo.ts' }, options },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-1',
      envelope,
    });

    const state = await waitForStore(queue, (value) => value.byId.size > 0);
    const pending = state.byId.get('req-1');
    expect(pending?.toolCall).toEqual({ kind: 'tool_call', id: 'tc1', title: 'Edit foo.ts' });
    expect(pending?.options).toEqual(options);
    expect([...(state.bySession.get(session.id) ?? [])].map((r) => r.requestId)).toEqual(['req-1']);
  });

  it('resolvePermission removes the request locally and sends a clear permission_response with the option kind', async () => {
    const amk = generateAmk();
    const accountId = 'acct-resolve';

    node = new FakeNode(relay.url, {
      deviceId: 'node-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_resolve', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-7' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const option = { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const };
    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc1' }, options: [option] },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-2',
      envelope,
    });
    await waitForStore(queue, (value) => value.byId.size > 0);

    client.resolvePermission(session.id, 'req-2', option);

    expect(get(queue).byId.size).toBe(0);
    const response = (await node.waitFor(
      (m) => m.type === 'permission_response',
    )) as PermissionResponse;
    expect(response).toMatchObject({
      sessionId: session.id,
      requestId: 'req-2',
      decision: 'allow_once',
    });
  });

  it('cancelPermissionRequests optimistically clears every open request for a session (Stop)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-cancel';

    node = new FakeNode(relay.url, {
      deviceId: 'node-6',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_cancel', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-8' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    for (const requestId of ['req-a', 'req-b', 'req-c']) {
      const envelope = await nodeSeal(
        session.id,
        { toolCall: { kind: 'tool_call', id: requestId }, options: [] },
        key,
      );
      node.send({
        type: 'permission_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId,
        envelope,
      });
    }
    await waitForStore(queue, (value) => value.byId.size === 3);

    client.cancelPermissionRequests(session.id);

    expect(get(queue).byId.size).toBe(0);
  });

  it('setConfigOption updates the local list optimistically and sends the clear config_option message', async () => {
    const amk = generateAmk();
    const accountId = 'acct-config';

    node = new FakeNode(relay.url, {
      deviceId: 'node-7',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_config', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-9' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    client.setConfigOption(session.id, 'model', 'opus');

    const options = get(client.configOptionsFor(session.id));
    expect(options).toEqual([]);

    const sent = (await node.waitFor((m) => m.type === 'config_option')) as ConfigOption;
    expect(sent).toMatchObject({ sessionId: session.id, category: 'model', optionId: 'opus' });
  });

  it('does not send a wire frame while the socket is not yet open, but still updates local transcript state', () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-offline',
      deviceId: 'client-5',
    });
    // sendPrompt before connect(): should not throw, and should still update local state.
    const promptId = client.sendPrompt('sess_never_connected', 'hello?');
    const transcript = client.transcriptFor('sess_never_connected');
    expect(get(transcript).items).toEqual([
      {
        type: 'message',
        id: `${promptId}::user_message_chunk::${promptId}`,
        kind: 'user_message_chunk',
        turnId: promptId,
        messageId: promptId,
        text: 'hello?',
      },
    ]);
  });
});

/**
 * Applies Better Auth's own schema to a hermetic sqlite database — the same
 * call `packages/relay/src/auth.ts`'s `migrateBetterAuth` makes
 * (`better-auth/db/migration`), inlined rather than imported because it
 * isn't part of `@loombox/relay`'s public `index.ts` export surface and
 * this PR does not touch `packages/relay` to add it (mirrors
 * `auth-store.test.ts`'s identical helper/rationale).
 */
async function migrateBetterAuth(auth: RelayAuth): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** `ws://host:port/ws` -> `http://host:port` (Better Auth's routes live on the same Fastify instance). */
function httpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

describe('RelayClient wired to a real Better Auth account (issue #126, the real-auth wave)', () => {
  let authedRelay: StartedRelay | undefined;

  afterEach(async () => {
    await authedRelay?.close();
    authedRelay = undefined;
  });

  it('an AuthStore-issued bearer token authenticates the WS handshake, the relay resolves it to the SAME accountId as the client, and a persisted (not injected) AMK decrypts the account-scoped session list', async () => {
    // A relay configured with a REAL Better Auth instance (hermetic:
    // in-memory sqlite + the email-password test escape hatch), unlike
    // every other test in this file, which uses `startRelay()`'s default
    // `deriveAccountIdStub`. This is the actual production wiring
    // (`main.ts` supplies `resolveAccountIdViaBetterAuth` the same way once
    // `DATABASE_URL` is set), exercised end to end here.
    const database = new Database(':memory:');
    const auth = createRelayAuth({
      database,
      baseURL: 'http://127.0.0.1:0',
      secret: 'hermetic-test-secret-hermetic-test-secret',
      enableEmailPasswordForTests: true,
    });
    await migrateBetterAuth(auth);
    authedRelay = await startRelay({ auth });

    // 1. The client obtains a real bearer token + its accountId from the
    // relay's own Better Auth over real HTTP — no injected/stubbed token.
    const authStore = new AuthStore({
      relayBaseUrl: httpBaseUrl(authedRelay.url),
      storage: createInMemoryAuthStorage(),
    });
    const session = await authStore.signUpWithEmailPassword(
      'client-auth-wave@example.com',
      'correct horse battery staple',
    );
    expect(session.token).toBeTruthy();
    expect(session.accountId).toBeTruthy();

    // 2. The client generates + persists its own AMK on-device (not
    // injected via options) — a second lookup for the same account returns
    // the identical key, proving persistence rather than a fresh random
    // value each call.
    const amkStorage = createInMemoryAmkStorage();
    const amk = loadOrCreateAmk(session.accountId, amkStorage);
    expect(loadOrCreateAmk(session.accountId, amkStorage)).toEqual(amk);

    // A node, independently, announces a session under that SAME accountId
    // (as the relay's real Better Auth resolved it) — proving the node and
    // this client, which never coordinated directly, agree on the account.
    // The relay's real resolver (not the dev stub every other test in this
    // file relies on) applies to node connections too, so the node
    // authenticates with its OWN real bearer token — a second "device"
    // signing in as the same self-hosting operator, exactly SPEC §8's model.
    const nodeAuthStore = new AuthStore({
      relayBaseUrl: httpBaseUrl(authedRelay.url),
      storage: createInMemoryAuthStorage(),
    });
    // Same underlying account, a second "device" signing back in — Better
    // Auth issues its own distinct session/bearer, but resolves to the same
    // accountId (see `auth-store.test.ts`'s equivalent client-only test).
    const nodeSession = await nodeAuthStore.signInWithEmailPassword(
      'client-auth-wave@example.com',
      'correct horse battery staple',
    );
    expect(nodeSession.accountId).toBe(session.accountId);

    node = new FakeNode(authedRelay.url, {
      deviceId: 'node-real-auth',
      devicePublicKey: randomBase64(),
      authToken: nodeSession.token,
    });
    await node.ready;

    const sessionMeta = makeSessionMeta({ id: 'sess_real_auth', accountId: session.accountId });
    const key = await deriveNodeSessionKey(amk, session.accountId, sessionMeta.id);
    const privateEnvelope = await nodeSeal(
      sessionMeta.id,
      { title: 'wired for real', projectPath: '/proj' },
      key,
    );
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionMeta,
      privateEnvelope,
    });

    // 3. The client connects using the REAL bearer token as the WS
    // handshake's authToken (not accountId doubling as a stub) and the
    // persisted AMK (not one handed in via options for this test to share).
    client = new RelayClient({
      relayUrl: authedRelay.url,
      amk,
      accountId: session.accountId,
      authToken: session.token,
      deviceId: 'client-real-auth',
    });
    client.connect();

    await waitForStore(client.status, (status) => status === 'open');
    const sessions = (await waitForStore(
      client.sessions,
      (value) => value.length > 0,
    )) as ClientSessionMeta[];
    expect(sessions).toEqual([{ ...sessionMeta, title: 'wired for real', projectPath: '/proj' }]);
  });

  it('rejects the WS handshake outright when authToken is not a valid Better Auth bearer', async () => {
    const database = new Database(':memory:');
    const auth = createRelayAuth({
      database,
      baseURL: 'http://127.0.0.1:0',
      secret: 'hermetic-test-secret-hermetic-test-secret',
      enableEmailPasswordForTests: true,
    });
    await migrateBetterAuth(auth);
    authedRelay = await startRelay({ auth });

    client = new RelayClient({
      relayUrl: authedRelay.url,
      amk: generateAmk(),
      accountId: 'whatever-this-is-ignored-by-the-real-resolver',
      authToken: 'not-a-real-bearer-token',
      deviceId: 'client-rejected',
    });
    client.connect();

    await waitForStore(client.status, (status) => status === 'error' || status === 'closed');
  });
});
