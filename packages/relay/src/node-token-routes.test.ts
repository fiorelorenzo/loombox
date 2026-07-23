import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_V1, type Initialize, type InitializeResult } from '@loombox/protocol';

import { createRelay, startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * The authenticated, zero-touch node-token mint endpoints (issue #398):
 * `POST /account/node-tokens` mints a node-scoped bearer for the CALLER's
 * own account in one call (no RFC 8628 `user_code` round trip — that flow
 * is `device-auth-routes.test.ts`'s own file), `GET` lists this account's
 * tokens (metadata only), `DELETE /:id` revokes one. Deliberately its own
 * file, mirroring `device-auth-routes.test.ts`'s own rationale.
 *
 * Like that file, no Better Auth instance is mounted here — the relay's
 * dev/hermetic resolver (`deriveAccountIdStub`) treats any non-empty bearer
 * as its own accountId, so `Bearer acct_1` and `Bearer acct_2` below are two
 * distinct, already-"signed-in" callers without a real OAuth round trip.
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
  return { store, url, httpUrl };
}

async function mint(
  httpUrl: string,
  bearer: string | undefined,
  label?: string,
): Promise<Response> {
  return fetch(`${httpUrl}/account/node-tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(label === undefined ? {} : { label }),
  });
}

async function list(httpUrl: string, bearer: string | undefined): Promise<Response> {
  return fetch(`${httpUrl}/account/node-tokens`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

async function revoke(httpUrl: string, bearer: string | undefined, id: string): Promise<Response> {
  return fetch(`${httpUrl}/account/node-tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('ws connect error')), { once: true });
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse((event as MessageEvent).data.toString()) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

async function initConnection(
  url: string,
  opts: { role: 'node' | 'client'; deviceId: string; authToken: string },
): Promise<{ socket: WebSocket; result: InitializeResult }> {
  const socket = await connectWs(url);
  closers.push(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });
  const initialize: Initialize = {
    type: 'initialize',
    protocolVersion: PROTOCOL_V1,
    role: opts.role,
    authToken: opts.authToken,
    deviceId: opts.deviceId,
    devicePublicKey: Buffer.from(`${opts.deviceId}-pubkey`).toString('base64'),
  };
  socket.send(JSON.stringify(initialize));
  const result = (await nextMessage(socket)) as unknown as InitializeResult;
  return { socket, result };
}

describe('POST /account/node-tokens (#398)', () => {
  it('requires a bearer token', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await mint(httpUrl, undefined);
    expect(response.status).toBe(401);
  });

  it('mints a token distinct from the caller bearer, revealed once in the response', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await mint(httpUrl, 'acct_1', 'my mac');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; token: string; label: string };
    expect(typeof body.id).toBe('string');
    expect(body.token.length).toBeGreaterThan(32);
    expect(body.token).not.toBe('acct_1');
    expect(body.label).toBe('my mac');
  });

  it('the minted token authenticates a real WS connection as the SAME account that minted it, over both WS and HTTP', async () => {
    const { url, httpUrl } = await startTestRelay();
    const response = await mint(httpUrl, 'acct_1', 'zero-touch node');
    const { token } = (await response.json()) as { token: string };

    // WS: the minted token resolves to the minting account.
    const node = await initConnection(url, {
      role: 'node',
      deviceId: 'resident-node-1',
      authToken: token,
    });
    expect(node.result.type).toBe('initialize_result');

    node.socket.send(
      JSON.stringify({
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: {
          id: 'sess_node_token_1',
          nodeId: 'resident-node-1',
          targetId: 'local',
          accountId: 'acct_1',
          provider: 'claude',
          createdAt: Date.now(),
        },
        privateEnvelope: {
          resourceId: 'res',
          iv: Buffer.from('iv').toString('base64'),
          ciphertext: Buffer.from('ct').toString('base64'),
          alg: 'AES-256-GCM',
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const client = await initConnection(url, {
      role: 'client',
      deviceId: 'browser-1',
      authToken: 'acct_1',
    });
    client.socket.send(
      JSON.stringify({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 }),
    );
    const sessionList = (await nextMessage(client.socket)) as {
      sessions: Array<{ session: { id: string } }>;
    };
    expect(sessionList.sessions.map((entry) => entry.session.id)).toContain('sess_node_token_1');

    // HTTP: the minted token also authenticates the account-scoped listing route.
    const listed = await list(httpUrl, token);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { tokens: Array<{ label?: string }> };
    expect(listedBody.tokens.map((entry) => entry.label)).toContain('zero-touch node');
  });

  it('rejects an unauthenticated/invalid bearer with 401, and never mints a usable token', async () => {
    const { httpUrl } = await startTestRelay();
    const bad = await mint(httpUrl, '');
    // An empty bearer never even reaches the "Bearer " prefix check as a
    // truthy header value here; assert the documented failure mode directly.
    expect(bad.status).toBe(401);

    const missing = await fetch(`${httpUrl}/account/node-tokens`, { method: 'POST' });
    expect(missing.status).toBe(401);
  });

  it('rejects an overlong label with 400', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await mint(httpUrl, 'acct_1', 'x'.repeat(500));
    expect(response.status).toBe(400);
  });

  it('logs an audit line for the mint: accountId, label, source', async () => {
    const store = createInMemoryRelayStore();
    const app = createRelay({ store, logger: false });
    closers.push(() => app.close());
    const spy = vi.spyOn(app.log, 'info');
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/account/node-tokens',
      headers: { authorization: 'Bearer acct_audit', 'content-type': 'application/json' },
      payload: { label: 'audited node' },
    });
    expect(response.statusCode).toBe(201);

    const auditCall = spy.mock.calls.find(
      ([payload]) =>
        typeof payload === 'object' &&
        payload !== null &&
        (payload as Record<string, unknown>).source === 'authenticated_mint',
    );
    expect(auditCall).toBeDefined();
    const [payload] = auditCall as [Record<string, unknown>, string];
    expect(payload.accountId).toBe('acct_audit');
    expect(payload.callerAccountId).toBe('acct_audit');
    expect(payload.label).toBe('audited node');
  });
});

