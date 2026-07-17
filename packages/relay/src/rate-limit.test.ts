import { afterEach, describe, expect, it } from 'vitest';

import { startRelay } from './relay';

let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/**
 * Per-IP rate limiting (#101, SPEC §8's "public-relay abuse limits").
 * `@fastify/rate-limit`'s `onRequest` hook runs ahead of every route this
 * instance serves, including the WS upgrade route (`@fastify/websocket`'s
 * own docs: "all Fastify hooks execute before the connection upgrade") — so
 * exercising it with plain `fetch()` GETs against `/ws` (never completing a
 * real WebSocket handshake) is a faithful, simpler-to-drive proxy for "a
 * burst of connection/enrollment attempts from one IP." A plain GET to a
 * `{ websocket: true }`-only route 404s once under the limit (it only
 * accepts upgrade requests) and 429s once over it — either way, the
 * `onRequest` hook has already run and counted the request.
 */
describe('relay per-IP rate limiting (#101)', () => {
  it('rejects a burst past the configured max with 429, while allowing traffic under it', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      rateLimit: { max: 3, timeWindow: 60_000 },
    });
    closers.push(close);
    const httpBase = url.replace(/^ws:/, 'http:').replace(/\/ws$/, '');

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${httpBase}/ws`);
      statuses.push(res.status);
    }

    // The first `max` requests are under the limit (a plain GET to a
    // websocket-only route 404s — that's expected, it proves the request
    // reached routing rather than being rate-limited).
    expect(statuses.slice(0, 3)).toEqual([404, 404, 404]);
    // Everything past `max` within the window is rejected.
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('does not rate-limit the /health liveness endpoint', async () => {
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      rateLimit: { max: 2, timeWindow: 60_000 },
    });
    closers.push(close);
    const httpBase = url.replace(/^ws:/, 'http:').replace(/\/ws$/, '');

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${httpBase}/health`);
      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });

  it('uses sane defaults when no rateLimit option is given (a handful of requests never trips it)', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);
    const httpBase = url.replace(/^ws:/, 'http:').replace(/\/ws$/, '');

    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${httpBase}/ws`);
      expect(res.status).toBe(404);
    }
  });
});
