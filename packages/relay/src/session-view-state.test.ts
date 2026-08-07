import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type Initialize,
  type InitializeResult,
  type SessionMetaPublic,
  type SessionViewStateGetRequest,
  type SessionViewStateResult,
  type SessionViewStateSet,
} from '@loombox/protocol';

import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * Device-switch state preservation (issue #198, epic #6):
 * `session_view_state_get_request`/`session_view_state_set`/
 * `session_view_state_result`. Session-scoped, unlike `keymap.test.ts`'s
 * account-scoped sibling — every case here seeds a session directly via
 * `store.sessions.announce` (no node connection needed, mirrors
 * `prune.test.ts`'s own harness), then exercises the same
 * "fully replace, push live to every other same-account connection" wire
 * contract `keymap.test.ts` already proves for the account-scoped case,
 * plus the ownership guard `session_resume` itself already enforces.
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
  return { store, url };
}

function connectWs(url: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => resolve(socket), { once: true });
  socket.addEventListener('error', () => reject(new Error('ws connect error')), { once: true });
  return promise;
}

function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
  socket.addEventListener(
    'message',
    (event) => {
      clearTimeout(timer);
      resolve(JSON.parse((event as MessageEvent).data.toString()) as Record<string, unknown>);
    },
    { once: true },
  );
  return promise;
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

function fakeEnvelope(seed: string, resourceId = 'sess_1'): EncryptedEnvelope {
  return {
    resourceId,
    iv: Buffer.from(`${seed}-iv`).toString('base64'),
    ciphertext: Buffer.from(`${seed}-ct`).toString('base64'),
    alg: 'AES-256-GCM',
  };
}

const ENVELOPE_A = fakeEnvelope('view-state-a');
const ENVELOPE_B = fakeEnvelope('view-state-b');