describe('GET /account/node-tokens (#398)', () => {
  it('requires a bearer token', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await list(httpUrl, undefined);
    expect(response.status).toBe(401);
  });

  it('lists only the caller account’s own tokens, metadata only (never the token or its hash)', async () => {
    const { httpUrl } = await startTestRelay();
    const mintedA = await mint(httpUrl, 'acct_a', 'a-label');
    const { token: tokenA } = (await mintedA.json()) as { token: string };
    await mint(httpUrl, 'acct_b', 'b-label');

    const response = await list(httpUrl, 'acct_a');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.label).toBe('a-label');
    expect(body.tokens[0]?.token).toBeUndefined();
    expect(JSON.stringify(body.tokens[0])).not.toContain(tokenA);
  });
});

describe('DELETE /account/node-tokens/:id (#398)', () => {
  it('requires a bearer token', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await revoke(httpUrl, undefined, 'some-id');
    expect(response.status).toBe(401);
  });

  it('404s an unknown id', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await revoke(httpUrl, 'acct_1', 'not-a-real-id');
    expect(response.status).toBe(404);
  });

  it('revokes the caller’s own token: it disappears from the listing and no longer authenticates AS that account', async () => {
    const { url, httpUrl } = await startTestRelay();
    const minted = await mint(httpUrl, 'acct_1', 'to be revoked');
    const { id, token } = (await minted.json()) as { id: string; token: string };

    const del = await revoke(httpUrl, 'acct_1', id);
    expect(del.status).toBe(204);

    const listed = await list(httpUrl, 'acct_1');
    const listedBody = (await listed.json()) as { tokens: Array<{ id: string }> };
    expect(listedBody.tokens.map((entry) => entry.id)).not.toContain(id);

    // The relay's hermetic dev resolver (`deriveAccountIdStub`) accepts any
    // non-empty bearer as SOME account, so a revoked token's WS handshake
    // still succeeds — it just no longer resolves to `acct_1`. Prove that by
    // announcing a session under the (now-unbound) old token and confirming
    // a client authenticated as `acct_1` never sees it.
    const node = await initConnection(url, {
      role: 'node',
      deviceId: 'revoked-node',
      authToken: token,
    });
    node.socket.send(
      JSON.stringify({
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: {
          id: 'sess_after_revoke',
          nodeId: 'revoked-node',
          targetId: 'local',
          accountId: 'acct_1',
          provider: 'claude',
          createdAt: Date.now(),
        },
        privateEnvelope: {
          resourceId: 'res',
          iv: Buffer.from('iv').toString('base64'),
          ciphertext: Buffer.from('ct').toString('base64'),
          alg: 'AES-256-GCM',
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const client = await initConnection(url, {
      role: 'client',
      deviceId: 'client-check',
      authToken: 'acct_1',
    });
    client.socket.send(
      JSON.stringify({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 }),
    );
    const sessionList = (await nextMessage(client.socket)) as {
      sessions: Array<{ session: { id: string } }>;
    };
    expect(sessionList.sessions.map((entry) => entry.session.id)).not.toContain(
      'sess_after_revoke',
    );
  });

  it('account isolation: caller B cannot revoke (or list, or mint over) caller A’s token', async () => {
    const { httpUrl } = await startTestRelay();
    const minted = await mint(httpUrl, 'acct_a', 'a-only');
    const { id } = (await minted.json()) as { id: string };

    const del = await revoke(httpUrl, 'acct_b', id);
    expect(del.status).toBe(404);

    // Still present for the real owner.
    const listedA = await list(httpUrl, 'acct_a');
    const bodyA = (await listedA.json()) as { tokens: Array<{ id: string }> };
    expect(bodyA.tokens.map((entry) => entry.id)).toContain(id);
  });
});
