import { afterEach, describe, expect, it } from 'vitest';

import { startRelay } from './relay';

let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

describe('relay /health (#100)', () => {
  it('answers 200 {status:ok} with no database configured (liveness, not readiness)', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    // startRelay returns the ws:// URL (including /ws); the health route is on
    // the same HTTP server at /health.
    const httpBase = url.replace(/^ws:/, 'http:').replace(/\/ws$/, '');
    const res = await fetch(`${httpBase}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
