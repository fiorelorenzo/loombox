import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_V1, type Initialize, type InitializeResult } from '@loombox/protocol';

import { hashDeviceSecret } from './device-auth';
import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * The device-authorization-grant HTTP endpoints end to end (issue #387,
 * RFC 8628-shaped — see `device-auth.ts`'s module doc comment): authorize ->
 * pending -> approve binds an account -> the resulting device token is
 * issued exactly once -> that token authenticates the WS handshake AND is
 * scoped to the approving account only -> expiry/denial are surfaced with
 * distinct errors. Deliberately its own file (not appended to the already
 * large `relay.test.ts`), mirroring `push-delivery.test.ts`'s own rationale.
 *
 * No Better Auth instance is mounted (`startRelay()` without `auth`) — the
 * relay's default dev/hermetic resolver (`deriveAccountIdStub`) treats any
 * non-empty bearer as its own accountId, exactly like every other hermetic
 * test in this package (`push-delivery.test.ts`'s `Bearer acct_1`
 * convention). This is what makes it meaningful to assert a device token
 * resolves to the SAME accountId that approved it (`'acct_1'`), not to the
 * device token's own (unrelated, random) string value.
 */

type Close = () => Promise<void>;
let closers: Close[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

interface Authorized {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

async function authorize(httpUrl: string): Promise<Authorized> {
  const response = await fetch(`${httpUrl}/device/authorize`, { method: 'POST' });
  expect(response.status).toBe(200);
  return (await response.json()) as Authorized;
}

async function approve(httpUrl: string, userCode: string, bearer: string): Promise<Response> {
  return fetch(`${httpUrl}/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ user_code: userCode }),
  });
}

async function deny(httpUrl: string, userCode: string, bearer: string): Promise<Response> {
  return fetch(`${httpUrl}/device/deny`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ user_code: userCode }),
  });
}

async function poll(httpUrl: string, deviceCode: string): Promise<Response> {
  return fetch(`${httpUrl}/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

async function startTestRelay() {
  const store = createInMemoryRelayStore();
  const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
  closers.push(close);
  const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
  return { store, url, httpUrl };
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

describe('POST /device/authorize (#387)', () => {
  it('mints a pending request with a short human-typable user_code and a long device_code', async () => {
    const { httpUrl } = await startTestRelay();
    const authorized = await authorize(httpUrl);

    expect(authorized.device_code.length).toBeGreaterThan(32);
    expect(authorized.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(authorized.verification_uri).toContain('/device');
    expect(authorized.verification_uri_complete).toContain(authorized.user_code);
    expect(authorized.interval).toBeGreaterThan(0);
    expect(authorized.expires_in).toBeGreaterThan(0);
  });

  it('honors LOOMBOX_APP_URL-equivalent deviceAuth.appUrl for verification_uri', async () => {
    const store = createInMemoryRelayStore();
    const { url, close } = await startRelay({
      host: '127.0.0.1',
      port: 0,
      store,
      deviceAuth: { appUrl: 'https://app.example.test/' },
    });
    closers.push(close);
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

    const authorized = await authorize(httpUrl);
    expect(authorized.verification_uri).toBe('https://app.example.test/device');
  });
});

describe('POST /device/token before approval (#387)', () => {
  it('reports authorization_pending while the request is still pending', async () => {
    const { httpUrl } = await startTestRelay();
    const authorized = await authorize(httpUrl);

    const response = await poll(httpUrl, authorized.device_code);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'authorization_pending' });
  });

  it('rejects an unknown device_code with invalid_grant', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await poll(httpUrl, 'not-a-real-device-code');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });
});

describe('POST /device/approve (#387)', () => {
  it('requires a bearer token', async () => {
    const { httpUrl } = await startTestRelay();
    const authorized = await authorize(httpUrl);

    const response = await fetch(`${httpUrl}/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: authorized.user_code }),
    });
    expect(response.status).toBe(401);
  });

  it('404s an unknown user_code', async () => {
    const { httpUrl } = await startTestRelay();
    const response = await approve(httpUrl, 'ZZZZ-ZZZZ', 'acct_1');
    expect(response.status).toBe(404);
  });

  it('accepts operator-typed variants (lowercase, missing dash, stray whitespace) of the user_code', async () => {
    const { httpUrl } = await startTestRelay();
    const authorized = await authorize(httpUrl);
    const messy = ` ${authorized.user_code.toLowerCase().replace('-', ' ')} `;

    const response = await approve(httpUrl, messy, 'acct_1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'approved' });
  });

  it('409s re-approving an already-approved (or denied) request', async () => {
    const { httpUrl } = await startTestRelay();
    const authorized = await authorize(httpUrl);
    await approve(httpUrl, authorized.user_code, 'acct_1');

    const second = await approve(httpUrl, authorized.user_code, 'acct_1');
    expect(second.status).toBe(409);
  });
});

describe('the full device-authorization flow (#387)', () => {
  it('authorize -> pending -> approve binds the account -> token issued exactly once -> WS auth accepts it and resolves the approving account', async () => {
    const { url, httpUrl } = await startTestRelay();
    const authorized = await authorize(httpUrl);

    const approveResponse = await approve(httpUrl, authorized.user_code, 'acct_1');
    expect(approveResponse.status).toBe(200);

    const first = await poll(httpUrl, authorized.device_code);
    expect(first.status).toBe(200);
    const { access_token: accessToken } = (await first.json()) as { access_token: string };
    expect(typeof accessToken).toBe('string');
    expect(accessToken.length).toBeGreaterThan(32);
    // The minted device token is a distinct secret from the account bearer
    // that approved it, and from the device_code itself.
    expect(accessToken).not.toBe('acct_1');
    expect(accessToken).not.toBe(authorized.device_code);

    // One-time reveal: polling again after a successful reveal is no longer "pending".
    const second = await poll(httpUrl, authorized.device_code);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'expired' });

    // The device token authenticates a real WS connection...
    const node = await initConnection(url, {
      role: 'node',
      deviceId: 'resident-node-1',
      authToken: accessToken,
    });
    expect(node.result.type).toBe('initialize_result');

    node.socket.send(
      JSON.stringify({
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: {
          id: 'sess_device_auth_1',
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

    // ...and resolves to the SAME accountId ('acct_1') the browser bearer
    // approved with — a client signed in with the ordinary account bearer
    // sees the session the device-token-authenticated node announced.
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
    expect(sessionList.sessions.map((entry) => entry.session.id)).toContain('sess_device_auth_1');
  });

  it('account isolation: a device token minted for one account never sees another account’s sessions', async () => {
    const { url, httpUrl } = await startTestRelay();

    const authorizedA = await authorize(httpUrl);
    await approve(httpUrl, authorizedA.user_code, 'acct_a');
    const tokenAResponse = await poll(httpUrl, authorizedA.device_code);
    const { access_token: tokenA } = (await tokenAResponse.json()) as { access_token: string };

    const authorizedB = await authorize(httpUrl);
    await approve(httpUrl, authorizedB.user_code, 'acct_b');
    const tokenBResponse = await poll(httpUrl, authorizedB.device_code);
    const { access_token: tokenB } = (await tokenBResponse.json()) as { access_token: string };

    expect(tokenA).not.toBe(tokenB);

    const nodeA = await initConnection(url, {
      role: 'node',
      deviceId: 'node-a',
      authToken: tokenA,
    });
    nodeA.socket.send(
      JSON.stringify({
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: {
          id: 'sess_a',
          nodeId: 'node-a',
          targetId: 'local',
          accountId: 'acct_a',
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

    const clientB = await initConnection(url, {
      role: 'client',
      deviceId: 'client-b',
      authToken: tokenB,
    });
    clientB.socket.send(
      JSON.stringify({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 }),
    );
    const sessionList = (await nextMessage(clientB.socket)) as {
      sessions: Array<{ session: { id: string } }>;
    };
    expect(sessionList.sessions.map((entry) => entry.session.id)).not.toContain('sess_a');
  });
});

describe('POST /device/deny (#387)', () => {
  it('marks a pending request denied, and a subsequent poll reports denied', async () => {
    const { httpUrl } = await startTestRelay();
    const authorized = await authorize(httpUrl);

    const denyResponse = await deny(httpUrl, authorized.user_code, 'acct_1');
    expect(denyResponse.status).toBe(200);
    expect(await denyResponse.json()).toEqual({ status: 'denied' });

    const pollResponse = await poll(httpUrl, authorized.device_code);
    expect(pollResponse.status).toBe(400);
    expect(await pollResponse.json()).toEqual({ error: 'denied' });
  });

  it('requires a bearer token, and 404s an unknown user_code', async () => {
    const { httpUrl } = await startTestRelay();
    const unauthed = await fetch(`${httpUrl}/device/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: 'ZZZZ-ZZZZ' }),
    });
    expect(unauthed.status).toBe(401);

    const notFound = await deny(httpUrl, 'ZZZZ-ZZZZ', 'acct_1');
    expect(notFound.status).toBe(404);
  });
});

describe('expiry (#387)', () => {
  it('an approve against an already-expired request reports expired, and never mints a usable token', async () => {
    const { store, httpUrl } = await startTestRelay();
    const now = Date.now();
    await store.deviceAuth.create({
      deviceCodeHash: 'expired-device-code-hash',
      userCode: 'EXPR-EDCD',
      createdAt: now - 20_000,
      expiresAt: now - 10_000,
    });

    const response = await approve(httpUrl, 'EXPR-EDCD', 'acct_1');
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'expired' });
  });

  it('a poll against an already-expired request reports expired', async () => {
    const { store, httpUrl } = await startTestRelay();
    const now = Date.now();
    const deviceCode = 'raw-expired-device-code';
    await store.deviceAuth.create({
      deviceCodeHash: hashDeviceSecret(deviceCode),
      userCode: 'EXPR-TOKN',
      createdAt: now - 20_000,
      expiresAt: now - 10_000,
    });

    const response = await poll(httpUrl, deviceCode);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'expired' });
  });
});
