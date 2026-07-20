import IORedis from 'ioredis';
import type { WireMessageV1 } from '@loombox/protocol';

import type { OutboxItem } from './outbox';

/**
 * What travels over a fan-out channel: either a bounded, queued
 * `session_update`/`resync_marker` (delivered via the receiving client's own
 * `BoundedClientOutbox`) or a lower-volume direct control message
 * (permission requests, blob refs, ...). Both cases carry exactly the same
 * `WireMessageV1`/`OutboxItem` shapes the relay already routes between a
 * node and its clients on a single instance (#315's locked architecture) —
 * Redis is not a new protocol, it's the same opaque envelopes crossing a
 * process boundary instead of an in-memory `Set`.
 */
export type FanOutPayload =
  { kind: 'update'; item: OutboxItem } | { kind: 'direct'; message: WireMessageV1 };

/**
 * Fan-out backend abstraction (#97, SPEC §9/§16 "relay stack: Redis
 * pub/sub"): how a `session_update`/session-scoped control message,
 * published by whichever relay process has the owning node connection,
 * reaches every relay process (including itself) that currently has at
 * least one client locally subscribed to that session.
 *
 * Channel-per-session: each `sessionId` is its own logical channel, so a
 * relay instance only pays for (Redis-)subscribing to the sessions it
 * actually has local subscribers for, rather than every session on the
 * whole deployment.
 *
 * Two implementations share this interface:
 * - {@link createInProcessFanOutBackend} — the default. A same-process,
 *   synchronous stand-in for a channel: `publish` calls every locally
 *   registered handler in the same call stack, byte-for-byte the delivery
 *   timing the relay had before this abstraction existed. Used whenever
 *   `REDIS_URL` is unset — the single deployed instance behaves exactly as
 *   it did pre-#97.
 * - {@link createRedisFanOutBackend} — opt-in via `REDIS_URL`. Backs the same
 *   interface with real Redis PUBLISH/SUBSCRIBE so N relay processes share
 *   one fan-out plane: a node connected to instance A publishes, and a
 *   client subscribed on instance B receives it. The relay stays exactly as
 *   blind on Redis as it is on its own WebSocket: every payload is a
 *   `JSON.stringify` of the same `EncryptedEnvelope`-carrying wire messages
 *   already flowing over `/ws`, never plaintext.
 */
export interface FanOutBackend {
  /** Publish `payload` to every subscriber of `sessionId`, on every instance (including this one, if it has a local subscriber). */
  publish(sessionId: string, payload: FanOutPayload): void;
  /**
   * Registers local interest in a session's channel. Call once per
   * (connection, session) the caller wants delivery for; the returned
   * function undoes exactly that one registration. The last unsubscribe for
   * a given `sessionId` releases any underlying channel subscription
   * (Redis `UNSUBSCRIBE`) so a relay never accumulates subscriptions for
   * sessions nobody local cares about anymore.
   */
  subscribe(sessionId: string, handler: (payload: FanOutPayload) => void): () => void;
  /** Releases underlying connections (Redis clients). A no-op on the in-process backend. */
  close(): Promise<void>;
}

/**
 * The default, single-instance fan-out (unchanged pre-#97 behavior): a
 * plain `Map` of `sessionId` to its locally registered handlers, with
 * `publish` invoking them synchronously and in-order. There is nothing to
 * connect to and nothing to close.
 */
export function createInProcessFanOutBackend(): FanOutBackend {
  const channels = new Map<string, Set<(payload: FanOutPayload) => void>>();

  return {
    publish(sessionId, payload) {
      const handlers = channels.get(sessionId);
      if (!handlers) return;
      // Snapshot: a handler that synchronously unsubscribes (e.g. a
      // disconnect triggered by the very message it's receiving) must not
      // perturb this iteration.
      for (const handler of [...handlers]) handler(payload);
    },
    subscribe(sessionId, handler) {
      let handlers = channels.get(sessionId);
      if (!handlers) {
        handlers = new Set();
        channels.set(sessionId, handlers);
      }
      handlers.add(handler);
      return () => {
        const current = channels.get(sessionId);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) channels.delete(sessionId);
      };
    },
    async close() {
      // Nothing to release — see the class doc comment above.
    },
  };
}

/** Minimal surface this module needs from an `ioredis`-compatible client — deliberately structural so `ioredis-mock` (no shared base class with `ioredis`) satisfies it in tests without a cast. */
export interface RedisPubSubClient {
  publish(channel: string, message: string): unknown;
  subscribe(...channels: string[]): unknown;
  unsubscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

/** Builds a real `ioredis` client — the default {@link createRedisFanOutBackend} factory; tests inject an `ioredis-mock` factory instead. */
export function defaultRedisClientFactory(redisUrl: string): RedisPubSubClient {
  return new IORedis(redisUrl);
}

const CHANNEL_PREFIX = 'loombox:relay:session:';

function channelName(sessionId: string): string {
  return `${CHANNEL_PREFIX}${sessionId}`;
}

/**
 * Redis-backed fan-out (#97). Uses two client connections, per Redis's own
 * pub/sub contract: once a connection issues `SUBSCRIBE` it can no longer
 * run other commands, so `publish` and `subscribe` each need their own.
 * `redisClientFactory` defaults to a real `ioredis` client and is the seam
 * the hermetic test suite swaps for `ioredis-mock` (two mock clients created
 * against the same in-memory bus, standing in for two relay processes both
 * pointed at one real Redis).
 */
export function createRedisFanOutBackend(
  redisUrl: string,
  redisClientFactory: (redisUrl: string) => RedisPubSubClient = defaultRedisClientFactory,
): FanOutBackend {
  const publisher = redisClientFactory(redisUrl);
  const subscriber = redisClientFactory(redisUrl);
  const localHandlers = new Map<string, Set<(payload: FanOutPayload) => void>>();

  subscriber.on('message', (channel, raw) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const sessionId = channel.slice(CHANNEL_PREFIX.length);
    const handlers = localHandlers.get(sessionId);
    if (!handlers) return;
    let payload: FanOutPayload;
    try {
      payload = JSON.parse(raw) as FanOutPayload;
    } catch {
      return;
    }
    for (const handler of [...handlers]) handler(payload);
  });

  return {
    publish(sessionId, payload) {
      // The relay stays blind: this is a JSON envelope of the same wire
      // message types already flowing over `/ws` — ciphertext fields inside
      // stay opaque base64/JSON, never decrypted or inspected here.
      void publisher.publish(channelName(sessionId), JSON.stringify(payload));
    },
    subscribe(sessionId, handler) {
      let handlers = localHandlers.get(sessionId);
      const isFirstLocalSubscriber = !handlers;
      if (!handlers) {
        handlers = new Set();
        localHandlers.set(sessionId, handlers);
      }
      handlers.add(handler);
      if (isFirstLocalSubscriber) void subscriber.subscribe(channelName(sessionId));

      return () => {
        const current = localHandlers.get(sessionId);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          localHandlers.delete(sessionId);
          void subscriber.unsubscribe(channelName(sessionId));
        }
      };
    },
    async close() {
      await Promise.all([publisher.quit(), subscriber.quit()]);
    },
  };
}

/**
 * The `main.ts` wiring seam: `REDIS_URL` unset -> the default in-process
 * backend (identical single-instance behavior, #97's non-negotiable
 * requirement); set -> Redis-backed multi-instance fan-out.
 */
export function createFanOutBackendFromEnv(redisUrl: string | undefined): FanOutBackend {
  return redisUrl ? createRedisFanOutBackend(redisUrl) : createInProcessFanOutBackend();
}
