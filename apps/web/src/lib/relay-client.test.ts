import 'fake-indexeddb/auto';
import type { webcrypto } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  generateRecoveryCode,
  importAesGcmKey,
} from '@loombox/crypto';
import { createTranscriptState, reduceTranscript } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type BlobDownloadResponse,
  type ConfigOption,
  type EncryptedEnvelope,
  type PermissionResponse,
  type PromptInjectV1,
  type SessionMetaPublic,
  type WireMessageV1,
} from '@loombox/protocol';
import { createRelayAuth, startRelay, type RelayAuth, type StartedRelay } from '@loombox/relay';

import {
  RelayClient,
  bootstrapAmkFromRecoveryCode,
  type ClientSessionMeta,
  type WebSocketConstructor,
  type WebSocketLike,
} from './relay-client';
import { AuthStore, createInMemoryAuthStorage } from './auth-store';
import { createInMemoryAmkStorage, loadOrCreateAmk } from './amk-store';
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  attachmentResourceId,
  hasBlockingAttachments,
} from './attachments';
import {
  createIndexedDbOutboxStorage,
  createInMemoryOutboxStorage,
  type OutboxStorage,
  type QueuedPrompt,
} from './outbox';

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

/**
 * Waits for `count` real changes on a store, counted off its `subscribe`
 * callback's own push notifications rather than polling `get()` — polling
 * can coalesce two rapid-fire changes into a single observed jump (missing
 * the intermediate value entirely), which `waitForStoreChange` called twice
 * in a row is vulnerable to when two independent `session_resume` round
 * trips (e.g. two sessions subscribed back-to-back) can each complete and
 * notify within the same polling tick. Every svelte store's `subscribe`
 * fires synchronously once with its current value on subscribe, which does
 * not count as a change.
 */
async function waitForNotificationCount(
  store: { subscribe: (run: (value: unknown) => void) => () => void },
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let seen = 0;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('waitForNotificationCount: timed out'));
    }, timeoutMs);
    // `count` is always > 0 for every caller below, so the synchronous
    // "current value" callback `subscribe` fires during this very call
    // (seen becomes 1, never > count here) never reads `unsubscribe` before
    // this assignment completes — no TDZ hazard from the self-reference.
    const unsubscribe = store.subscribe(() => {
      seen += 1;
      if (seen > count) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/** Polls `storage.list()` (a real, possibly-async read, unlike `waitForStore`'s synchronous `get()`) until `predicate` holds — used to wait for a fire-and-forget IndexedDB write to actually land before the next step depends on it. */
async function waitForOutbox(
  storage: OutboxStorage,
  predicate: (list: QueuedPrompt[]) => boolean,
  timeoutMs = 3000,
): Promise<QueuedPrompt[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await storage.list();
    if (predicate(list)) return list;
    if (Date.now() > deadline) throw new Error('waitForOutbox: timed out');
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

// -----------------------------------------------------------------------
// Attachment test fixtures (SPEC §7.25; issues #151/#152/#153/#155).
// -----------------------------------------------------------------------

/**
 * A real PNG's magic-byte signature plus filler "pixel" bytes — sniffs as an
 * actual PNG, not a fake. Explicitly typed `Uint8Array<ArrayBuffer>` (not
 * the bare `Uint8Array` alias, which defaults to `Uint8Array<ArrayBufferLike>`)
 * so the result is directly usable as a `File`/`Blob` part without a cast.
 */
function realPngBytes(fillerByte = 0x01, totalLength = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(totalLength).fill(fillerByte);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/** A minimal ISOBMFF `ftyp` box declaring the `heic` major brand — real HEIC magic bytes. */
function realHeicBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  const encoder = new TextEncoder();
  bytes.set([0x00, 0x00, 0x00, 0x18], 0);
  bytes.set(encoder.encode('ftyp'), 4);
  bytes.set(encoder.encode('heic'), 8);
  return bytes;
}

/** Not any recognized image format, however it's named/declared. */
function notAnImageBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode('%PDF-1.4 definitely not an image'));
}

/**
 * Decrypts a raw (non-JSON) attachment blob envelope under the given
 * session key, bound to the same `attachmentResourceId` AAD the relay's
 * blob store keys by and `@loombox/node`'s `AttachmentResolver` decrypts
 * against — the peer side of an attachment round trip, reimplemented here
 * (not imported from `@loombox/node`, which this package must not depend
 * on) directly against the lower-level `@loombox/crypto` primitives, same
 * spirit as this file's `nodeSeal`/`nodeOpen` helpers above.
 */
async function nodeOpenAttachment(
  sessionId: string,
  ref: string,
  wire: EncryptedEnvelope,
  key: CryptoKey,
): Promise<Uint8Array> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  return decryptEnvelope(attachmentResourceId(sessionId, ref), envelope, key);
}

/**
 * A `WebSocketConstructor` (real class, so `new`-able like the global
 * `WebSocket` `RelayClient` normally uses) wrapping a real WebSocket that
 * throws synchronously on `send()` for the first `failUntilAttempt`
 * outbound `blob_upload` frames, then behaves normally — simulates a
 * transient send failure (SPEC §7.25's "Upload failure & retry") without
 * ever actually dropping the connection, isolating a manual-retry test
 * from the separate connection-drop/reconnect path. `counter` is shared by
 * reference so it persists across the multiple socket instances the same
 * `RelayClient` creates on successive `connect()` calls.
 */
function flakyBlobUploadSocketCtor(counter: {
  attempts: number;
  failUntilAttempt: number;
}): WebSocketConstructor {
  return class FlakyBlobUploadSocket implements WebSocketLike {
    private readonly real: WebSocketLike;

    constructor(url: string) {
      this.real = new WebSocket(url) as unknown as WebSocketLike;
    }

    get readyState(): number {
      return this.real.readyState;
    }

    send(data: string): void {
      if (typeof data === 'string' && data.includes('"blob_upload"')) {
        counter.attempts += 1;
        if (counter.attempts <= counter.failUntilAttempt) {
          throw new Error(`FlakyBlobUploadSocket: simulated failure #${counter.attempts}`);
        }
      }
      this.real.send(data);
    }

    close(): void {
      this.real.close();
    }

    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: () => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    addEventListener(
      type: 'open' | 'message' | 'close' | 'error',
      listener: (() => void) | ((event: { data: unknown }) => void),
    ): void {
      switch (type) {
        case 'open':
          this.real.addEventListener('open', listener as () => void);
          return;
        case 'message':
          this.real.addEventListener('message', listener as (event: { data: unknown }) => void);
          return;
        case 'close':
          this.real.addEventListener('close', listener as () => void);
          return;
        case 'error':
          this.real.addEventListener('error', listener as () => void);
          return;
      }
    }
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

  it('does not send a wire frame while the socket is not yet open, but queues the prompt for the offline outbox instead of faking a sent transcript entry (issue #130)', () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-offline',
      deviceId: 'client-5',
      outboxStorage: createInMemoryOutboxStorage(),
    });
    // sendPrompt before connect(): should not throw, and should not send a
    // wire frame — instead it queues locally (issue #130's offline
    // composer outbox), NOT an optimistic "sent" transcript entry, since
    // this prompt hasn't actually reached the node yet.
    const promptId = client.sendPrompt('sess_never_connected', 'hello?');
    const transcript = client.transcriptFor('sess_never_connected');
    expect(get(transcript).items).toEqual([]);

    const queued = client.queuedPromptsFor('sess_never_connected');
    expect(get(queued)).toEqual([
      expect.objectContaining({ id: promptId, sessionId: 'sess_never_connected', text: 'hello?' }),
    ]);
  });
});

