import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  type AccountPinResolveRequest,
  type AccountPinSetRequest,
  type ConnectedAccount,
  type ConnectedAccountDisconnectRequest,
  type GithubConnectStartRequest,
  type GithubPatConnectRequest,
  type Initialize,
  type InitializeResult,
  type JiraConnectRequest,
} from '@loombox/protocol';

import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

/**
 * SPEC §7.26's connect/disconnect/pin wire surface (issue #230) — the
 * routing this file exercises never touches a token/credential itself
 * (that's `packages/node`'s job); it only proves the relay gets each
 * message to the right place: a client's request reaches the `nodeId` it
 * named, and a node's reply reaches the exact client that asked, scoped to
 * account, with `pendingAccountRequests`'s multi-message case (the GitHub
 * device flow) and disconnect's store-removal side effect both covered.
 */

type Close = () => Promise<void>;
let closers: Close[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function startTestRelay(opts: { accountRequestTtlMs?: number } = {}) {
  const store = createInMemoryRelayStore();
  const { url, close } = await startRelay({
    host: '127.0.0.1',
    port: 0,
    store,
    accountRequestTtlMs: opts.accountRequestTtlMs,
  });
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
 * A real, generous wait for an announce/mutation sent over a real WebSocket
 * to land relay-side before a subsequent request that depends on it — the
 * relay handles each inbound frame in its own async task, so there is no
 * in-process signal to await instead (mirrors `connected-accounts.test.ts`'s
 * own `sleep`, same reasoning).
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Narrows a `Record<string, unknown>` field (already runtime-checked to be an object) so a test can read a nested property without an inline cast. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected ${label} to be an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
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

async function announceNode(nodeSocket: WebSocket, nodeId: string): Promise<void> {
  nodeSocket.send(
    JSON.stringify({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId,
      targets: [{ id: 'local', kind: 'local', label: 'local', providers: [] }],
    }),
  );
  await sleep(150);
}

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

describe('github connect start/cancel routing (SPEC §7.26, #230)', () => {
  it('routes the device code and terminal result back to the requesting client only', async () => {
    const { url } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    const start: GithubConnectStartRequest = {
      type: 'github_connect_start_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-gh-1',
      nodeId: 'node-1',
    };
    clientSocket.send(JSON.stringify(start));

    const forwarded = await nextMessage(nodeSocket);
    expect(forwarded.type).toBe('github_connect_start_request');
    expect(forwarded.requestId).toBe('req-gh-1');

    // The node streams the device code first...
    nodeSocket.send(
      JSON.stringify({
        type: 'github_connect_device_code',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-gh-1',
        nodeId: 'node-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresInSeconds: 900,
        intervalSeconds: 5,
      }),
    );
    const deviceCode = await nextMessage(clientSocket);
    expect(deviceCode.type).toBe('github_connect_device_code');
    expect(deviceCode.userCode).toBe('ABCD-1234');

    // ...then, later, the terminal result — the SAME requestId's routing
    // entry is still alive (the intermediate message never retires it).
    const account = githubAccount();
    nodeSocket.send(
      JSON.stringify({
        type: 'github_connect_result',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-gh-1',
        nodeId: 'node-1',
        result: { outcome: 'success', account },
      }),
    );
    const result = await nextMessage(clientSocket);
    expect(result.type).toBe('github_connect_result');
    expect(asRecord(result.result, 'result.result').outcome).toBe('success');
  });

  it('forwards a cancel request straight to the same node, addressed by nodeId', async () => {
    const { url } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    clientSocket.send(
      JSON.stringify({
        type: 'github_connect_cancel_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-gh-2',
        nodeId: 'node-1',
      }),
    );
    const forwarded = await nextMessage(nodeSocket);
    expect(forwarded.type).toBe('github_connect_cancel_request');
    expect(forwarded.requestId).toBe('req-gh-2');
  });

  it('silently drops a request for a nodeId under a different account', async () => {
    const { url } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: foreignClient } = await initConnection(url, {
      role: 'client',
      deviceId: 'foreign-device',
      authToken: 'acct_b',
    });

    foreignClient.send(
      JSON.stringify({
        type: 'github_connect_start_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-gh-3',
        nodeId: 'node-1',
      }),
    );
    await expect(nextMessage(nodeSocket, 300)).rejects.toThrow(/timed out/);
  });
});

describe('jira_connect_request / jira_connect_response routing', () => {
  it('routes a request to the named node and its response back to the requesting client', async () => {
    const { url } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    const request: JiraConnectRequest = {
      type: 'jira_connect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-jira-1',
      nodeId: 'node-1',
      siteUrl: 'myteam.atlassian.net',
      email: 'me@example.com',
      apiToken: 'tok_abc',
    };
    clientSocket.send(JSON.stringify(request));
    const forwarded = await nextMessage(nodeSocket);
    expect(forwarded).toEqual(request);

    nodeSocket.send(
      JSON.stringify({
        type: 'jira_connect_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-jira-1',
        nodeId: 'node-1',
        result: { outcome: 'failure', message: 'bad credentials' },
      }),
    );
    const response = await nextMessage(clientSocket);
    expect(asRecord(response.result, 'response.result').message).toBe('bad credentials');
  });
});

describe('github_pat_connect_request / github_pat_connect_response routing (issue #224)', () => {
  it('routes a request to the named node and its response back to the requesting client', async () => {
    const { url } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    const request: GithubPatConnectRequest = {
      type: 'github_pat_connect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-github-pat-1',
      nodeId: 'node-1',
      token: 'github_pat_11ABC',
    };
    clientSocket.send(JSON.stringify(request));
    const forwarded = await nextMessage(nodeSocket);
    expect(forwarded).toEqual(request);

    nodeSocket.send(
      JSON.stringify({
        type: 'github_pat_connect_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-github-pat-1',
        nodeId: 'node-1',
        result: { outcome: 'failure', reason: 'invalid_or_revoked', message: 'bad credentials' },
      }),
    );
    const response = await nextMessage(clientSocket);
    expect(asRecord(response.result, 'response.result').message).toBe('bad credentials');
  });
});

describe('connected_account_disconnect_request / _response', () => {
  it('on outcome ok, forgets the synced metadata row for that account only', async () => {
    const { url, store } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    const account = githubAccount();
    nodeSocket.send(
      JSON.stringify({
        type: 'connected_account_announce',
        protocolVersion: PROTOCOL_V1,
        account,
      }),
    );
    await sleep(150);
    expect(await store.connectedAccounts.listForAccount('acct_a')).toEqual([account]);

    const disconnect: ConnectedAccountDisconnectRequest = {
      type: 'connected_account_disconnect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-disc-1',
      nodeId: 'node-1',
      accountId: account.id,
    };
    clientSocket.send(JSON.stringify(disconnect));
    const forwarded = await nextMessage(nodeSocket);
    expect(forwarded).toEqual(disconnect);

    nodeSocket.send(
      JSON.stringify({
        type: 'connected_account_disconnect_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-disc-1',
        nodeId: 'node-1',
        accountId: account.id,
        outcome: 'ok',
      }),
    );
    const response = await nextMessage(clientSocket);
    expect(response.outcome).toBe('ok');
    expect(await store.connectedAccounts.listForAccount('acct_a')).toEqual([]);
  });

  it('on outcome error, leaves the synced row untouched', async () => {
    const { url, store } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    const account = githubAccount();
    nodeSocket.send(
      JSON.stringify({
        type: 'connected_account_announce',
        protocolVersion: PROTOCOL_V1,
        account,
      }),
    );
    await sleep(150);

    clientSocket.send(
      JSON.stringify({
        type: 'connected_account_disconnect_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-disc-2',
        nodeId: 'node-1',
        accountId: account.id,
      }),
    );
    await nextMessage(nodeSocket);
    nodeSocket.send(
      JSON.stringify({
        type: 'connected_account_disconnect_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-disc-2',
        nodeId: 'node-1',
        accountId: account.id,
        outcome: 'error',
        message: 'no local secret on this node',
      }),
    );
    await nextMessage(clientSocket);
    expect(await store.connectedAccounts.listForAccount('acct_a')).toEqual([account]);
  });
});

describe('account_pin_get/set/unset_request and account_pin_response routing', () => {
  it('routes a set request to the node and its response back to the client', async () => {
    const { url } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    const setRequest: AccountPinSetRequest = {
      type: 'account_pin_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-pin-1',
      nodeId: 'node-1',
      projectPath: '/home/dev/proj',
      capability: 'github',
      accountId: 'github:github.com:1234567',
    };
    clientSocket.send(JSON.stringify(setRequest));
    const forwarded = await nextMessage(nodeSocket);
    expect(forwarded).toEqual(setRequest);

    nodeSocket.send(
      JSON.stringify({
        type: 'account_pin_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-pin-1',
        nodeId: 'node-1',
        projectPath: '/home/dev/proj',
        pins: { github: 'github:github.com:1234567' },
      }),
    );
    const response = await nextMessage(clientSocket);
    expect(response.pins).toEqual({ github: 'github:github.com:1234567' });
  });
});

describe('account_pin_resolve_request / _response routing', () => {
  it('routes a resolve request and each outcome shape back to the client', async () => {
    const { url } = await startTestRelay();
    const { socket: nodeSocket } = await initConnection(url, {
      role: 'node',
      deviceId: 'node-device',
      authToken: 'acct_a',
    });
    await announceNode(nodeSocket, 'node-1');
    const { socket: clientSocket } = await initConnection(url, {
      role: 'client',
      deviceId: 'client-device',
      authToken: 'acct_a',
    });

    const account = githubAccount();
    const request: AccountPinResolveRequest = {
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-1',
      nodeId: 'node-1',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'write',
      target: { provider: 'github', host: 'github.com' },
      accounts: [account],
    };
    clientSocket.send(JSON.stringify(request));
    const forwarded = await nextMessage(nodeSocket);
    expect(forwarded).toEqual(request);

    nodeSocket.send(
      JSON.stringify({
        type: 'account_pin_resolve_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-resolve-1',
        nodeId: 'node-1',
        result: {
          outcome: 'error',
          errorType: 'AccountPinRequiredError',
          message: 'account pin required',
          capability: 'github',
        },
      }),
    );
    const response = await nextMessage(clientSocket);
    expect(asRecord(response.result, 'response.result').errorType).toBe('AccountPinRequiredError');
  });
});
