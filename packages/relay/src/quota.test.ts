import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  type BlobUpload,
  type EncryptedEnvelope,
  type Initialize,
  type SessionAnnounceV1,
  type SessionUpdateEnvelopeV1,
} from '@loombox/protocol';

import { startRelay } from './relay';
import { createInMemoryRelayStore, type SyncRelayStore } from './store';

let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

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

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data.toString()) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

function fakeBase64(seed: string): string {
  return Buffer.from(seed).toString('base64');
}

/**
 * A wire-valid envelope (`iv`/`ciphertext` are real base64, so it survives
 * `safeParseWireMessageV1` — an odd-length placeholder string like `'iv'`
 * would fail that validation and the frame would be silently dropped before
 * ever reaching the quota check this file means to exercise) whose ciphertext
 * decodes to `ciphertextBytes` raw bytes, for controlling the envelope's
 * `envelopeByteSize` well above/below a test's configured budget.
 */
function envelopeOfSize(ciphertextBytes: number): EncryptedEnvelope {
  return {
    resourceId: 'res',
    iv: Buffer.alloc(12).toString('base64'),
    ciphertext: Buffer.alloc(ciphertextBytes).toString('base64'),
    alg: 'AES-256-GCM',
  };
}

async function initAs(
  url: string,
  role: 'node' | 'client',
  deviceId: string,
  authToken: string,
): Promise<WebSocket> {
  const socket = await connect(url);
  const initialize: Initialize = {
    type: 'initialize',
    protocolVersion: PROTOCOL_V1,
    role,
    authToken,
    deviceId,
    devicePublicKey: fakeBase64(`${deviceId}-pubkey`),
  };
  send(socket, initialize);
  await nextMessage(socket); // initialize_result
  return socket;
}

describe('per-account storage quota (#101)', () => {
  it('rejects a blob_upload that would exceed the account budget, and leaves it unstored', async () => {
    const store: SyncRelayStore = createInMemoryRelayStore();
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      maxAccountStorageBytes: 100,
    });
    closers.push(close);

    const node = await initAs(url, 'node', 'node-device', 'acct_1');
    const announce: SessionAnnounceV1 = {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: {
        id: 'sess_quota',
        nodeId: 'node_1',
        targetId: 'target_1',
        accountId: 'acct_1',
        provider: 'claude',
        createdAt: Date.now(),
      },
      privateEnvelope: envelopeOfSize(10),
    };
    send(node, announce);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const client = await initAs(url, 'client', 'client-device', 'acct_1');
    const upload: BlobUpload = {
      type: 'blob_upload',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_quota',
      ref: 'ref_over',
      envelope: envelopeOfSize(200), // over the 100-byte budget
    };
    send(client, upload);

    const notice = await nextMessage(client);
    expect(notice).toMatchObject({
      type: 'quota_exceeded',
      scope: 'blob_upload',
      sessionId: 'sess_quota',
      ref: 'ref_over',
    });
    expect(await store.blobs.download('sess_quota:ref_over')).toBeUndefined();
  });

  it('accepts a blob_upload within the account budget', async () => {
    const store: SyncRelayStore = createInMemoryRelayStore();
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      maxAccountStorageBytes: 1_000_000,
    });
    closers.push(close);

    const node = await initAs(url, 'node', 'node-device', 'acct_2');
    const announce: SessionAnnounceV1 = {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: {
        id: 'sess_ok',
        nodeId: 'node_1',
        targetId: 'target_1',
        accountId: 'acct_2',
        provider: 'claude',
        createdAt: Date.now(),
      },
      privateEnvelope: envelopeOfSize(10),
    };
    send(node, announce);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const client = await initAs(url, 'client', 'client-device', 'acct_2');
    const upload: BlobUpload = {
      type: 'blob_upload',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_ok',
      ref: 'ref_small',
      envelope: envelopeOfSize(50),
    };
    send(client, upload);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stored = await store.blobs.download('sess_ok:ref_small');
    expect(stored).toBeDefined();
  });

  it('still fans out a session_update live when over quota, but skips buffering it for resync', async () => {
    const store: SyncRelayStore = createInMemoryRelayStore();
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      maxAccountStorageBytes: 50,
    });
    closers.push(close);

    const node = await initAs(url, 'node', 'node-device', 'acct_3');
    const announce: SessionAnnounceV1 = {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: {
        id: 'sess_ring',
        nodeId: 'node_1',
        targetId: 'target_1',
        accountId: 'acct_3',
        provider: 'claude',
        createdAt: Date.now(),
      },
      privateEnvelope: envelopeOfSize(10),
    };
    send(node, announce);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const client = await initAs(url, 'client', 'client-device', 'acct_3');
    send(client, {
      type: 'session_resume',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_ring',
    });
    await nextMessage(client); // the session_announce reply from session_resume

    const update: SessionUpdateEnvelopeV1 = {
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_ring',
      seq: 0, // the relay assigns the real seq; this placeholder just has to satisfy the wire schema
      envelope: envelopeOfSize(200), // well over the 50-byte budget
    };
    // Both listeners must be attached *before* sending: the node's
    // quota_exceeded notice goes out synchronously while the client's fanned-
    // out session_update travels through the async bounded outbox, so the
    // node's reply can genuinely arrive first — attaching sequentially (send,
    // then await the client, then await the node) risks the node's message
    // arriving with nothing listening for it yet.
    const deliveredPromise = nextMessage(client);
    const noticePromise = nextMessage(node);
    send(node, update);

    // Live delivery still happens...
    const delivered = await deliveredPromise;
    expect(delivered).toMatchObject({ type: 'session_update', sessionId: 'sess_ring', seq: 1 });

    // ...but the node is told the ring buffering for it was skipped...
    const notice = await noticePromise;
    expect(notice).toMatchObject({
      type: 'quota_exceeded',
      scope: 'session_update',
      sessionId: 'sess_ring',
      seq: 1,
    });

    // ...and the resync ring genuinely has nothing buffered for it.
    const resync = await store.sessions.getEntriesSince('sess_ring', 0);
    expect(resync.entries).toEqual([]);
  });
});
