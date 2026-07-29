import { afterEach, describe, expect, it } from 'vitest';

import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * `GET /account` — "which account does this bearer belong to?", the question a
 * resident node has to answer about itself before it can connect (`@loombox/
 * node`'s `resolve-account-id.ts`).
 *
 * The point of the route is that it accepts every bearer the relay itself
 * accepts. A node that linked through the device-authorization flow holds a
 * relay-native device token, which is not a Better Auth session, so asking
 * Better Auth about it (what the node used to do) always failed even though
 * the WS handshake would have accepted the same token.
 *
 * Like `node-token-routes.test.ts`, no Better Auth instance is mounted here:
 * the relay's dev/hermetic resolver (`deriveAccountIdStub`) treats any
 * non-empty bearer as its own accountId, so `Bearer acct_1` is an
 * already-"signed-in" caller without a real OAuth round trip.
 */

type Close = () => Promise<void>;
let closers: Close[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function startTestRelay() {
  const store = createInMemoryRelayStore();
  const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
  closers.push(close);
  const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
  return { store, httpUrl };
}

async function whoami(httpUrl: string, bearer: string | undefined): Promise<Response> {
  return fetch(`${httpUrl}/account`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

describe('GET /account', () => {
  it('rejects a request with no bearer', async () => {
    const { httpUrl } = await startTestRelay();

    const response = await whoami(httpUrl, undefined);

    expect(response.status).toBe(401);
  });

  it('returns the accountId the relay resolved the bearer to', async () => {
    const { httpUrl } = await startTestRelay();

    const response = await whoami(httpUrl, 'acct_1');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountId: 'acct_1' });
  });

  it('resolves a minted node token to the account that minted it', async () => {
    const { httpUrl } = await startTestRelay();
    const minted = await fetch(`${httpUrl}/account/node-tokens`, {
      method: 'POST',
      headers: { authorization: 'Bearer acct_owner', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'a resident node' }),
    });
    expect(minted.status).toBe(201);
    const body: unknown = await minted.json();
    const token = body !== null && typeof body === 'object' && 'token' in body ? body.token : '';
    expect(typeof token).toBe('string');

    // The whole regression: this token is not a Better Auth session, and it
    // still answers with the right account.
    const response = await whoami(httpUrl, String(token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountId: 'acct_owner' });
  });

  it('never leaks another account: two bearers get their own answers', async () => {
    const { httpUrl } = await startTestRelay();

    const first = await whoami(httpUrl, 'acct_1');
    const second = await whoami(httpUrl, 'acct_2');

    expect(await first.json()).toEqual({ accountId: 'acct_1' });
    expect(await second.json()).toEqual({ accountId: 'acct_2' });
  });
});