describe('RelayClient: turn Stop/interrupt (SPEC §7.3/§7.24; issue #129)', () => {
  it('interruptTurn cancels every open permission request for the session, same as cancelPermissionRequests', async () => {
    const amk = generateAmk();
    const accountId = 'acct-interrupt';

    node = new FakeNode(relay.url, {
      deviceId: 'node-interrupt',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_interrupt', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-interrupt' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc-interrupt' }, options: [] },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-interrupt',
      envelope,
    });
    await waitForStore(queue, (value) => value.byId.size > 0);

    client.interruptTurn(session.id);

    expect(get(queue).byId.size).toBe(0);
  });

  it('interruptTurn settles the turn locally so a queued follow-up flushes right away instead of waiting out turnIdleMs — and never touches rollback/workspace state (no such call exists on this client)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-interrupt-queue';

    node = new FakeNode(relay.url, {
      deviceId: 'node-interrupt-queue',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_interrupt_queue', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-interrupt-queue',
      outboxStorage: createInMemoryOutboxStorage(),
      // Deliberately long: proves the flush below comes from interruptTurn
      // itself, not from the turnIdleMs fallback timer happening to fire.
      turnIdleMs: 60_000,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const queued = client.queuedPromptsFor(session.id);
    const firstId = client.sendPrompt(session.id, 'first, in flight');
    await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === firstId,
    );

    const secondId = client.sendPrompt(session.id, 'second, queued behind the first turn');
    expect(get(queued)).toEqual([expect.objectContaining({ id: secondId, sessionId: session.id })]);

    client.interruptTurn(session.id);

    const secondRouted = (await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === secondId,
    )) as PromptInjectV1;
    expect(secondRouted.sessionId).toBe(session.id);
    await waitForStore(queued, (value) => value.length === 0);
  });
});

describe('RelayClient: stale approve/deny discard (SPEC §7.3; issue #131)', () => {
  it('resolving a request this client already resolved is a graceful no-op: no second permission_response is sent, and a stale notice is published instead of erroring', async () => {
    const amk = generateAmk();
    const accountId = 'acct-stale-local';

    node = new FakeNode(relay.url, {
      deviceId: 'node-stale-local',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_stale_local', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-stale-local',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    const staleNotice = client.staleNoticeFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const option = { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const };
    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc-stale' }, options: [option] },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-stale-local',
      envelope,
    });
    await waitForStore(queue, (value) => value.byId.size > 0);

    // The first (real) resolve — same path already covered elsewhere, just
    // the setup this test's actual case (the second, stale resolve) needs.
    client.resolvePermission(session.id, 'req-stale-local', option);
    await node.waitFor((m) => m.type === 'permission_response');
    expect(get(staleNotice)).toBeUndefined();

    // The late/duplicate action — a double click, or a click that lands
    // after the card already re-rendered without it (SPEC §7.3's "no
    // longer applies" rule).
    client.resolvePermission(session.id, 'req-stale-local', option);

    expect(node.messages.filter((m) => m.type === 'permission_response')).toHaveLength(1);
    const notice = get(staleNotice);
    expect(notice?.requestId).toBe('req-stale-local');
    expect(notice?.message).toMatch(/no longer applies/i);
  });

  it('two clients racing the same permission request: once the tool call update reveals device A already resolved it, device B auto-discards its own copy and a late resolve on B is a stale no-op, not a second permission_response', async () => {
    const amk = generateAmk();
    const accountId = 'acct-stale-race';

    node = new FakeNode(relay.url, {
      deviceId: 'node-stale-race',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_stale_race', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // Device A.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-stale-race-a',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessionsA = await waitForStore(client.sessions, (value) => value.length > 0);
    const queueA = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessionsA);

    // Device B — a second, independent RelayClient on the SAME account,
    // exactly like a second browser tab/phone watching the same session.
    const clientB = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-stale-race-b',
    });
    try {
      clientB.connect();
      await waitForStore(clientB.status, (status) => status === 'open');
      const initialSessionsB = await waitForStore(clientB.sessions, (value) => value.length > 0);
      const queueB = clientB.permissionQueueFor(session.id);
      const staleNoticeB = clientB.staleNoticeFor(session.id);
      await waitForStoreChange(clientB.sessions, initialSessionsB);

      const option = { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const };
      const envelope = await nodeSeal(
        session.id,
        { toolCall: { kind: 'tool_call', id: 'tc-race' }, options: [option] },
        key,
      );
      // The relay fans a live permission_request out to every subscribed
      // client on the account — both A and B see the exact same request.
      node.send({
        type: 'permission_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-race',
        envelope,
      });
      await waitForStore(queueA, (value) => value.byId.size > 0);
      await waitForStore(queueB, (value) => value.byId.size > 0);

      // Device A resolves first.
      client.resolvePermission(session.id, 'req-race', option);
      await node.waitFor((m) => m.type === 'permission_response');

      // v1's relay never broadcasts permission_response to sibling clients
      // (only routes it to the owning node) — B only learns the request
      // was already handled once the agent's own ordinary tool_call_update
      // reflects it, exactly like every other session_update fan-out.
      const statusEnvelope = await nodeSeal(
        session.id,
        { kind: 'tool_call_update', id: 'tc-race', status: 'completed' },
        key,
      );
      node.send({
        type: 'session_update',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        seq: 1,
        envelope: statusEnvelope,
      });
      await waitForStore(queueB, (value) => value.byId.size === 0);
      expect(get(staleNoticeB)?.requestId).toBe('req-race');

      // B's user, unaware, still submits the (now stale) approve — a
      // graceful no-op: the queue was already empty, so this must not
      // throw, must not send a second permission_response, and must
      // (re-)publish the stale notice rather than silently applying it.
      clientB.resolvePermission(session.id, 'req-race', option);

      expect(node.messages.filter((m) => m.type === 'permission_response')).toHaveLength(1);
      expect(get(staleNoticeB)?.requestId).toBe('req-race');
    } finally {
      clientB.close();
    }
  });
});

