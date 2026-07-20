import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type Initialize,
  type InitializeResult,
  type PermissionRequest,
  type SessionAnnounceV1,
  type SessionMetaPublic,
} from '@loombox/protocol';

import type { PushSender } from './push';
import { startRelay } from './relay';
import { createInMemoryRelayStore, type SyncRelayStore } from './store';

/**
 * #161 (VAPID key endpoint + subscription store, over real HTTP) and #163
 * (presence-aware Web Push delivery on `permission_request`, with a fake
 * `PushSender` injected — no real Web Push network call, see `push.ts`'s
 * own `PushSender` doc comment). Deliberately a separate file from
 * `relay.test.ts` (not appended there) to stay out of that large,
 * frequently-touched file's way.
 */

type Close = () => Promise<void>;
let closers: Close[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

function fakeBase64(seed: string): string {
  return Buffer.from(seed).toString('base64');
}

function fakeEnvelope(seed: string): EncryptedEnvelope {
  return {
    resourceId: 'res',
    iv: fakeBase64(`${seed}-iv`),
    ciphertext: fakeBase64(`${seed}-ct`),
    alg: 'AES-256-GCM',
  };
}

function makeSessionMeta(overrides: Partial<SessionMetaPublic> = {}): SessionMetaPublic {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    targetId: 'target_1',
    accountId: 'acct_1',
    provider: 'claude',
    createdAt: Date.now(),
    ...overrides,
  };
}

const messageQueues = new WeakMap<WebSocket, Record<string, unknown>[]>();
const messageWaiters = new WeakMap<WebSocket, Array<(msg: Record<string, unknown>) => void>>();

