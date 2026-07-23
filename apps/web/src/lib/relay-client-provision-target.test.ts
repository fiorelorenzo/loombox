import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateAmk } from '@loombox/crypto';
import { PROTOCOL_V1, type ProvisionTargetRequest, type WireMessageV1 } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { RelayClient, type WebSocketConstructor, type WebSocketLike } from './relay-client';

/**
 * `RelayClient.provisionTarget()` (issue #408's zero-touch add-target
 * wizard). Connects to a REAL in-process relay (`startRelay()`) exactly like
 * every other `RelayClient` test — `initialize`/the WS handshake/every other
 * message this client sends or receives goes through the real relay
 * unchanged.
 *
 * The three NEW wire messages this issue adds (`provision_target_request`/
 * `provision_progress`/`provision_target_result`, `@loombox/protocol`'s
 * `provisioning.ts`) are additive-only on the relay: this wave spans
 * `packages/protocol` + `packages/node` + `apps/web` ONLY (a hard rule for
 * this issue) — `packages/relay`'s own routing switch needs a case
 * addressed by `nodeId` to actually forward these between a client and a
 * node, and adding that is an explicit, separate follow-up (see
 * `provisioning.ts`'s own doc comment). Until then this relay, like any
 * relay that doesn't recognize a message type, logs a warning and drops it
 * — it never reaches a node, and a node's replies never reach a client.
 *
 * So `ProvisioningRelayStub` below is a small `WebSocketConstructor`
 * wrapping this test's REAL connection to the real relay: every OTHER frame
 * (`initialize`, `session_list_request`, ...) passes through untouched, but
 * a `provision_target_request` send is intercepted and handed to this
 * test's own `onRequest` callback instead of going out over the wire (since
 * the real relay would just drop it), and `deliverToClient()` synthesizes an
 * inbound `message` event for `provision_progress`/`provision_target_result`
 * (as the future relay-routed reply from the node would look, once that
 * follow-up lands). This proves `RelayClient`'s OWN request/progress/result
 * framing and state machine are correct against the real wire schema, which
 * is this issue's actual scope — not that today's relay already routes them
 * end to end, which it deliberately doesn't yet.
 */

let relay: StartedRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

class ProvisioningRelayStub implements WebSocketLike {
  private readonly real: WebSocketLike;
  private messageListener?: (event: { data: unknown }) => void;

  constructor(
    url: string,
    private readonly onRequest: (request: ProvisionTargetRequest) => void,
    onCreated?: (stub: ProvisioningRelayStub) => void,
  ) {
    this.real = new WebSocket(url) as unknown as WebSocketLike;
    onCreated?.(this);
  }

  get readyState(): number {
    return this.real.readyState;
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as WireMessageV1;
    if (parsed.type === 'provision_target_request') {
      this.onRequest(parsed);
      return;
    }
    this.real.send(data);
  }

  close(): void {
    this.real.close();
  }

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    switch (type) {
      case 'open':
        this.real.addEventListener('open', listener as () => void);
        return;
      case 'message':
        this.messageListener = listener as (event: { data: unknown }) => void;
        this.real.addEventListener('message', listener as (event: { data: unknown }) => void);
        return;
      case 'close':
        this.real.addEventListener('close', listener as () => void);
        return;
      case 'error':
        this.real.addEventListener('error', listener as () => void);
        return;
    }
  }

  /** Synthesizes an inbound message on THIS client's socket, as if the (future, relay-routed) node reply had arrived. */
  deliverToClient(message: WireMessageV1): void {
    this.messageListener?.({ data: JSON.stringify(message) });
  }
}

function buildClient(onRequest: (request: ProvisionTargetRequest) => void): {
  client: RelayClient;
  stub: () => ProvisioningRelayStub;
} {
  let latestStub: ProvisioningRelayStub | undefined;
  const ctor = function (this: unknown, url: string) {
    return new ProvisioningRelayStub(url, onRequest, (stub) => {
      latestStub = stub;
    });
  } as unknown as WebSocketConstructor;

  const client = new RelayClient({
    relayUrl: relay?.url ?? '',
    amk: generateAmk(),
    accountId: 'acct_provision_1',
    webSocketImpl: ctor,
  });
  return { client, stub: () => latestStub! };
}

