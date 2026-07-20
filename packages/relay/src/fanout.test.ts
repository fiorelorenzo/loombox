import RedisMock from 'ioredis-mock';
import { PROTOCOL_V1, type BlobRef, type SessionUpdateEnvelopeV1 } from '@loombox/protocol';
import { describe, expect, it } from 'vitest';

import {
  createInProcessFanOutBackend,
  createRedisFanOutBackend,
  type FanOutPayload,
  type RedisPubSubClient,
} from './fanout';

function fakeBase64(seed: string): string {
  return Buffer.from(seed).toString('base64');
}

function fakeUpdate(sessionId: string, seq: number): SessionUpdateEnvelopeV1 {
  return {
    type: 'session_update',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    seq,
    envelope: {
      resourceId: 'res',
      iv: fakeBase64(`${sessionId}-${seq}-iv`),
      ciphertext: fakeBase64(`${sessionId}-${seq}-ct`),
      alg: 'AES-256-GCM',
    },
  };
}

describe('createInProcessFanOutBackend (#97 default, single-instance)', () => {
  it('delivers a published payload synchronously to a subscribed handler', () => {
    const backend = createInProcessFanOutBackend();
    const received: FanOutPayload[] = [];
    backend.subscribe('sess_1', (payload) => received.push(payload));

    const item = fakeUpdate('sess_1', 1);
    backend.publish('sess_1', { kind: 'update', item });

    // No await: proves delivery happens in the same call stack as publish,
    // matching the pre-#97 direct-iteration fan-out exactly.
    expect(received).toEqual([{ kind: 'update', item }]);
  });

  it('never delivers to a handler subscribed to a different sessionId', () => {
    const backend = createInProcessFanOutBackend();
    const received: FanOutPayload[] = [];
    backend.subscribe('sess_other', (payload) => received.push(payload));

    backend.publish('sess_1', { kind: 'update', item: fakeUpdate('sess_1', 1) });

    expect(received).toEqual([]);
  });

  it('fans out to every handler subscribed to the same session', () => {
    const backend = createInProcessFanOutBackend();
    const a: FanOutPayload[] = [];
    const b: FanOutPayload[] = [];
    backend.subscribe('sess_1', (payload) => a.push(payload));
    backend.subscribe('sess_1', (payload) => b.push(payload));

    const item = fakeUpdate('sess_1', 1);
    backend.publish('sess_1', { kind: 'update', item });

    expect(a).toEqual([{ kind: 'update', item }]);
    expect(b).toEqual([{ kind: 'update', item }]);
  });

  it('stops delivering once the subscription is undone', () => {
    const backend = createInProcessFanOutBackend();
    const received: FanOutPayload[] = [];
    const unsubscribe = backend.subscribe('sess_1', (payload) => received.push(payload));
    unsubscribe();

    backend.publish('sess_1', { kind: 'update', item: fakeUpdate('sess_1', 1) });

    expect(received).toEqual([]);
  });

  it('a second handler keeps receiving after only one of two unsubscribes', () => {
    const backend = createInProcessFanOutBackend();
    const a: FanOutPayload[] = [];
    const b: FanOutPayload[] = [];
    const unsubscribeA = backend.subscribe('sess_1', (payload) => a.push(payload));
    backend.subscribe('sess_1', (payload) => b.push(payload));
    unsubscribeA();

    const item = fakeUpdate('sess_1', 1);
    backend.publish('sess_1', { kind: 'update', item });

    expect(a).toEqual([]);
    expect(b).toEqual([{ kind: 'update', item }]);
  });

  it('publishing to a session with no subscribers is a harmless no-op', () => {
    const backend = createInProcessFanOutBackend();
    expect(() =>
      backend.publish('sess_nobody', { kind: 'update', item: fakeUpdate('sess_nobody', 1) }),
    ).not.toThrow();
  });

  it('close() is a no-op (nothing to release for the in-process backend)', async () => {
    const backend = createInProcessFanOutBackend();
    await expect(backend.close()).resolves.toBeUndefined();
  });
});

/**
 * Simulates two relay processes both pointed at one real Redis: two
 * independent `ioredis-mock` clients per backend (mirroring
 * `createRedisFanOutBackend`'s own "publisher connection + dedicated
 * subscriber connection" split), all four sharing `ioredis-mock`'s default
 * in-process bus — proving cross-instance delivery hermetically, no Docker
 * or real Redis network required.
 */
function mockRedisClientFactory(): (redisUrl: string) => RedisPubSubClient {
  return () => new RedisMock() as unknown as RedisPubSubClient;
}

describe('createRedisFanOutBackend (#97, multi-instance)', () => {
  it('a payload published on instance A is delivered to a subscriber on instance B', async () => {
    const instanceA = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    const instanceB = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());

    const receivedOnB: FanOutPayload[] = [];
    instanceB.subscribe('sess_cross', (payload) => receivedOnB.push(payload));
    // ioredis(-mock)'s SUBSCRIBE ack is itself async — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const item = fakeUpdate('sess_cross', 1);
    instanceA.publish('sess_cross', { kind: 'update', item });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedOnB).toEqual([{ kind: 'update', item }]);

    await instanceA.close();
    await instanceB.close();
  });

  it('a relay instance also receives its own publish if it has a local subscriber (symmetric channel)', async () => {
    const instance = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    const received: FanOutPayload[] = [];
    instance.subscribe('sess_self', (payload) => received.push(payload));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const item = fakeUpdate('sess_self', 1);
    instance.publish('sess_self', { kind: 'update', item });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toEqual([{ kind: 'update', item }]);
    await instance.close();
  });

  it('an instance with no local subscriber for a session receives nothing for it', async () => {
    const instanceA = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    const instanceB = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    // instanceB never subscribes to sess_quiet at all.
    const receivedOnB: FanOutPayload[] = [];
    instanceB.subscribe('sess_other', (payload) => receivedOnB.push(payload));
    await new Promise((resolve) => setTimeout(resolve, 10));

    instanceA.publish('sess_quiet', { kind: 'update', item: fakeUpdate('sess_quiet', 1) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedOnB).toEqual([]);
    await instanceA.close();
    await instanceB.close();
  });

  it('delivers direct (unbounded control) payloads the same way as update payloads', async () => {
    const instanceA = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    const instanceB = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    const receivedOnB: FanOutPayload[] = [];
    instanceB.subscribe('sess_direct', (payload) => receivedOnB.push(payload));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const message: BlobRef = {
      type: 'blob_ref',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_direct',
      ref: 'ref_1',
      envelope: fakeUpdate('sess_direct', 1).envelope,
    };
    instanceA.publish('sess_direct', { kind: 'direct', message });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedOnB).toEqual([{ kind: 'direct', message }]);
    await instanceA.close();
    await instanceB.close();
  });

  it('unsubscribing on instance B stops further delivery from instance A', async () => {
    const instanceA = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    const instanceB = createRedisFanOutBackend('redis://mock', mockRedisClientFactory());
    const receivedOnB: FanOutPayload[] = [];
    const unsubscribe = instanceB.subscribe('sess_bye', (payload) => receivedOnB.push(payload));
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 10));

    instanceA.publish('sess_bye', { kind: 'update', item: fakeUpdate('sess_bye', 1) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedOnB).toEqual([]);
    await instanceA.close();
    await instanceB.close();
  });
});
