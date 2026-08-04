import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  type ConnectedAccount,
  type ConnectedAccountAnnounce,
  type ConnectedAccountList,
  type ConnectedAccountListRequest,
  type Initialize,
  type InitializeResult,
} from '@loombox/protocol';

import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * The connected-account metadata sync path (SPEC §7.26, issue #221):
 * `connected_account_announce` (node → relay, account-scoped, exactly like
 * `target_announce`/`session_announce`) and `connected_account_list_request`
 * / `connected_account_list` (client → relay → client, exactly like
 * `session_list_request`/`session_list`). The whole point is the boundary —
 * the synced row carries no secret — so every test here either exercises
 * that boundary directly or proves a second device sees the same list
 * without holding any credential of its own.
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

/**
 * A real, generous wait for an announce sent over a real WebSocket to land
 * relay-side before a subsequent request that depends on it — the relay
 * handles each inbound frame in its own async task, so there is no
 * in-process signal to await instead (mirrors `relay.test.ts`'s and
 * `node-token-routes.test.ts`'s own `target_announce`/`session_announce`
 * tests, which use the exact same real-timer wait for the same reason).
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
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

const RAW_TOKEN = 'gho_this-is-the-actual-secret-never-synced';

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'github:github.com:1234567',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1234567',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo', 'read:user', 'read:org'],
    capabilities: ['repo', 'issues'],
    connectedAt: Date.now(),
    updatedAt: Date.now(),
    secretRef: 'connected-account-token:github:github.com:1234567',
    ...overrides,
  };
}

describe('connected_account_announce / connected_account_list_request (SPEC §7.26, #221)', () => {
  it('a second device under the same account sees the announced connected account, holding no credential itself', async () => {
    const { url } = await startTestRelay();

    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-1',
      authToken: 'acct_1',
    });
    const account = githubAccount();
    const announce: ConnectedAccountAnnounce = {
      type: 'connected_account_announce',
      protocolVersion: PROTOCOL_V1,
      account,
    };
    nodeSocket.send(JSON.stringify(announce));

    // A different device, same account — never the device that connected.
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'phone-1',
      authToken: 'acct_1',
    });
    await sleep(50);

    const listRequest: ConnectedAccountListRequest = {
      type: 'connected_account_list_request',
      protocolVersion: PROTOCOL_V1,
    };
    clientSocket.send(JSON.stringify(listRequest));
    const response = (await nextMessage(clientSocket)) as unknown as ConnectedAccountList;

    expect(response.type).toBe('connected_account_list');
    expect(response.accounts).toEqual([account]);
    // The list-holding device never received, and could never have derived,
    // the actual token — only `secretRef`, a keyring lookup key.
    expect(JSON.stringify(response)).not.toContain(RAW_TOKEN);
    expect(response.accounts[0]).not.toHaveProperty('token');
    expect(response.accounts[0]?.secretRef).toBe(account.secretRef);
  });

  it('the announcing node itself can also request the list — issue #631\u2019s resolveTrackerBackend needs this, since the registry lives relay-side and a node has no independent copy', async () => {
    const { url } = await startTestRelay();

    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-1',
      authToken: 'acct_1',
    });
    const account = githubAccount();
    const announce: ConnectedAccountAnnounce = {
      type: 'connected_account_announce',
      protocolVersion: PROTOCOL_V1,
      account,
    };
    nodeSocket.send(JSON.stringify(announce));
    await sleep(50);

    const listRequest: ConnectedAccountListRequest = {
      type: 'connected_account_list_request',
      protocolVersion: PROTOCOL_V1,
    };
    nodeSocket.send(JSON.stringify(listRequest));
    const response = (await nextMessage(nodeSocket)) as unknown as ConnectedAccountList;

    expect(response.type).toBe('connected_account_list');
    expect(response.accounts).toEqual([account]);
  });

  it('boundary: a smuggled token field never reaches the store or a listing client — the wire schema strips it', async () => {
    const { url, store } = await startTestRelay();

    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-1',
      authToken: 'acct_1',
    });
    const account = githubAccount();
    // Simulate a buggy/malicious node payload carrying the actual secret
    // alongside the legitimate metadata — the field this whole issue's
    // "no secret in the synced row" property must reject regardless of
    // what a node sends.
    const withSmuggledToken = {
      type: 'connected_account_announce',
      protocolVersion: PROTOCOL_V1,
      account: { ...account, token: RAW_TOKEN, accessToken: RAW_TOKEN },
    };
    nodeSocket.send(JSON.stringify(withSmuggledToken));
    await sleep(50);

    // Never persisted in the relay's own store...
    const stored = await store.connectedAccounts.listForAccount('acct_1');
    expect(stored).toEqual([account]);
    expect(JSON.stringify(stored)).not.toContain(RAW_TOKEN);

    // ...and never forwarded to a listing client either.
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'phone-1',
      authToken: 'acct_1',
    });
    const listRequest: ConnectedAccountListRequest = {
      type: 'connected_account_list_request',
      protocolVersion: PROTOCOL_V1,
    };
    clientSocket.send(JSON.stringify(listRequest));
    const response = (await nextMessage(clientSocket)) as unknown as ConnectedAccountList;
    expect(JSON.stringify(response)).not.toContain(RAW_TOKEN);
    expect(response.accounts).toEqual([account]);
  });

  it('never leaks across accounts: a second account sees an empty list, and never another account by guessing/reusing an id', async () => {
    const { url } = await startTestRelay();

    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-1',
      authToken: 'acct_1',
    });
    const announce: ConnectedAccountAnnounce = {
      type: 'connected_account_announce',
      protocolVersion: PROTOCOL_V1,
      account: githubAccount(),
    };
    nodeSocket.send(JSON.stringify(announce));
    await sleep(50);

    const { socket: otherClientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'other-device',
      authToken: 'acct_2',
    });
    const listRequest: ConnectedAccountListRequest = {
      type: 'connected_account_list_request',
      protocolVersion: PROTOCOL_V1,
    };
    otherClientSocket.send(JSON.stringify(listRequest));
    const response = (await nextMessage(otherClientSocket)) as unknown as ConnectedAccountList;

    expect(response.accounts).toEqual([]);
  });

  it('re-announcing the same connected account (e.g. a relabel after re-auth) updates in place, never duplicates', async () => {
    const { url, store } = await startTestRelay();

    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-1',
      authToken: 'acct_1',
    });
    const account = githubAccount();
    const announce: ConnectedAccountAnnounce = {
      type: 'connected_account_announce',
      protocolVersion: PROTOCOL_V1,
      account,
    };
    nodeSocket.send(JSON.stringify(announce));
    await sleep(30);

    const relabeled: ConnectedAccountAnnounce = {
      type: 'connected_account_announce',
      protocolVersion: PROTOCOL_V1,
      account: { ...account, label: 'octocat (renamed)', updatedAt: account.updatedAt + 1 },
    };
    nodeSocket.send(JSON.stringify(relabeled));
    await sleep(30);

    const stored = await store.connectedAccounts.listForAccount('acct_1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.label).toBe('octocat (renamed)');
  });
});