describe('RelayClient: attachments (SPEC §7.25; issues #151/#152/#153/#155)', () => {
  it("attachFile validates real image bytes, encrypts+uploads via blob_upload, and a peer (the node, exactly the executing host's own #156 download path) decrypts the exact original bytes (#151, #153)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach';

    node = new FakeNode(relay.url, {
      deviceId: 'node-attach',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_attach', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-attach' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const pngBytes = realPngBytes();
    const file = new File([pngBytes], 'photo.png', { type: 'image/png' });

    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);

    // Instant local state, before any network round trip.
    expect(get(attachments)).toEqual([
      expect.objectContaining({ id: attachmentId, name: 'photo.png', status: 'uploading' }),
    ]);

    const uploaded = await waitForStore(
      attachments,
      (list) => list.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );
    const entry = uploaded.find((a) => a.id === attachmentId)!;
    expect(entry.mimeType).toBe('image/png');
    // Instant local preview (SPEC §7.25), no network round trip involved.
    expect(entry.previewUrl).toMatch(/^blob:/);
    expect(entry.error).toBeUndefined();

    // The relay only ever received/stored ciphertext under blob_upload — a
    // peer (here: the node, exactly `@loombox/node`'s `AttachmentResolver`
    // path for #156) fetches it by ref and decrypts it back to the exact
    // original bytes.
    node.send({
      type: 'blob_download',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      ref: attachmentId,
    });
    const response = (await node.waitFor(
      (m) => m.type === 'blob_download_response',
    )) as BlobDownloadResponse;
    const decryptedBytes = await nodeOpenAttachment(
      session.id,
      attachmentId,
      response.envelope,
      key,
    );
    expect(decryptedBytes).toEqual(pngBytes);

    // The relay never saw the plaintext bytes.
    const raw = Buffer.from(response.envelope.ciphertext, 'base64');
    expect(raw.includes(Buffer.from('PNG'))).toBe(false);
  });

  it('attachFile rejects a HEIC file client-side with a clear convert-and-re-upload message, before any upload attempt (#152)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-heic';

    node = new FakeNode(relay.url, {
      deviceId: 'node-heic',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_heic', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-heic' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realHeicBytes()], 'photo.heic', { type: 'image/heic' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);

    const list = await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'rejected',
    );
    const entry = list.find((a) => a.id === attachmentId)!;
    expect(entry.error).toMatch(/heic\/heif/i);
    expect(entry.error).toMatch(/convert/i);
    expect(entry.error).toMatch(/re-upload/i);
    // A rejected attachment never blocks sending.
    expect(hasBlockingAttachments(list)).toBe(false);

    // Never uploaded: the relay has nothing stored under this ref.
    node.send({
      type: 'blob_download',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      ref: attachmentId,
    });
    await expect(node.waitFor((m) => m.type === 'blob_download_response', 200)).rejects.toThrow(
      /timed out/,
    );
  });

  it('attachFile rejects a spoofed file by its real sniffed bytes, ignoring its declared mimeType/extension (#151)', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-spoof',
      deviceId: 'client-spoof',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    // Declares itself as a PNG (name + mimeType) but its actual bytes are not an image.
    const file = new File([notAnImageBytes()], 'totally-a-photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor('sess_spoof');
    const attachmentId = client.attachFile('sess_spoof', file);

    const list = await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'rejected',
    );
    expect(list.find((a) => a.id === attachmentId)?.error).toMatch(/unsupported image type/i);
  });

  it('sendPrompt embeds only a fully-uploaded attachment as a PromptAttachmentRef the node decrypts, and clears it from the composer (#153)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-send-attach';

    node = new FakeNode(relay.url, {
      deviceId: 'node-send-attach',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_send_attach', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-send-attach',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realPngBytes()], 'photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );

    client.sendPrompt(session.id, 'here is a photo', [attachmentId]);

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    const decrypted = await nodeOpen<{
      text: string;
      attachments?: { ref: string; mimeType: string; name?: string }[];
    }>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({
      text: 'here is a photo',
      attachments: [{ ref: attachmentId, mimeType: 'image/png', name: 'photo.png' }],
    });

    // Sent attachments are cleared from the composer's pending list — they now belong to the sent prompt.
    expect(get(attachments)).toEqual([]);
  });

  it('sendPrompt never references a still-uploading attachment — a broken ref must never reach the agent (SPEC §7.25)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-broken-ref';

    node = new FakeNode(relay.url, {
      deviceId: 'node-broken-ref',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_broken_ref', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-broken-ref',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realPngBytes()], 'photo.png', { type: 'image/png' });
    // sendPrompt is called immediately, synchronously after attachFile —
    // before the async validate/encrypt/upload pipeline has had a chance
    // to run a single microtask, so the attachment is still 'uploading'.
    const attachmentId = client.attachFile(session.id, file);
    client.sendPrompt(session.id, 'quick, before it finishes', [attachmentId]);

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    const decrypted = await nodeOpen<{ text: string; attachments?: unknown }>(
      session.id,
      routed.envelope,
      key,
    );
    expect(decrypted).toEqual({ text: 'quick, before it finishes' });
  });

  it('retryAttachment re-uploads a failed attachment using its cached bytes, without re-reading the file (#155 manual retry)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-manual-retry';

    node = new FakeNode(relay.url, {
      deviceId: 'node-manual-retry',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_manual_retry', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // Fails exactly the FIRST blob_upload send (the initial attach attempt),
    // succeeds on every subsequent one (the manual retry) — the connection
    // itself is never dropped, isolating this from the reconnect path below.
    const counter = { attempts: 0, failUntilAttempt: 1 };
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-manual-retry',
      webSocketImpl: flakyBlobUploadSocketCtor(counter),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const bytes = realPngBytes();
    const file = new File([bytes], 'photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);

    const failed = await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'failed',
    );
    expect(failed.find((a) => a.id === attachmentId)?.error).toMatch(/upload failed/i);
    expect(counter.attempts).toBe(1);

    client.retryAttachment(session.id, attachmentId);

    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );
    expect(counter.attempts).toBe(2);

    // The retry uploaded the SAME bytes originally read, without asking for the file again.
    node.send({
      type: 'blob_download',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      ref: attachmentId,
    });
    const response = (await node.waitFor(
      (m) => m.type === 'blob_download_response',
    )) as BlobDownloadResponse;
    const decryptedBytes = await nodeOpenAttachment(
      session.id,
      attachmentId,
      response.envelope,
      key,
    );
    expect(decryptedBytes).toEqual(bytes);
  });

  it('a connection-dropped upload failure gets exactly one automatic retry on reconnect, never a second one (#155)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-auto-retry';

    node = new FakeNode(relay.url, {
      deviceId: 'node-auto-retry',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_auto_retry', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // The reconnect's own automatic retry attempt (the 2nd blob_upload send
    // overall) also fails, so `autoRetried` must be the only thing stopping
    // a 3rd, 4th, ... attempt on further reconnects — proving "exactly
    // once" rather than "retries until it works".
    const counter = { attempts: 0, failUntilAttempt: 2 };
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-auto-retry',
      webSocketImpl: flakyBlobUploadSocketCtor(counter),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realPngBytes()], 'photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'failed',
    );
    expect(counter.attempts).toBe(1);

    // Drop and reconnect — `connect()` alone is a no-op while a socket is
    // already open, so an actual connection drop (`close()`) is what makes
    // the next `connect()` reach a fresh `initialize_result`, matching what
    // a real dropped-and-recovered phone connection looks like from
    // RelayClient's point of view. The automatic retry fires — and, per
    // this test's setup, fails again too.
    client.close();
    await waitForStore(client.status, (status) => status === 'closed');
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'failed',
    );
    expect(counter.attempts).toBe(2);

    // A second drop+reconnect must NOT retry a third time — the one
    // automatic retry has already been used.
    client.close();
    await waitForStore(client.status, (status) => status === 'closed');
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    // Give any (incorrect) further auto-retry a moment to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counter.attempts).toBe(2);
    expect(get(attachments).find((a) => a.id === attachmentId)?.status).toBe('failed');

    // The manual retry control still works after the automatic one is spent.
    client.retryAttachment(session.id, attachmentId);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );
    expect(counter.attempts).toBe(3);
  });

  it('rejects the 21st image attached to the same prompt with a clear over-limit message (SPEC §7.25 default cap)', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-too-many',
      deviceId: 'client-too-many',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const attachments = client.attachmentsFor('sess_too_many');
    const ids: string[] = [];
    for (let i = 0; i < MAX_ATTACHMENTS_PER_PROMPT; i++) {
      const file = new File([realPngBytes(i + 1)], `photo-${i}.png`, { type: 'image/png' });
      ids.push(client.attachFile('sess_too_many', file));
    }
    await waitForStore(
      attachments,
      (value) => value.filter((a) => a.status === 'uploaded').length === MAX_ATTACHMENTS_PER_PROMPT,
    );

    const oneTooMany = new File([realPngBytes(99)], 'photo-extra.png', { type: 'image/png' });
    const extraId = client.attachFile('sess_too_many', oneTooMany);
    const list = get(attachments);
    const extraEntry = list.find((a) => a.id === extraId)!;
    expect(extraEntry.status).toBe('rejected');
    expect(extraEntry.error).toMatch(/up to 20 images/i);
  });

  it('removeAttachment drops a rejected/failed attachment from the composer', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-remove',
      deviceId: 'client-remove',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const file = new File([realHeicBytes()], 'photo.heic', { type: 'image/heic' });
    const attachments = client.attachmentsFor('sess_remove');
    const attachmentId = client.attachFile('sess_remove', file);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'rejected',
    );

    client.removeAttachment('sess_remove', attachmentId);
    expect(get(attachments)).toEqual([]);
  });
});