function attachCollector(socket: WebSocket): void {
  messageQueues.set(socket, []);
  messageWaiters.set(socket, []);
  socket.addEventListener('message', (event) => {
    const parsed = JSON.parse((event as MessageEvent).data.toString()) as Record<string, unknown>;
    const waiters = messageWaiters.get(socket);
    const nextWaiter = waiters?.shift();
    if (nextWaiter) {
      nextWaiter(parsed);
      return;
    }
    messageQueues.get(socket)?.push(parsed);
  });
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  attachCollector(socket);
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
  const queued = messageQueues.get(socket)?.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    messageWaiters.get(socket)?.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

interface InitOptions {
  role: 'node' | 'client';
  deviceId: string;
  authToken: string;
}

async function initConnection(
  url: string,
  opts: InitOptions,
): Promise<{ socket: WebSocket; result: InitializeResult }> {
  const socket = await connect(url);
  const initialize: Initialize = {
    type: 'initialize',
    protocolVersion: PROTOCOL_V1,
    role: opts.role,
    authToken: opts.authToken,
    deviceId: opts.deviceId,
    devicePublicKey: fakeBase64(`${opts.deviceId}-pubkey`),
  };
  send(socket, initialize);
  const result = (await nextMessage(socket)) as unknown as InitializeResult;
  return { socket, result };
}

function fakeVapidKeys() {
  return { publicKey: 'test-vapid-pub', privateKey: 'test-vapid-priv' };
}

interface FakeSenderCall {
  endpoint: string;
  sessionId: string;
}

/** Records every call by `endpoint` (each fake subscription below uses one distinguishing endpoint) — a real send is never attempted. */
function createFakeSender(expireEndpoints: readonly string[] = []): {
  sender: PushSender;
  calls: FakeSenderCall[];
} {
  const calls: FakeSenderCall[] = [];
  const sender: PushSender = {
    async send(target, _vapidKeys, _subject, payload) {
      calls.push({ endpoint: target.endpoint, sessionId: payload.sessionId });
      return { expired: expireEndpoints.includes(target.endpoint) };
    },
  };
  return { sender, calls };
}

describe('/push/vapid-public-key and /push/subscribe (#161/#162)', () => {
  it('404s when the relay was not configured with push at all', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

    const response = await fetch(`${httpUrl}/push/vapid-public-key`);
    expect(response.status).toBe(404);
  });

  it('serves the configured VAPID public key, and round-trips a subscription through subscribe/unsubscribe', async () => {
    const vapidKeys = fakeVapidKeys();
    const store = createInMemoryRelayStore();
    const { sender } = createFakeSender();
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      push: { vapidKeys, subject: 'mailto:ops@example.com', sender },
    });
    closers.push(close);
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

    const keyResponse = await fetch(`${httpUrl}/push/vapid-public-key`);
    expect(keyResponse.status).toBe(200);
    expect(await keyResponse.json()).toEqual({ publicKey: vapidKeys.publicKey });

    // No bearer token at all -> 401, never silently accepted.
    const unauthed = await fetch(`${httpUrl}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev_1',
        endpoint: 'https://push.example/ep1',
        keys: { p256dh: 'p1', auth: 'a1' },
      }),
    });
    expect(unauthed.status).toBe(401);

    const subscribeResponse = await fetch(`${httpUrl}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer acct_1' },
      body: JSON.stringify({
        deviceId: 'dev_1',
        endpoint: 'https://push.example/ep1',
        keys: { p256dh: 'p1', auth: 'a1' },
      }),
    });
    expect(subscribeResponse.status).toBe(204);

    const saved = await store.pushSubscriptions.get('acct_1', 'dev_1');
    expect(saved?.endpoint).toBe('https://push.example/ep1');

    const unsubscribeResponse = await fetch(`${httpUrl}/push/subscribe`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: 'Bearer acct_1' },
      body: JSON.stringify({ deviceId: 'dev_1' }),
    });
    expect(unsubscribeResponse.status).toBe(204);
    expect(await store.pushSubscriptions.get('acct_1', 'dev_1')).toBeUndefined();
  });

  it('rejects a malformed subscribe body with 400', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      push: {
        vapidKeys: fakeVapidKeys(),
        subject: 'mailto:ops@example.com',
        sender: createFakeSender().sender,
      },
    });
    closers.push(close);
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

    const response = await fetch(`${httpUrl}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer acct_1' },
      body: JSON.stringify({ deviceId: 'dev_1' /* missing endpoint/keys */ }),
    });
    expect(response.status).toBe(400);
  });
});

describe('presence-aware push delivery on permission_request (#163)', () => {
  async function subscribeDevice(
    httpUrl: string,
    accountId: string,
    deviceId: string,
    endpoint: string,
  ): Promise<void> {
    const response = await fetch(`${httpUrl}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accountId}` },
      body: JSON.stringify({ deviceId, endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    });
    expect(response.status).toBe(204);
  }

  it('pushes to a device with no live client connection, but not to one that is currently connected', async () => {
    const { sender, calls } = createFakeSender();
    const store: SyncRelayStore = createInMemoryRelayStore();
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      push: { vapidKeys: fakeVapidKeys(), subject: 'mailto:ops@example.com', sender },
    });
    closers.push(close);
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

    await subscribeDevice(httpUrl, 'acct_1', 'dev_connected', 'https://push.example/connected');
    await subscribeDevice(
      httpUrl,
      'acct_1',
      'dev_disconnected',
      'https://push.example/disconnected',
    );

    // dev_connected has a LIVE client connection right now.
    await initConnection(url, { role: 'client', deviceId: 'dev_connected', authToken: 'acct_1' });

    const { socket: node } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_1',
    });
    const meta = makeSessionMeta({ id: 'sess_a', accountId: 'acct_1' });
    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: meta,
      privateEnvelope: fakeEnvelope('title'),
    } satisfies SessionAnnounceV1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    send(node, {
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_a',
      requestId: 'req_1',
      envelope: fakeEnvelope('permission-body'),
    } satisfies PermissionRequest);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      endpoint: 'https://push.example/disconnected',
      sessionId: 'sess_a',
    });
  });

  it('never triggers a push at all when the relay has no push config (feature disabled)', async () => {
    const store: SyncRelayStore = createInMemoryRelayStore();
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
    closers.push(close);

    // Pre-seed a subscription directly (no /push/subscribe route exists to do it over HTTP when disabled).
    await store.pushSubscriptions.save({
      accountId: 'acct_1',
      deviceId: 'dev_1',
      endpoint: 'https://push.example/ep1',
      p256dh: 'p',
      auth: 'a',
    });

    const { socket: node } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_1',
    });
    const meta = makeSessionMeta({ id: 'sess_b', accountId: 'acct_1' });
    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: meta,
      privateEnvelope: fakeEnvelope('title'),
    } satisfies SessionAnnounceV1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // No throw, no crash — just quietly a no-op; the subscription is untouched.
    send(node, {
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_b',
      requestId: 'req_1',
      envelope: fakeEnvelope('permission-body'),
    } satisfies PermissionRequest);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await store.pushSubscriptions.get('acct_1', 'dev_1')).toBeDefined();
  });

  it('self-cleans a subscription the push service reports as expired (410/404), without affecting the account other subscriptions', async () => {
    const { sender, calls } = createFakeSender(['https://push.example/expired']);
    const store: SyncRelayStore = createInMemoryRelayStore();
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      push: { vapidKeys: fakeVapidKeys(), subject: 'mailto:ops@example.com', sender },
    });
    closers.push(close);
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

    await subscribeDevice(httpUrl, 'acct_1', 'dev_expired', 'https://push.example/expired');
    await subscribeDevice(httpUrl, 'acct_1', 'dev_alive', 'https://push.example/alive');

    const { socket: node } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_1',
    });
    const meta = makeSessionMeta({ id: 'sess_c', accountId: 'acct_1' });
    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: meta,
      privateEnvelope: fakeEnvelope('title'),
    } satisfies SessionAnnounceV1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    send(node, {
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_c',
      requestId: 'req_1',
      envelope: fakeEnvelope('permission-body'),
    } satisfies PermissionRequest);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(calls).toHaveLength(2);
    expect(await store.pushSubscriptions.get('acct_1', 'dev_expired')).toBeUndefined();
    expect(await store.pushSubscriptions.get('acct_1', 'dev_alive')).toBeDefined();
  });

  it('a delivery failure to one subscription does not stop delivery to the account other subscriptions', async () => {
    const store: SyncRelayStore = createInMemoryRelayStore();
    const calls: string[] = [];
    const sender: PushSender = {
      async send(target, _vapidKeys, _subject, payload) {
        if (target.endpoint === 'https://push.example/broken') {
          throw new Error('simulated push service outage');
        }
        calls.push(payload.sessionId);
        return { expired: false };
      },
    };
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      push: { vapidKeys: fakeVapidKeys(), subject: 'mailto:ops@example.com', sender },
    });
    closers.push(close);
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

    await subscribeDevice(httpUrl, 'acct_1', 'dev_broken', 'https://push.example/broken');
    await subscribeDevice(httpUrl, 'acct_1', 'dev_ok', 'https://push.example/ok');

    const { socket: node } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_1',
    });
    const meta = makeSessionMeta({ id: 'sess_d', accountId: 'acct_1' });
    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: meta,
      privateEnvelope: fakeEnvelope('title'),
    } satisfies SessionAnnounceV1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    send(node, {
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_d',
      requestId: 'req_1',
      envelope: fakeEnvelope('permission-body'),
    } satisfies PermissionRequest);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(calls).toEqual(['sess_d']);
  });
});
