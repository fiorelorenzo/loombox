import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createInProcessFanOutBackend,
  createRedisFanOutBackend,
  type RedisPubSubClient,
} from './fanout';
import type { PgLike, PgQueryResult } from './pg-client';
import { startRelay } from './relay';

let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/** `startRelay` returns the ws:// URL (including `/ws`); `/health` is on the same HTTP server. */
function httpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws:/, 'http:').replace(/\/ws$/, '');
}

/** A `PgLike` whose `SELECT 1` always resolves — stands in for a reachable Postgres. */
function healthyDb(): PgLike {
  return {
    async query<Row>() {
      return { rows: [{ '?column?': 1 }] as Row[] };
    },
  };
}

/** A `PgLike` whose query always rejects — stands in for a closed/unreachable pool. */
function unreachableDb(): PgLike {
  return {
    query: async () => {
      throw new Error('connection terminated unexpectedly');
    },
  };
}

/** A `PgLike` whose query never resolves — stands in for a hung Postgres connection. */
function hungDb(): PgLike {
  return { query: <Row>() => Promise.withResolvers<PgQueryResult<Row>>().promise };
}

/** Minimal `RedisPubSubClient` stub — every method but `ping` is a no-op. */
function stubRedisClient(ping: RedisPubSubClient['ping']): RedisPubSubClient {
  return {
    publish: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    on: () => {},
    quit: async () => {},
    ping,
  };
}

function healthyRedisFactory(): (url: string) => RedisPubSubClient {
  return () => new RedisMock() as unknown as RedisPubSubClient;
}

function unreachableRedisFactory(): (url: string) => RedisPubSubClient {
  return () =>
    stubRedisClient(async () => {
      throw new Error('ECONNREFUSED');
    });
}

function hungRedisFactory(): (url: string) => RedisPubSubClient {
  return () => stubRedisClient(() => Promise.withResolvers<unknown>().promise);
}

describe('relay /health readiness probe (#270, SPEC §7.21)', () => {
  it('answers 200 when neither Postgres nor Redis is configured (dev/hermetic mode — nothing to be down)', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const res = await fetch(`${httpBaseUrl(url)}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 200 when Postgres and Redis are both reachable', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      healthCheck: { db: healthyDb() },
      fanOutBackend: createRedisFanOutBackend('redis://mock', healthyRedisFactory()),
    });
    closers.push(close);

    const res = await fetch(`${httpBaseUrl(url)}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 200 when Postgres is reachable and Redis is not configured (Redis is optional, #97)', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      healthCheck: { db: healthyDb() },
      fanOutBackend: createInProcessFanOutBackend(),
    });
    closers.push(close);

    const res = await fetch(`${httpBaseUrl(url)}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 naming postgres when Postgres is configured but unreachable, even with Redis healthy', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      healthCheck: { db: unreachableDb() },
      fanOutBackend: createRedisFanOutBackend('redis://mock', healthyRedisFactory()),
    });
    closers.push(close);

    const res = await fetch(`${httpBaseUrl(url)}/health`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unhealthy', failed: ['postgres'] });
  });

  it('answers 503 naming redis when a configured Redis is unreachable, even with Postgres healthy', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      healthCheck: { db: healthyDb() },
      fanOutBackend: createRedisFanOutBackend('redis://mock', unreachableRedisFactory()),
    });
    closers.push(close);

    const res = await fetch(`${httpBaseUrl(url)}/health`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unhealthy', failed: ['redis'] });
  });

  it('answers 503 naming both when both are unreachable', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      healthCheck: { db: unreachableDb() },
      fanOutBackend: createRedisFanOutBackend('redis://mock', unreachableRedisFactory()),
    });
    closers.push(close);

    const res = await fetch(`${httpBaseUrl(url)}/health`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unhealthy', failed: ['postgres', 'redis'] });
  });

  it('503s within the probe timeout instead of hanging when Postgres never answers', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      healthCheck: { db: hungDb(), timeoutMs: 50 },
    });
    closers.push(close);

    const startedAt = Date.now();
    const res = await fetch(`${httpBaseUrl(url)}/health`);
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unhealthy', failed: ['postgres'] });
    // Generous upper bound relative to the 50ms probe timeout — proves this
    // resolved from the timeout race, not from waiting on the dead probe.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('503s within the probe timeout instead of hanging when a configured Redis never answers', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      healthCheck: { timeoutMs: 50 },
      fanOutBackend: createRedisFanOutBackend('redis://mock', hungRedisFactory()),
    });
    closers.push(close);

    const startedAt = Date.now();
    const res = await fetch(`${httpBaseUrl(url)}/health`);
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unhealthy', failed: ['redis'] });
    expect(elapsedMs).toBeLessThan(1000);
  });
});
