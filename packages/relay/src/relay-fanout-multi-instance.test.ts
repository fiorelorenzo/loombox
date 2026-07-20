import RedisMock from 'ioredis-mock';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type Initialize,
  type SessionAnnounceV1,
  type SessionResume,
  type SessionUpdateEnvelopeV1,
} from '@loombox/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createRedisFanOutBackend, type RedisPubSubClient } from './fanout';
import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * Proves #97's actual point: two SEPARATE `createRelay`/`startRelay`
 * instances (standing in for two relay processes behind a load balancer),
 * each with its own `RedisFanOutBackend`, deliver a `session_update` from a
 * node connected to instance A to a client connected only to instance B.
 * The store is shared (as it would be via Postgres in production — both
 * processes point at the same database) so instance B can resolve the
 * session; Redis is what carries the live update across the process
 * boundary. Both backends' `ioredis-mock` clients share one in-process bus,
 * standing in for one real Redis both processes would be pointed at.
 */
function mockRedisClientFactory(): (redisUrl: string) => RedisPubSubClient {
  return () => new RedisMock() as unknown as RedisPubSubClient;
}

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

async function initConnection(
  url: string,
  opts: { role: 'node' | 'client'; deviceId: string; authToken: string },
): Promise<WebSocket> {
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
  await nextMessage(socket); // initialize_result
  return socket;
}

describe('Redis-backed fan-out across two relay instances (#97)', () => {
  it('delivers a session_update from a node on instance A to a client resumed on instance B', async () => {
    const sharedStore = createInMemoryRelayStore();

    const instanceA = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store: sharedStore,
      fanOutBackend: createRedisFanOutBackend('redis://mock', mockRedisClientFactory()),
    });
    closers.push(instanceA.close);
    const instanceB = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store: sharedStore,
      fanOutBackend: createRedisFanOutBackend('redis://mock', mockRedisClientFactory()),
    });
    closers.push(instanceB.close);

    const node = await initConnection(instanceA.url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_1',
    });
    const announce: SessionAnnounceV1 = {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: {
        id: 'sess_cross_instance',
        nodeId: 'node_1',
        targetId: 'target_1',
        accountId: 'acct_1',
        provider: 'claude',
        createdAt: Date.now(),
      },
      privateEnvelope: fakeEnvelope('title'),
    };
    send(node, announce);
    // let instance A's store write settle before instance B reads it
    await new Promise((resolve) => setTimeout(resolve, 50));

    const client = await initConnection(instanceB.url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_1',
    });
    send(client, {
      type: 'session_resume',
      sessionId: 'sess_cross_instance',
      protocolVersion: PROTOCOL_V1,
    } satisfies SessionResume);
    const resumeReply = (await nextMessage(client)) as unknown as SessionAnnounceV1;
    expect(resumeReply.type).toBe('session_announce');
    // let the Redis SUBSCRIBE ack settle before the update is published
    await new Promise((resolve) => setTimeout(resolve, 50));

    const envelope = fakeEnvelope('chunk-1');
    send(node, {
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_cross_instance',
      seq: 0,
      envelope,
    } satisfies SessionUpdateEnvelopeV1);

    const received = (await nextMessage(client)) as unknown as SessionUpdateEnvelopeV1;
    expect(received.type).toBe('session_update');
    expect(received.envelope).toEqual(envelope);
  });

  it('a client on instance A itself still receives updates for a session whose node is also on instance A (local + Redis together)', async () => {
    const sharedStore = createInMemoryRelayStore();
    const instanceA = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store: sharedStore,
      fanOutBackend: createRedisFanOutBackend('redis://mock', mockRedisClientFactory()),
    });
    closers.push(instanceA.close);

    const node = await initConnection(instanceA.url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_1',
    });
    send(node, {
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: {
        id: 'sess_same_instance',
        nodeId: 'node_1',
        targetId: 'target_1',
        accountId: 'acct_1',
        provider: 'claude',
        createdAt: Date.now(),
      },
      privateEnvelope: fakeEnvelope('title'),
    } satisfies SessionAnnounceV1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const client = await initConnection(instanceA.url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_1',
    });
    send(client, {
      type: 'session_resume',
      sessionId: 'sess_same_instance',
      protocolVersion: PROTOCOL_V1,
    } satisfies SessionResume);
    await nextMessage(client);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const envelope = fakeEnvelope('chunk-1');
    send(node, {
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_same_instance',
      seq: 0,
      envelope,
    } satisfies SessionUpdateEnvelopeV1);

    const received = (await nextMessage(client)) as unknown as SessionUpdateEnvelopeV1;
    expect(received.envelope).toEqual(envelope);
  });
});