async function waitForOpen(client: RelayClient): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { get } = await import('svelte/store');
    if (get(client.status) === 'open') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('RelayClient never reached status "open"');
}

describe('RelayClient.provisionTarget (#408)', () => {
  it('sends a valid provision_target_request, streams onProgress for each provision_progress, and resolves with the final provision_target_result', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });
    let capturedRequest: ProvisionTargetRequest | undefined;
    const { client, stub } = buildClient((request) => {
      capturedRequest = request;
    });
    client.connect();
    await waitForOpen(client);

    const progressSeen: string[] = [];
    const resultPromise = client.provisionTarget({
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      host: { host: '10.0.0.5', user: 'loombox' },
      onProgress: (p) => progressSeen.push(`${p.step}:${p.status}`),
    });

    // Wait for the request to actually go out before "the node" replies.
    const deadline = Date.now() + 3000;
    while (!capturedRequest && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!capturedRequest) throw new Error('provision_target_request was never sent');

    expect(capturedRequest).toEqual({
      type: 'provision_target_request',
      protocolVersion: PROTOCOL_V1,
      requestId: capturedRequest.requestId,
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      host: { host: '10.0.0.5', user: 'loombox' },
    });

    const requestId = capturedRequest.requestId;
    stub().deliverToClient({
      type: 'provision_progress',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      step: 'verify_and_persist',
      status: 'started',
      message: 'verifying',
    });
    stub().deliverToClient({
      type: 'provision_progress',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      step: 'verify_and_persist',
      status: 'ok',
      message: 'verified',
    });
    stub().deliverToClient({
      type: 'provision_target_result',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      ok: true,
      message: 'paired',
    });

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(result.targetId).toBe('ssh:devbox');
    expect(progressSeen).toEqual(['verify_and_persist:started', 'verify_and_persist:ok']);
  });

  it('resolves (does not reject) with ok: false when the result reports a failed step', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });
    let capturedRequest: ProvisionTargetRequest | undefined;
    const { client, stub } = buildClient((request) => {
      capturedRequest = request;
    });
    client.connect();
    await waitForOpen(client);

    const resultPromise = client.provisionTarget({
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      host: { host: '10.0.0.5' },
    });

    const deadline = Date.now() + 3000;
    while (!capturedRequest && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!capturedRequest) throw new Error('provision_target_request was never sent');

    stub().deliverToClient({
      type: 'provision_target_result',
      protocolVersion: PROTOCOL_V1,
      requestId: capturedRequest.requestId,
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      ok: false,
      failedStep: 'mint_node_token',
      message: 'mint failed',
    });

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('mint_node_token');
  });

  it('rejects immediately when there is no open connection', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });
    const { client } = buildClient(() => {});
    await expect(
      client.provisionTarget({
        nodeId: 'node-acting',
        targetId: 'ssh:devbox',
        host: { host: 'x' },
      }),
    ).rejects.toThrow(/no open connection/);
  });

  it('a provision_progress for an unknown requestId is ignored (no pending call to attach it to)', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });
    const { client, stub } = buildClient(() => {});
    client.connect();
    await waitForOpen(client);

    // Should not throw synchronously and should not crash the client.
    stub().deliverToClient({
      type: 'provision_progress',
      protocolVersion: PROTOCOL_V1,
      requestId: 'no-such-request',
      nodeId: 'node-acting',
      targetId: 'ssh:devbox',
      step: 'verify_and_persist',
      status: 'started',
      message: 'x',
    });

    // The client is still usable afterward.
    await expect(
      client.provisionTarget(
        { nodeId: 'node-acting', targetId: 'ssh:devbox', host: { host: 'x' } },
        50,
      ),
    ).rejects.toThrow(/timed out/);
  });
});