describe('RelayClient: session-lifecycle wire events (SPEC §7.13/§7.24/§8; issues #126/#128/#149)', () => {
  it('decrypts a session_status event into transcriptFor/statusFor, replacing an earlier status on the next transition', async () => {
    const amk = generateAmk();
    const accountId = 'acct-status';

    node = new FakeNode(relay.url, {
      deviceId: 'node-status',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_status', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-status' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const status = client.statusFor(session.id);
    const transcript = client.transcriptFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const workingEnvelope = await nodeSeal(
      session.id,
      { kind: 'session_status', status: 'working', updatedAt: 't1' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: workingEnvelope,
    });
    await waitForStore(status, (value) => value === 'working');
    expect(get(transcript).status).toBe('working');
    expect(get(transcript).statusUpdatedAt).toBe('t1');

    const permissionEnvelope = await nodeSeal(
      session.id,
      { kind: 'session_status', status: 'permission_required', updatedAt: 't2' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: permissionEnvelope,
    });
    await waitForStore(status, (value) => value === 'permission_required');
  });

  it('decrypts config_options / config_option_update into configOptionsFor, always replacing the whole catalog wholesale', async () => {
    const amk = generateAmk();
    const accountId = 'acct-config-wire';

    node = new FakeNode(relay.url, {
      deviceId: 'node-config-wire',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_config_wire', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-config-wire',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const options = client.configOptionsFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const catalog = [
      { category: 'model', current: 'sonnet', choices: [{ id: 'sonnet', name: 'Sonnet' }] },
    ];
    const catalogEnvelope = await nodeSeal(
      session.id,
      { kind: 'config_options', options: catalog },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: catalogEnvelope,
    });
    await waitForStore(options, (value) => value.length > 0);
    expect(get(options)).toEqual(catalog);

    // An unprompted config_option_update (e.g. an automatic cheaper-model
    // fallback) fully replaces the catalog too — never a per-category patch
    // (issue #149's "two missing acceptance bullets").
    const fallback = [
      { category: 'model', current: 'haiku', choices: [{ id: 'haiku', name: 'Haiku' }] },
    ];
    const fallbackEnvelope = await nodeSeal(
      session.id,
      { kind: 'config_option_update', options: fallback },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: fallbackEnvelope,
    });
    await waitForStore(options, (value) => value[0]?.current === 'haiku');
    expect(get(options)).toEqual(fallback);
  });

  it('flushes a queued prompt immediately on turn_ended, without waiting out the idle-timeout fallback', async () => {
    const amk = generateAmk();
    const accountId = 'acct-turn-ended';

    node = new FakeNode(relay.url, {
      deviceId: 'node-turn-ended',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_turn_ended', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-turn-ended',
      outboxStorage: createInMemoryOutboxStorage(),
      // Deliberately much longer than this test's own timeout budget: if the
      // queued prompt below only flushed via the idle-timeout fallback, this
      // test would time out rather than pass — proving turn_ended is what
      // actually flushed it, not the fallback.
      turnIdleMs: 60000,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const firstId = client.sendPrompt(session.id, 'first prompt');
    const firstRouted = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(firstRouted.promptId).toBe(firstId);

    const queued = client.queuedPromptsFor(session.id);
    const secondId = client.sendPrompt(session.id, 'second, queued');
    expect(get(queued)).toEqual([expect.objectContaining({ id: secondId, sessionId: session.id })]);

    const turnStartedEnvelope = await nodeSeal(
      session.id,
      { kind: 'turn_started', turnId: 'turn-1' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: turnStartedEnvelope,
    });
    await waitForStore(transcript, (value) => value.turnActive === true);

    const turnEndedEnvelope = await nodeSeal(
      session.id,
      { kind: 'turn_ended', turnId: 'turn-1', stopReason: 'end_turn' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: turnEndedEnvelope,
    });

    await waitForStore(transcript, (value) => value.turnActive === false);
    expect(get(transcript).lastStopReason).toBe('end_turn');

    const secondRouted = (await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === secondId,
    )) as PromptInjectV1;
    expect(secondRouted.sessionId).toBe(session.id);
    await waitForStore(queued, (value) => value.length === 0);
  });
});

describe('RelayClient: mid-turn composer queueing (issue #128)', () => {
  it("queues a follow-up submitted while this session's own turn is still active, then flushes it once idle, preserving order", async () => {
    const amk = generateAmk();
    const accountId = 'acct-midturn';

    node = new FakeNode(relay.url, {
      deviceId: 'node-midturn',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_midturn', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-midturn',
      outboxStorage: createInMemoryOutboxStorage(),
      turnIdleMs: 80,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const queued = client.queuedPromptsFor(session.id);

    const firstId = client.sendPrompt(session.id, 'first prompt');
    const firstRouted = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(firstRouted.promptId).toBe(firstId);

    // Submitted immediately after, while the first turn is still considered
    // in flight — must queue, not interrupt (SPEC §7.24's mid-turn composer
    // state bullet).
    const secondId = client.sendPrompt(session.id, 'second, queued');
    expect(get(queued)).toEqual([
      expect.objectContaining({ id: secondId, sessionId: session.id, text: 'second, queued' }),
    ]);
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(1);

    // Once the turn goes idle (no further activity), the queued prompt
    // flushes on its own, in order.
    const secondRouted = (await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === secondId,
    )) as PromptInjectV1;
    expect(secondRouted.sessionId).toBe(session.id);
    await waitForStore(queued, (value) => value.length === 0);
  });

  it('an inbound session_update alone (e.g. another device mid-turn on the same session) also holds the local queue open', async () => {
    const amk = generateAmk();
    const accountId = 'acct-midturn-remote';

    node = new FakeNode(relay.url, {
      deviceId: 'node-midturn-remote',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_midturn_remote', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-midturn-remote',
      outboxStorage: createInMemoryOutboxStorage(),
      turnIdleMs: 80,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const chunkEnvelope = await nodeSeal(
      session.id,
      {
        kind: 'agent_message_chunk',
        turnId: 'turn-remote',
        messageId: 'msg-remote',
        text: 'from another device',
      },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: chunkEnvelope,
    });
    await waitForStore(transcript, (value) => value.items.length > 0);

    const queued = client.queuedPromptsFor(session.id);
    const promptId = client.sendPrompt(session.id, "queued behind another device's turn");
    expect(get(queued)).toEqual([expect.objectContaining({ id: promptId, sessionId: session.id })]);
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(0);

    await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === promptId,
    );
    await waitForStore(queued, (value) => value.length === 0);
  });
});

describe('RelayClient: offline composer outbox (issue #130)', () => {
  it('a prompt composed with no relay connection is queued and persisted to IndexedDB, then flushes automatically once connected', async () => {
    const amk = generateAmk();
    const accountId = 'acct-offline-outbox';

    node = new FakeNode(relay.url, {
      deviceId: 'node-offline-outbox',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_offline_outbox', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // Composed before `connect()` is ever called — no relay connection
    // exists yet. Uses the DEFAULT (IndexedDB-backed, via the
    // `fake-indexeddb` polyfill this test file installs) outbox storage, to
    // exercise the real production persistence path end to end.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-offline-outbox',
    });
    const promptId = client.sendPrompt(session.id, 'composed offline');

    const queued = client.queuedPromptsFor(session.id);
    expect(get(queued)).toEqual([
      expect.objectContaining({ id: promptId, sessionId: session.id, text: 'composed offline' }),
    ]);

    // Actually persisted, not just held in memory — a fresh storage handle
    // for the SAME account already sees it before this client even connects.
    const outboxStorage = createIndexedDbOutboxStorage(accountId);
    await waitForOutbox(outboxStorage, (list) => list.length > 0);

    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(routed.promptId).toBe(promptId);
    const decrypted = await nodeOpen<{ text: string }>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({ text: 'composed offline' });

    await waitForStore(queued, (value) => value.length === 0);
    await waitForOutbox(outboxStorage, (list) => list.length === 0);
  });

  it('a queued prompt persisted to IndexedDB survives a simulated reload (a fresh RelayClient for the same account) and is flushed exactly once on reconnect', async () => {
    const amk = generateAmk();
    const accountId = 'acct-reload-outbox';

    node = new FakeNode(relay.url, {
      deviceId: 'node-reload-outbox',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_reload_outbox', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // "Before the reload": composes offline and is torn down without ever
    // having connected — nothing was ever actually sent, only persisted.
    const before = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-before-reload',
    });
    const promptId = before.sendPrompt(session.id, 'survive the reload');
    const outboxStorage = createIndexedDbOutboxStorage(accountId);
    await waitForOutbox(outboxStorage, (list) => list.length > 0);
    before.close();

    // "After the reload": a brand-new RelayClient instance for the SAME
    // account — nothing shared with `before` except the same IndexedDB
    // database this account's outbox lives in.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-after-reload',
    });
    await waitForStore(client.queuedPromptsFor(session.id), (value) => value.length > 0);

    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(routed.promptId).toBe(promptId);
    await waitForStore(client.queuedPromptsFor(session.id), (value) => value.length === 0);
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(1);

    // A second reconnect must NOT resend it — exactly once, mirroring
    // issue #155's attachment auto-retry "exactly once" guarantee.
    client.close();
    await waitForStore(client.status, (status) => status === 'closed');
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(1);

    await waitForOutbox(outboxStorage, (list) => list.length === 0);
  });
});

describe('RelayClient: file-tree panel (SPEC §7.4; issue #171)', () => {
  it('fileTreeFor lazily loads the root directory, decrypting a real fs_list_response the node opaquely routed back', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-root';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_root', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);

    // fileTreeFor sent session_resume + an fs_list_request for the root
    // ('') path; the request must never carry the path in the clear.
    const request = (await node.waitFor((m) => m.type === 'fs_list_request')) as {
      type: 'fs_list_request';
      sessionId: string;
      targetId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(request.sessionId).toBe(session.id);
    expect(request.targetId).toBe('local');
    expect(Object.keys(request).sort()).toEqual(
      ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'targetId', 'type'].sort(),
    );
    const requestPayload = await nodeOpen<{ path: string }>(session.id, request.envelope, key);
    expect(requestPayload).toEqual({ path: '' });

    const responseEnvelope = await nodeSeal(
      session.id,
      {
        outcome: 'ok',
        path: '',
        entries: [
          { name: 'README.md', kind: 'file', size: 42 },
          { name: 'src', kind: 'dir', size: 0 },
        ],
      },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    const loaded = await waitForStore(tree, (value) => value.get('')?.status === 'loaded');
    expect(loaded.get('')).toEqual({
      path: '',
      status: 'loaded',
      entries: [
        { name: 'README.md', kind: 'file', size: 42 },
        { name: 'src', kind: 'dir', size: 0 },
      ],
    });
  });

  it('expandDirectory lazily loads a nested directory on demand, and is a no-op while already loading/loaded', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-nested';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_nested', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);
    const rootRequest = (await node.waitFor((m) => m.type === 'fs_list_request')) as {
      requestId: string;
    };
    const rootResponseEnvelope = await nodeSeal(
      session.id,
      { outcome: 'ok', path: '', entries: [{ name: 'src', kind: 'dir', size: 0 }] },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: rootRequest.requestId,
      envelope: rootResponseEnvelope,
    });
    await waitForStore(tree, (value) => value.get('')?.status === 'loaded');

    // Not yet in the tree — the nested directory has NOT been eagerly
    // fetched just because the root loaded (SPEC §7.4's lazy-expand
    // requirement).
    expect(get(tree).has('src')).toBe(false);

    client.expandDirectory(session.id, 'src');
    // A second call while still loading must not send a second request.
    client.expandDirectory(session.id, 'src');

    const nestedRequests = await node.waitFor((m) => {
      if (m.type !== 'fs_list_request') return false;
      return (m as { requestId: string }).requestId !== rootRequest.requestId;
    });
    const nestedRequest = nestedRequests as { requestId: string };
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.messages.filter((m) => m.type === 'fs_list_request')).toHaveLength(2);

    const nestedResponseEnvelope = await nodeSeal(
      session.id,
      { outcome: 'ok', path: 'src', entries: [{ name: 'index.ts', kind: 'file', size: 10 }] },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: nestedRequest.requestId,
      envelope: nestedResponseEnvelope,
    });

    const loaded = await waitForStore(tree, (value) => value.get('src')?.status === 'loaded');
    expect(loaded.get('src')).toEqual({
      path: 'src',
      status: 'loaded',
      entries: [{ name: 'index.ts', kind: 'file', size: 10 }],
    });

    // A third call once loaded must also not re-fetch.
    client.expandDirectory(session.id, 'src');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.messages.filter((m) => m.type === 'fs_list_request')).toHaveLength(2);
  });

  it('surfaces an error outcome (e.g. path-traversal refusal) as status "error" rather than hanging', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-error';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_error', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);
    const request = (await node.waitFor((m) => m.type === 'fs_list_request')) as {
      requestId: string;
    };
    const errorEnvelope = await nodeSeal(
      session.id,
      { outcome: 'error', path: '', message: 'path escapes the project root' },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: errorEnvelope,
    });

    const errored = await waitForStore(tree, (value) => value.get('')?.status === 'error');
    expect(errored.get('')).toEqual({
      path: '',
      status: 'error',
      entries: [],
      error: 'path escapes the project root',
    });
  });

  it("a client ignores an fs_list_response for another device's own pending request on the same session (fanned out, not addressed)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-sibling';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_sibling', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);
    await node.waitFor((m) => m.type === 'fs_list_request'); // this client's own root request

    // A reply to a requestId this client never sent (a sibling device's
    // own request, fanned out to every subscriber of the session).
    const foreignEnvelope = await nodeSeal(
      session.id,
      { outcome: 'ok', path: 'other-dir', entries: [] },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-not-mine',
      envelope: foreignEnvelope,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(get(tree).has('other-dir')).toBe(false);
  });
});

