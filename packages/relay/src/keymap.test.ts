import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  type Initialize,
  type InitializeResult,
  type KeymapGetRequest,
  type KeymapResult,
  type KeymapSetRequest,
} from '@loombox/protocol';

import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * The account-scoped keymap sync path (Zed-parity F3-3, issue #760):
 * `keymap_get_request`/`keymap_set_request`/`keymap_result`, client ->
 * relay -> client, exactly like `connected_account_list_request`/
 * `connected_account_list` — except there is no node in this path at all
 * (a keymap needs zero sessions/projects/nodes to exist), and a save is
 * pushed live to every OTHER connection on the same account, not just
 * answered to the sender (issue #760's "two tabs" cost). Mirrors
 * `connected-accounts.test.ts`'s own harness verbatim.
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

const ENVELOPE_A = {
  resourceId: 'acct-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};
const ENVELOPE_B = {
  resourceId: 'acct-1',
  iv: 'd29ybGQ=',
  ciphertext: 'ZWZnaA==',
  alg: 'AES-256-GCM' as const,
};

describe('keymap_get_request / keymap_set_request / keymap_result (Zed-parity F3-3, #760)', () => {
  it('a fresh connection with nothing saved gets envelope: null, not an error', async () => {
    const { url } = await startTestRelay();
    const { socket } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    const request: KeymapGetRequest = {
      type: 'keymap_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
    };
    socket.send(JSON.stringify(request));
    const response = (await nextMessage(socket)) as unknown as KeymapResult;

    expect(response.type).toBe('keymap_result');
    expect(response.requestId).toBe('req-1');
    expect(response.envelope).toBeNull();
  });

  it('a saved keymap round-trips back on get, and persists across the store (no node involved anywhere)', async () => {
    const { url, store } = await startTestRelay();
    const { socket } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    const setRequest: KeymapSetRequest = {
      type: 'keymap_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-set',
      envelope: ENVELOPE_A,
    };
    socket.send(JSON.stringify(setRequest));
    const ack = (await nextMessage(socket)) as unknown as KeymapResult;
    expect(ack.type).toBe('keymap_result');
    expect(ack.requestId).toBe('req-set');
    expect(ack.envelope).toEqual(ENVELOPE_A);

    // Stored relay-side under the account, not the device/connection.
    expect(store.keymaps.get('acct_1')).toEqual(ENVELOPE_A);

    const getRequest: KeymapGetRequest = {
      type: 'keymap_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-get',
    };
    socket.send(JSON.stringify(getRequest));
    const getResponse = (await nextMessage(socket)) as unknown as KeymapResult;
    expect(getResponse.envelope).toEqual(ENVELOPE_A);
  });

  it('a NEW device signing in under the same account sees the already-saved keymap — no node, no prior session required', async () => {
    const { url } = await startTestRelay();
    const { socket: laptop } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });
    const setRequest: KeymapSetRequest = {
      type: 'keymap_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-set',
      envelope: ENVELOPE_A,
    };
    laptop.send(JSON.stringify(setRequest));
    await nextMessage(laptop);

    // A brand-new device, same account, that never sent anything before.
    const { socket: phone } = await initConnection(url, {
      role: 'client',
      deviceId: 'phone-1',
      authToken: 'acct_1',
    });
    const getRequest: KeymapGetRequest = {
      type: 'keymap_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-new-device',
    };
    phone.send(JSON.stringify(getRequest));
    const response = (await nextMessage(phone)) as unknown as KeymapResult;
    expect(response.envelope).toEqual(ENVELOPE_A);
  });

  it('two tabs on the same account: the second tab is pushed the winning keymap live, without asking for it', async () => {
    const { url } = await startTestRelay();
    const { socket: tabA } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });
    const { socket: tabB } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    const setRequest: KeymapSetRequest = {
      type: 'keymap_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-from-a',
      envelope: ENVELOPE_A,
    };
    // tabB never sent this request, and gets no ack of its own — only the
    // live push.
    const tabBPush = nextMessage(tabB);
    tabA.send(JSON.stringify(setRequest));
    const tabAAck = (await nextMessage(tabA)) as unknown as KeymapResult;
    expect(tabAAck.envelope).toEqual(ENVELOPE_A);

    const pushed = (await tabBPush) as unknown as KeymapResult;
    expect(pushed.type).toBe('keymap_result');
    expect(pushed.envelope).toEqual(ENVELOPE_A);
  });

  it('a second full write from tab B overwrites tab A\u2019s — last write wins, and tab A is pushed the new winner', async () => {
    const { url, store } = await startTestRelay();
    const { socket: tabA } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });
    const { socket: tabB } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });

    const tabAPush = nextMessage(tabA);
    const setB: KeymapSetRequest = {
      type: 'keymap_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-from-b',
      envelope: ENVELOPE_B,
    };
    tabB.send(JSON.stringify(setB));
    await nextMessage(tabB);
    const pushedToA = (await tabAPush) as unknown as KeymapResult;
    expect(pushedToA.envelope).toEqual(ENVELOPE_B);

    expect(store.keymaps.get('acct_1')).toEqual(ENVELOPE_B);
  });

  it('a different account never sees this account\u2019s keymap, saved or not', async () => {
    const { url } = await startTestRelay();
    const { socket: acctOne } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-1',
      authToken: 'acct_1',
    });
    const setRequest: KeymapSetRequest = {
      type: 'keymap_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-set',
      envelope: ENVELOPE_A,
    };
    acctOne.send(JSON.stringify(setRequest));
    await nextMessage(acctOne);

    const { socket: acctTwo } = await initConnection(url, {
      role: 'client',
      deviceId: 'laptop-2',
      authToken: 'acct_2',
    });
    const getRequest: KeymapGetRequest = {
      type: 'keymap_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-get',
    };
    acctTwo.send(JSON.stringify(getRequest));
    const response = (await nextMessage(acctTwo)) as unknown as KeymapResult;
    expect(response.envelope).toBeNull();
  });
});