describe('session_view_state_get_request / session_view_state_set / session_view_state_result (issue #198)', () => {
  it('a session with nothing saved yet gets envelope: null, revision: 0, not an error', async () => {
    const { url, store } = await startTestRelay();
    await store.sessions.announce({
      meta: makeSessionMeta(),
      privateEnvelope: fakeEnvelope('title'),
    });
    const { socket } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    const request: SessionViewStateGetRequest = {
      type: 'session_view_state_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      sessionId: 'sess_1',
    };
    socket.send(JSON.stringify(request));
    const response = (await nextMessage(socket)) as unknown as SessionViewStateResult;

    expect(response.type).toBe('session_view_state_result');
    expect(response.requestId).toBe('req-1');
    expect(response.envelope).toBeNull();
    expect(response.revision).toBe(0);
  });

  it('a saved view state round-trips back on get, keyed by session not account, and persists in the store', async () => {
    const { url, store } = await startTestRelay();
    await store.sessions.announce({
      meta: makeSessionMeta(),
      privateEnvelope: fakeEnvelope('title'),
    });
    const { socket } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    const setRequest: SessionViewStateSet = {
      type: 'session_view_state_set',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-set',
      sessionId: 'sess_1',
      envelope: ENVELOPE_A,
      revision: 7,
    };
    socket.send(JSON.stringify(setRequest));
    const ack = (await nextMessage(socket)) as unknown as SessionViewStateResult;
    expect(ack.type).toBe('session_view_state_result');
    expect(ack.requestId).toBe('req-set');
    expect(ack.envelope).toEqual(ENVELOPE_A);
    expect(ack.revision).toBe(7);

    expect(store.sessionViewStates.get('sess_1')).toEqual({ envelope: ENVELOPE_A, revision: 7 });

    const getRequest: SessionViewStateGetRequest = {
      type: 'session_view_state_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-get',
      sessionId: 'sess_1',
    };
    socket.send(JSON.stringify(getRequest));
    const getResponse = (await nextMessage(socket)) as unknown as SessionViewStateResult;
    expect(getResponse.envelope).toEqual(ENVELOPE_A);
    expect(getResponse.revision).toBe(7);
  });

  it('a SECOND device signing in later on the same account sees the already-saved view state — this is the actual device-switch resume path', async () => {
    const { url, store } = await startTestRelay();
    await store.sessions.announce({
      meta: makeSessionMeta(),
      privateEnvelope: fakeEnvelope('title'),
    });
    const { socket: laptop } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });
    const setRequest: SessionViewStateSet = {
      type: 'session_view_state_set',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-set',
      sessionId: 'sess_1',
      envelope: ENVELOPE_A,
      revision: 2,
    };
    laptop.send(JSON.stringify(setRequest));
    await nextMessage(laptop);

    // The device switch itself: a different device, same account, opening
    // the same session for the first time.
    const { socket: phone } = await initConnection(url, {
      role: 'client',
      deviceId: 'phone-1',
      authToken: 'acct_1',
    });
    const getRequest: SessionViewStateGetRequest = {
      type: 'session_view_state_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-new-device',
      sessionId: 'sess_1',
    };
    phone.send(JSON.stringify(getRequest));
    const response = (await nextMessage(phone)) as unknown as SessionViewStateResult;
    expect(response.envelope).toEqual(ENVELOPE_A);
    expect(response.revision).toBe(2);
  });

  it('a live device on the same account is pushed the new view state immediately, without asking for it', async () => {
    const { url, store } = await startTestRelay();
    await store.sessions.announce({
      meta: makeSessionMeta(),
      privateEnvelope: fakeEnvelope('title'),
    });
    const { socket: deviceA } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });
    const { socket: deviceB } = await initConnection(url, {
      role: 'client',
      deviceId: 'phone-1',
      authToken: 'acct_1',
    });

    const setRequest: SessionViewStateSet = {
      type: 'session_view_state_set',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-from-a',
      sessionId: 'sess_1',
      envelope: ENVELOPE_A,
      revision: 4,
    };
    // deviceB never sent this request and gets no ack of its own — only
    // the live push.
    const deviceBPush = nextMessage(deviceB);
    deviceA.send(JSON.stringify(setRequest));
    const deviceAAck = (await nextMessage(deviceA)) as unknown as SessionViewStateResult;
    expect(deviceAAck.envelope).toEqual(ENVELOPE_A);

    const pushed = (await deviceBPush) as unknown as SessionViewStateResult;
    expect(pushed.type).toBe('session_view_state_result');
    expect(pushed.sessionId).toBe('sess_1');
    expect(pushed.envelope).toEqual(ENVELOPE_A);
    expect(pushed.revision).toBe(4);
  });

  it('a later full write overwrites the earlier one — last write wins, never a partial patch', async () => {
    const { url, store } = await startTestRelay();
    await store.sessions.announce({
      meta: makeSessionMeta(),
      privateEnvelope: fakeEnvelope('title'),
    });
    const { socket } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    socket.send(
      JSON.stringify({
        type: 'session_view_state_set',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        sessionId: 'sess_1',
        envelope: ENVELOPE_A,
        revision: 1,
      } satisfies SessionViewStateSet),
    );
    await nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'session_view_state_set',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-2',
        sessionId: 'sess_1',
        envelope: ENVELOPE_B,
        revision: 9,
      } satisfies SessionViewStateSet),
    );
    await nextMessage(socket);

    expect(store.sessionViewStates.get('sess_1')).toEqual({ envelope: ENVELOPE_B, revision: 9 });
  });

  it('a different account gets no reply at all for a foreign session\u2019s view state, on both get and set', async () => {
    const { url, store } = await startTestRelay();
    await store.sessions.announce({
      meta: makeSessionMeta({ accountId: 'acct_1' }),
      privateEnvelope: fakeEnvelope('title'),
    });
    const { socket: stranger } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-2',
      authToken: 'acct_2',
    });

    stranger.send(
      JSON.stringify({
        type: 'session_view_state_get_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-get',
        sessionId: 'sess_1',
      } satisfies SessionViewStateGetRequest),
    );
    await expect(nextMessage(stranger, 300)).rejects.toThrow();

    stranger.send(
      JSON.stringify({
        type: 'session_view_state_set',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-set',
        sessionId: 'sess_1',
        envelope: ENVELOPE_A,
        revision: 1,
      } satisfies SessionViewStateSet),
    );
    await expect(nextMessage(stranger, 300)).rejects.toThrow();
    expect(store.sessionViewStates.get('sess_1')).toBeUndefined();
  });

  it('a request for a session that does not exist at all gets no reply, same as `session_resume`\u2019s own unknown-session guard', async () => {
    const { url } = await startTestRelay();
    const { socket } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    socket.send(
      JSON.stringify({
        type: 'session_view_state_get_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-get',
        sessionId: 'sess_never_existed',
      } satisfies SessionViewStateGetRequest),
    );
    await expect(nextMessage(socket, 300)).rejects.toThrow();
  });
});