describe('RelayClient: listTargets (issue #383)', () => {
  it("resolves with the account's targets, marked reachable while the announcing node stays connected", async () => {
    const amk = generateAmk();
    const accountId = 'acct-targets-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-targets-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      targets: [
        { id: 'local', kind: 'local', label: 'This machine' },
        { id: 'ssh_devbox', kind: 'ssh', label: 'devbox' },
      ],
    });
    // Give the relay a beat to record the announce before the client asks.
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-targets-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const targets = await client.listTargets();
    expect(targets).toHaveLength(2);
    expect(targets).toEqual(
      expect.arrayContaining([
        {
          nodeId: 'node_1',
          targetId: 'local',
          label: 'This machine',
          kind: 'local',
          reachable: true,
        },
        {
          nodeId: 'node_1',
          targetId: 'ssh_devbox',
          label: 'devbox',
          kind: 'ssh',
          reachable: true,
        },
      ]),
    );
  });

  it("never resolves with another account's targets", async () => {
    const amk = generateAmk();
    const ownerAccountId = 'acct-targets-owner';
    const intruderAccountId = 'acct-targets-intruder';

    node = new FakeNode(relay.url, {
      deviceId: 'node-targets-2',
      devicePublicKey: randomBase64(),
      authToken: ownerAccountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_owner',
      targets: [{ id: 'local', kind: 'local', label: 'This machine' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: intruderAccountId,
      deviceId: 'client-targets-intruder',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const targets = await client.listTargets();
    expect(targets).toEqual([]);
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-targets-no-conn',
      deviceId: 'client-targets-no-conn',
    });
    // Deliberately never connected.
    await expect(client.listTargets()).rejects.toThrow(/no open connection/);
  });

  it("passes through a target's latest CPU/RAM/disk reading (issues #253/#269) once its node has pushed a target_status", async () => {
    const amk = generateAmk();
    const accountId = 'acct-targets-health';

    node = new FakeNode(relay.url, {
      deviceId: 'node-targets-health',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_health',
      targets: [{ id: 'local', kind: 'local', label: 'This machine' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    node.send({
      type: 'target_status',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_health',
      samples: [
        {
          targetId: 'local',
          cpuPercent: 33,
          memPercent: 44,
          memUsedBytes: 4,
          memTotalBytes: 9,
          diskPercent: 55,
          diskUsedBytes: 5,
          diskTotalBytes: 9,
          healthy: true,
          sampledAt: 1_700_000_000_000,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-targets-health',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const targets = await client.listTargets();
    const local = targets.find((target) => target.targetId === 'local');
    expect(local?.health).toEqual({
      cpuPercent: 33,
      memPercent: 44,
      memUsedBytes: 4,
      memTotalBytes: 9,
      diskPercent: 55,
      diskUsedBytes: 5,
      diskTotalBytes: 9,
      healthy: true,
      sampledAt: 1_700_000_000_000,
    });
  });
});

describe('RelayClient: interactive PTY terminals (SPEC §7.5; issues #172/#173/#174)', () => {
  it('openTerminal sends an encrypted terminal_open, flips to open on terminal_opened ok, streams decrypted output to onTerminalOutput listeners, and resize/close send their own encrypted/plain frames', async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_1', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalId = client.openTerminal(session.id, 80, 24);
    expect(get(terminals).get(terminalId)?.status).toBe('opening');

    const openRequest = (await node.waitFor((m) => m.type === 'terminal_open')) as {
      type: 'terminal_open';
      sessionId: string;
      targetId: string;
      terminalId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(openRequest.sessionId).toBe(session.id);
    expect(openRequest.targetId).toBe('local');
    expect(openRequest.terminalId).toBe(terminalId);
    expect(Object.keys(openRequest).sort()).toEqual(
      [
        'envelope',
        'protocolVersion',
        'requestId',
        'sessionId',
        'targetId',
        'terminalId',
        'type',
      ].sort(),
    );
    const openPayload = await nodeOpen<{ cols: number; rows: number }>(
      session.id,
      openRequest.envelope,
      key,
    );
    expect(openPayload).toEqual({ cols: 80, rows: 24 });

    node.send({
      type: 'terminal_opened',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      requestId: openRequest.requestId,
      envelope: await nodeSeal(session.id, { outcome: 'ok' }, key),
    });
    await waitForStore(terminals, (value) => value.get(terminalId)?.status === 'open');

    // Output: node -> client, decrypted and fanned out to onTerminalOutput.
    const received: Uint8Array[] = [];
    const unsubscribe = client.onTerminalOutput(session.id, terminalId, (chunk) => {
      received.push(chunk);
    });
    const outputBytes = new TextEncoder().encode('hello from the shell');
    node.send({
      type: 'terminal_output',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      envelope: await nodeSeal(
        session.id,
        { data: Buffer.from(outputBytes).toString('base64') },
        key,
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe('hello from the shell');
    unsubscribe();

    // Input: client -> node, encrypted, base64 bytes inside.
    client.sendTerminalInput(session.id, terminalId, 'echo hi\n');
    const inputMessage = (await node.waitFor((m) => m.type === 'terminal_input')) as {
      type: 'terminal_input';
      sessionId: string;
      terminalId: string;
      envelope: EncryptedEnvelope;
    };
    expect(Object.keys(inputMessage).sort()).toEqual(
      ['envelope', 'protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
    );
    const inputPayload = await nodeOpen<{ data: string }>(session.id, inputMessage.envelope, key);
    expect(Buffer.from(inputPayload.data, 'base64').toString('utf8')).toBe('echo hi\n');

    // Resize: client -> node, encrypted.
    client.resizeTerminal(session.id, terminalId, 120, 40);
    const resizeMessage = (await node.waitFor((m) => m.type === 'terminal_resize')) as {
      type: 'terminal_resize';
      envelope: EncryptedEnvelope;
    };
    const resizePayload = await nodeOpen<{ cols: number; rows: number }>(
      session.id,
      resizeMessage.envelope,
      key,
    );
    expect(resizePayload).toEqual({ cols: 120, rows: 40 });

    // Close: client -> node, no envelope.
    client.closeTerminal(session.id, terminalId);
    const closeMessage = await node.waitFor((m) => m.type === 'terminal_close');
    expect(Object.keys(closeMessage).sort()).toEqual(
      ['protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
    );

    // terminal_closed: node -> client, flips status to closed with a reason.
    node.send({
      type: 'terminal_closed',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      envelope: await nodeSeal(session.id, { reason: 'closed_by_client' }, key),
    });
    const closedState = await waitForStore(
      terminals,
      (value) => value.get(terminalId)?.status === 'closed',
    );
    expect(closedState.get(terminalId)?.closedReason).toBe('closed_by_client');
  });

  it('a failed terminal_open (error outcome) flips the terminal to error with the node-supplied message', async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_2', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalId = client.openTerminal(session.id, 80, 24);
    const openRequest = (await node.waitFor((m) => m.type === 'terminal_open')) as {
      type: 'terminal_open';
      requestId: string;
    };

    node.send({
      type: 'terminal_opened',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      requestId: openRequest.requestId,
      envelope: await nodeSeal(
        session.id,
        { outcome: 'error', message: 'no shell available' },
        key,
      ),
    });

    const errored = await waitForStore(
      terminals,
      (value) => value.get(terminalId)?.status === 'error',
    );
    expect(errored.get(terminalId)?.error).toBe('no shell available');
  });

  it("a client ignores a terminal_opened for another device's own pending request on the same session (fanned out, not addressed)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-3';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_3', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalId = client.openTerminal(session.id, 80, 24);
    await node.waitFor((m) => m.type === 'terminal_open'); // this client's own request

    node.send({
      type: 'terminal_opened',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId: 'sibling-terminal',
      requestId: 'req-not-mine',
      envelope: await nodeSeal(session.id, { outcome: 'ok' }, key),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(get(terminals).get(terminalId)?.status).toBe('opening');
    expect(get(terminals).has('sibling-terminal')).toBe(false);
  });

  it('opening a second terminal for the same session is independent of the first (issue #173: multiple terminals per session)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-4';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_4', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalA = client.openTerminal(session.id, 80, 24);
    const terminalB = client.openTerminal(session.id, 80, 24);
    expect(terminalA).not.toBe(terminalB);

    const deadline = Date.now() + 3000;
    while (node.messages.filter((msg) => msg.type === 'terminal_open').length < 2) {
      if (Date.now() > deadline) throw new Error('timed out waiting for both terminal_open frames');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const opens = node.messages.filter((msg) => msg.type === 'terminal_open') as Array<{
      type: 'terminal_open';
      terminalId: string;
      requestId: string;
    }>;

    for (const request of opens) {
      node!.send({
        type: 'terminal_opened',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        terminalId: request.terminalId,
        requestId: request.requestId,
        envelope: await nodeSeal(session.id, { outcome: 'ok' }, key),
      });
    }

    await waitForStore(
      terminals,
      (value) => value.get(terminalA)?.status === 'open' && value.get(terminalB)?.status === 'open',
    );

    // Closing terminalA must not affect terminalB's state.
    client.closeTerminal(session.id, terminalA);
    node!.send({
      type: 'terminal_closed',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId: terminalA,
      envelope: await nodeSeal(session.id, { reason: 'closed_by_client' }, key),
    });
    await waitForStore(terminals, (value) => value.get(terminalA)?.status === 'closed');
    expect(get(terminals).get(terminalB)?.status).toBe('open');
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

describe('RelayClient: cross-project attention inbox (SPEC §7.13; issues #167/#168/#169)', () => {
  it('aggregates a pending permission request and an awaiting_input session across sessions, sorted oldest-waiting first, and stays consistent with the session-scoped queue', async () => {
    const amk = generateAmk();
    const accountId = 'acct-inbox';

    node = new FakeNode(relay.url, {
      deviceId: 'node-inbox',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const sessionA = makeSessionMeta({ id: 'sess_inbox_a', accountId });
    const sessionB = makeSessionMeta({ id: 'sess_inbox_b', accountId });
    const keyA = await deriveNodeSessionKey(amk, accountId, sessionA.id);
    const keyB = await deriveNodeSessionKey(amk, accountId, sessionB.id);
    const privateA = await nodeSeal(
      sessionA.id,
      { title: 'Fix the bug', projectPath: '/proj-a' },
      keyA,
    );
    const privateB = await nodeSeal(
      sessionB.id,
      { title: 'Add feature', projectPath: '/proj-b' },
      keyB,
    );
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionA,
      privateEnvelope: privateA,
    });
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionB,
      privateEnvelope: privateB,
    });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-inbox' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length === 2);

    // Calling attentionInbox() subscribes BOTH sessions even though neither
    // has been opened via transcriptFor/permissionQueueFor — the whole
    // point of a cross-session view. Wait for both subscription-confirming
    // session_announce replies before the node emits anything, so neither
    // event races ahead of the relay actually registering the subscription
    // (waitForNotificationCount, not two chained waitForStoreChange calls,
    // since the latter can miss the first of two rapid-fire changes).
    const inbox = client.attentionInbox();
    await waitForNotificationCount(client.sessions, 2);

    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    ];
    const permissionEnvelope = await nodeSeal(
      sessionA.id,
      { toolCall: { kind: 'tool_call', id: 'tc-a', title: 'Run tests' }, options },
      keyA,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      requestId: 'req-inbox-a',
      envelope: permissionEnvelope,
    });

    // Session B transitions to awaiting_input with a deliberately EARLIER
    // timestamp than session A's permission request (sent second on the
    // wire) — an oldest-first sort must still put B ahead of A.
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const statusEnvelope = await nodeSeal(
      sessionB.id,
      { kind: 'session_status', status: 'awaiting_input', updatedAt: earlier },
      keyB,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      seq: 1,
      envelope: statusEnvelope,
    });

    const items = await waitForStore(inbox, (value) => value.length === 2);
    expect(items.map((item) => item.kind)).toEqual(['awaiting_input', 'permission']);
    expect(items[0]).toMatchObject({
      sessionId: sessionB.id,
      sessionTitle: 'Add feature',
      projectPath: '/proj-b',
      nodeId: sessionB.nodeId,
    });
    expect(items[1]).toMatchObject({
      sessionId: sessionA.id,
      sessionTitle: 'Fix the bug',
      projectPath: '/proj-a',
      nodeId: sessionA.nodeId,
      permission: expect.objectContaining({ requestId: 'req-inbox-a' }),
    });

    // The session view's own queue for A carries the exact same pending
    // request — subscribing here mirrors what the UI does when the user
    // opens that session directly (issue #169's single source of truth).
    const queueA = client.permissionQueueFor(sessionA.id);
    expect(get(queueA).byId.has('req-inbox-a')).toBe(true);

    // Approving from the inbox (the exact RelayClient call the inbox
    // component's approve button makes) resolves it in the session's own
    // queue too, and the item disappears from the inbox.
    client.resolvePermission(sessionA.id, 'req-inbox-a', options[0]);
    expect(get(queueA).byId.has('req-inbox-a')).toBe(false);
    const afterApprove = await waitForStore(inbox, (value) => value.length === 1);
    expect(afterApprove[0]?.sessionId).toBe(sessionB.id);

    // "Resolved elsewhere": a second permission request on B, cancelled via
    // the session-level Stop control (not through the inbox at all), must
    // also vanish from the inbox — proving the inbox holds no separate copy
    // of queue state it could fall out of sync with.
    const secondPermissionEnvelope = await nodeSeal(
      sessionB.id,
      { toolCall: { kind: 'tool_call', id: 'tc-b' }, options: [options[0]] },
      keyB,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      requestId: 'req-inbox-b',
      envelope: secondPermissionEnvelope,
    });
    await waitForStore(inbox, (value) => value.some((item) => item.kind === 'permission'));

    client.cancelPermissionRequests(sessionB.id);
    const final = await waitForStore(
      inbox,
      (value) => !value.some((item) => item.kind === 'permission'),
    );
    expect(
      final.some((item) => item.sessionId === sessionB.id && item.kind === 'awaiting_input'),
    ).toBe(true);
  });
});

describe('RelayClient: attention inbox session-outcome class (SPEC §7.13; issue #167)', () => {
  it('surfaces a session_outcome item live when a session settles to exited or error, replacing it in place, and clears it when the session resumes working', async () => {
    const amk = generateAmk();
    const accountId = 'acct-inbox-outcome';

    node = new FakeNode(relay.url, {
      deviceId: 'node-inbox-outcome',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const sessionA = makeSessionMeta({ id: 'sess_outcome_a', accountId });
    const sessionB = makeSessionMeta({ id: 'sess_outcome_b', accountId, nodeId: 'node_2' });
    const keyA = await deriveNodeSessionKey(amk, accountId, sessionA.id);
    const keyB = await deriveNodeSessionKey(amk, accountId, sessionB.id);
    const privateA = await nodeSeal(
      sessionA.id,
      { title: 'Refactor module', projectPath: '/proj-a' },
      keyA,
    );
    const privateB = await nodeSeal(
      sessionB.id,
      { title: 'Migrate DB', projectPath: '/proj-b' },
      keyB,
    );
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionA,
      privateEnvelope: privateA,
    });
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionB,
      privateEnvelope: privateB,
    });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-outcome' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length === 2);

    const inbox = client.attentionInbox();
    await waitForNotificationCount(client.sessions, 2);

    // Session A finishes cleanly.
    const finishedEnvelope = await nodeSeal(
      sessionA.id,
      { kind: 'session_status', status: 'exited', updatedAt: new Date().toISOString() },
      keyA,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      seq: 1,
      envelope: finishedEnvelope,
    });

    const afterFinish = await waitForStore(inbox, (value) => value.length === 1);
    expect(afterFinish[0]).toMatchObject({
      kind: 'session_outcome',
      sessionId: sessionA.id,
      sessionTitle: 'Refactor module',
      projectPath: '/proj-a',
      nodeId: sessionA.nodeId,
      outcome: 'exited',
    });

    // Session B errors — both session_outcome items coexist, each tagged
    // with its own node and outcome (cross-node, class-distinguished).
    const erroredEnvelope = await nodeSeal(
      sessionB.id,
      {
        kind: 'session_status',
        status: 'error',
        updatedAt: new Date(Date.now() - 1000).toISOString(),
      },
      keyB,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      seq: 1,
      envelope: erroredEnvelope,
    });

    const afterError = await waitForStore(inbox, (value) => value.length === 2);
    // B errored a second EARLIER than A finished, so the oldest-first sort
    // puts B ahead of A even though A's event was sent first.
    expect(afterError.map((item) => [item.sessionId, item.kind, item.outcome])).toEqual([
      [sessionB.id, 'session_outcome', 'error'],
      [sessionA.id, 'session_outcome', 'exited'],
    ]);
    expect(afterError[0].nodeId).toBe(sessionB.nodeId);

    // Session A resumes working: its session_outcome item must disappear
    // (a live status transition away from exited/error clears it, exactly
    // like awaiting_input does), leaving only B's.
    const resumedEnvelope = await nodeSeal(
      sessionA.id,
      { kind: 'session_status', status: 'working', updatedAt: new Date().toISOString() },
      keyA,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      seq: 2,
      envelope: resumedEnvelope,
    });

    const afterResume = await waitForStore(inbox, (value) => value.length === 1);
    expect(afterResume[0].sessionId).toBe(sessionB.id);
  });
});

describe('RelayClient: recovery-code AMK escrow + new-device bootstrap (SPEC §8 path 2, §16; issues #114/#115)', () => {
  it('escrows the AMK from a first device, then a fresh device bootstraps from just the Recovery Code and decrypts a session the first device could', async () => {
    const accountId = 'acct-recovery';
    const recoveryCode = generateRecoveryCode();
    const amk = generateAmk();

    // The first device: escrows its AMK to the relay.
    const firstDevice = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'device-first',
    });
    firstDevice.connect();
    await waitForStore(firstDevice.status, (status) => status === 'open');
    await firstDevice.escrowAmk(recoveryCode);

    // A node announces a session under this account, sealed under the
    // first device's AMK-derived session key.
    node = new FakeNode(relay.url, {
      deviceId: 'node-recovery',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    const session = makeSessionMeta({ id: 'sess_recovery', accountId });
    const sessionKey = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'recovered session', projectPath: '/proj-recovery' },
      sessionKey,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // A brand-new device, with no prior state at all: OAuth identity
    // (`accountId`/`authToken`) plus only the Recovery Code — no previously
    // trusted device involved.
    const bootstrapped = await bootstrapAmkFromRecoveryCode({
      relayUrl: relay.url,
      accountId,
      deviceId: 'device-new',
      recoveryCode,
    });
    expect(bootstrapped.amk).toEqual(amk);
    // SPEC §8: bootstrap also generates the new device's own ECDH P-256
    // identity keypair (not the placeholder random bytes RelayClient uses
    // when no keypair is supplied).
    expect(bootstrapped.deviceKeyPair).toBeDefined();
    expect(bootstrapped.devicePublicKey).toBeTruthy();
    expect(bootstrapped.deviceId).toBe('device-new');

    client = new RelayClient({
      relayUrl: relay.url,
      amk: bootstrapped.amk,
      accountId,
      deviceId: bootstrapped.deviceId,
      devicePublicKey: bootstrapped.devicePublicKey,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const sessions = (await waitForStore(
      client.sessions,
      (value) => value.length > 0,
    )) as ClientSessionMeta[];
    expect(sessions).toEqual([
      { ...session, title: 'recovered session', projectPath: '/proj-recovery' },
    ]);
  });

  it('rejects bootstrap with the wrong Recovery Code', async () => {
    const accountId = 'acct-recovery-wrong-code';
    const amk = generateAmk();

    const firstDevice = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'device-first',
    });
    firstDevice.connect();
    await waitForStore(firstDevice.status, (status) => status === 'open');
    await firstDevice.escrowAmk(generateRecoveryCode());

    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: relay.url,
        accountId,
        deviceId: 'device-new',
        recoveryCode: generateRecoveryCode(),
      }),
    ).rejects.toThrow();
  });

  it('rejects bootstrap for an account that has never escrowed an AMK', async () => {
    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: relay.url,
        accountId: 'acct-never-escrowed',
        deviceId: 'device-new',
        recoveryCode: generateRecoveryCode(),
        timeoutMs: 200,
      }),
    ).rejects.toThrow();
  });

  it('escrowAmk rejects when called before the connection is open', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-not-connected',
      deviceId: 'device-x',
    });
    await expect(client.escrowAmk(generateRecoveryCode())).rejects.toThrow();
  });
});

describe('RelayClient: createSession (SPEC §7.1; issue #385)', () => {
  it('sends a session_create matching the wire schema, waits for the node-created session to appear, then sends the starting prompt as a follow-up', async () => {
    const amk = generateAmk();
    const accountId = 'acct-create-session-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-create-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_create_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-create-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const createPromise = client.createSession({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/project',
      title: 'my new session',
      prompt: 'get started please',
    });

    const createMessage = (await node.waitFor((m) => m.type === 'session_create')) as {
      type: 'session_create';
      protocolVersion: typeof PROTOCOL_V1;
      sessionId: string;
      targetId: string;
      provider: string;
      privateEnvelope: EncryptedEnvelope;
    };
    expect(Object.keys(createMessage).sort()).toEqual(
      ['privateEnvelope', 'protocolVersion', 'provider', 'sessionId', 'targetId', 'type'].sort(),
    );
    expect(createMessage.targetId).toBe('local');
    expect(createMessage.provider).toBe('claude');

    const sessionKey = await deriveNodeSessionKey(amk, accountId, createMessage.sessionId);
    const decryptedMeta = await nodeOpen<{ title: string; projectPath: string }>(
      createMessage.sessionId,
      createMessage.privateEnvelope,
      sessionKey,
    );
    expect(decryptedMeta).toEqual({ title: 'my new session', projectPath: '/home/dev/project' });

    // Simulate the node: creates the session, then announces it (mirrors
    // `NodeDaemon.handleSessionCreate`/`announce`).
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: makeSessionMeta({
        id: createMessage.sessionId,
        nodeId: 'node_create_1',
        targetId: 'local',
        accountId,
        provider: 'claude',
      }),
      privateEnvelope: createMessage.privateEnvelope,
    });

    const sessionId = await createPromise;
    expect(sessionId).toBe(createMessage.sessionId);
    expect(get(client.sessions).some((session) => session.id === sessionId)).toBe(true);

    const promptMessage = (await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).sessionId === sessionId,
    )) as PromptInjectV1;
    const promptPayload = await nodeOpen<{ text: string }>(
      sessionId,
      promptMessage.envelope,
      sessionKey,
    );
    expect(promptPayload.text).toBe('get started please');
  });

  it('creates a promptless session when no starting prompt is given', async () => {
    const amk = generateAmk();
    const accountId = 'acct-create-session-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-create-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_create_2',
      targets: [{ id: 'local', kind: 'local', label: 'This machine' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-create-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const createPromise = client.createSession({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/project-2',
    });

    const createMessage = (await node.waitFor((m) => m.type === 'session_create')) as {
      sessionId: string;
      privateEnvelope: EncryptedEnvelope;
    };
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: makeSessionMeta({
        id: createMessage.sessionId,
        nodeId: 'node_create_2',
        targetId: 'local',
        accountId,
        provider: 'claude',
      }),
      privateEnvelope: createMessage.privateEnvelope,
    });

    await createPromise;
    // Give any errant send a beat to arrive, then confirm none did.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(node.messages.some((m) => m.type === 'prompt_inject')).toBe(false);
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-create-session-no-conn',
      deviceId: 'client-create-no-conn',
    });
    await expect(
      client.createSession({ targetId: 'local', provider: 'claude', projectPath: '/proj' }),
    ).rejects.toThrow(/not connected/);
  });

  it('times out with a clear error if the node never creates/announces the session', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-create-session-timeout',
      deviceId: 'client-create-timeout',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    await expect(
      client.createSession({
        targetId: 'nonexistent-target',
        provider: 'claude',
        projectPath: '/proj',
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('RelayClient: sessionDecryptFailures (issue #384 mismatched-AMK state)', () => {
  it('counts sessions the current AMK could not decrypt in the latest session_list snapshot, distinct from a genuinely empty list', async () => {
    const wrongAmk = generateAmk();
    const rightAmk = generateAmk();
    const accountId = 'acct-mismatch-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-mismatch-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_mismatch_1', accountId });
    // Sealed under the RIGHT AMK's derived key — this client will connect
    // with the WRONG one, exactly like a second browser that never went
    // through this account's recovery-code onboarding.
    const rightKey = await deriveNodeSessionKey(rightAmk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'unreadable', projectPath: '/proj' },
      rightKey,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk: wrongAmk,
      accountId,
      deviceId: 'client-mismatch-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    await waitForStore(client.sessionDecryptFailures, (count) => count > 0);
    expect(get(client.sessionDecryptFailures)).toBe(1);
    expect(get(client.sessions)).toEqual([]);
  });

  it('stays 0 for an account that genuinely has no sessions', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-mismatch-none',
      deviceId: 'client-mismatch-none',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => Array.isArray(value));
    expect(get(client.sessionDecryptFailures)).toBe(0);
  });
});
