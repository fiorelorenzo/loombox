import { describe, expect, it } from 'vitest';

import type { WireMessageV1 } from '@loombox/protocol';

import { RelayLeaseClient, type RelayLike } from './relay-lease-client';

/**
 * A fake relay connection standing in for `@loombox/node`'s real
 * `RelayConnection` (which already satisfies `RelayLike`): records every
 * message sent through it and lets a test script canned inbound replies —
 * no WebSocket, no network, no `@loombox/relay` process (mirrors
 * `attachments.test.ts`'s identical `FakeRelay`).
 */
class FakeRelay implements RelayLike {
  readonly sent: WireMessageV1[] = [];
  private listeners = new Set<(message: WireMessageV1) => void>();

  send(message: WireMessageV1): void {
    this.sent.push(message);
  }

  on(_event: 'message', listener: (message: WireMessageV1) => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'message', listener: (message: WireMessageV1) => void): void {
    this.listeners.delete(listener);
  }

  /** Simulates the relay pushing an inbound message down this connection. */
  deliver(message: WireMessageV1): void {
    for (const listener of this.listeners) listener(message);
  }
}

function lastSent(relay: FakeRelay): WireMessageV1 {
  const message = relay.sent.at(-1);
  if (!message) throw new Error('FakeRelay: nothing was sent');
  return message;
}

/** `RelayLeaseClient` awaits `whenReady()` before sending, which — even for the default already-resolved gate — still yields at least one microtask; tests await this before inspecting what was sent. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RelayLeaseClient', () => {
  it('sends an acquire lease_request and resolves granted on the matching lease_result', async () => {
    const relay = new FakeRelay();
    const client = new RelayLeaseClient(relay);

    const promise = client.acquire('sess-1', 'node-a', 30_000);
    await flushMicrotasks();
    const sent = lastSent(relay);
    expect(sent).toMatchObject({
      type: 'lease_request',
      sessionId: 'sess-1',
      nodeId: 'node-a',
      action: 'acquire',
      ttlMs: 30_000,
    });
    const requestId = (sent as { requestId: string }).requestId;

    relay.deliver({
      type: 'lease_result',
      protocolVersion: 1,
      requestId,
      sessionId: 'sess-1',
      result: { outcome: 'granted', expiresAt: 12345 },
    });

    await expect(promise).resolves.toEqual({ granted: true, expiresAt: 12345 });
  });

  it('resolves denied with the current holder on a conflicting acquire', async () => {
    const relay = new FakeRelay();
    const client = new RelayLeaseClient(relay);

    const promise = client.acquire('sess-1', 'node-b');
    await flushMicrotasks();
    const requestId = (lastSent(relay) as { requestId: string }).requestId;

    relay.deliver({
      type: 'lease_result',
      protocolVersion: 1,
      requestId,
      sessionId: 'sess-1',
      result: { outcome: 'denied', heldBy: 'node-a', expiresAt: 99999 },
    });

    await expect(promise).resolves.toEqual({
      granted: false,
      heldBy: 'node-a',
      expiresAt: 99999,
    });
  });

  it('sends a renew as its own action, distinct from acquire', async () => {
    const relay = new FakeRelay();
    const client = new RelayLeaseClient(relay);

    void client.renew('sess-1', 'node-a', 5_000);
    await flushMicrotasks();
    expect(lastSent(relay)).toMatchObject({ type: 'lease_request', action: 'renew' });
  });

  it('ignores a lease_result for a different requestId', async () => {
    const relay = new FakeRelay();
    const client = new RelayLeaseClient(relay);

    const promise = client.acquire('sess-1', 'node-a');
    await flushMicrotasks();
    const requestId = (lastSent(relay) as { requestId: string }).requestId;

    relay.deliver({
      type: 'lease_result',
      protocolVersion: 1,
      requestId: 'some-other-request',
      sessionId: 'sess-1',
      result: { outcome: 'granted', expiresAt: 1 },
    });
    relay.deliver({
      type: 'lease_result',
      protocolVersion: 1,
      requestId,
      sessionId: 'sess-1',
      result: { outcome: 'granted', expiresAt: 2 },
    });

    await expect(promise).resolves.toEqual({ granted: true, expiresAt: 2 });
  });

  it('rejects after timeoutMs if no matching lease_result ever arrives', async () => {
    const relay = new FakeRelay();
    const client = new RelayLeaseClient(relay, { timeoutMs: 20 });

    await expect(client.acquire('sess-1', 'node-a')).rejects.toThrow(/timed out/);
  });

  it('release sends lease_release and resolves the released boolean from lease_release_result', async () => {
    const relay = new FakeRelay();
    const client = new RelayLeaseClient(relay);

    const promise = client.release('sess-1', 'node-a');
    await flushMicrotasks();
    const sent = lastSent(relay);
    expect(sent).toMatchObject({
      type: 'lease_release',
      sessionId: 'sess-1',
      nodeId: 'node-a',
    });
    const requestId = (sent as { requestId: string }).requestId;

    relay.deliver({
      type: 'lease_release_result',
      protocolVersion: 1,
      requestId,
      sessionId: 'sess-1',
      released: true,
    });

    await expect(promise).resolves.toBe(true);
  });

  it('release resolves false (not an error) when the relay reports nothing to release', async () => {
    const relay = new FakeRelay();
    const client = new RelayLeaseClient(relay);

    const promise = client.release('sess-1', 'node-ghost');
    await flushMicrotasks();
    const requestId = (lastSent(relay) as { requestId: string }).requestId;

    relay.deliver({
      type: 'lease_release_result',
      protocolVersion: 1,
      requestId,
      sessionId: 'sess-1',
      released: false,
    });

    await expect(promise).resolves.toBe(false);
  });

  it('releaseBestEffort sends lease_release synchronously, with no whenReady gate and no wait for a reply', () => {
    const relay = new FakeRelay();
    // A whenReady that never resolves — if releaseBestEffort respected it,
    // nothing would ever be sent.
    const client = new RelayLeaseClient(relay, { whenReady: () => new Promise(() => {}) });

    client.releaseBestEffort('sess-1', 'node-a');

    expect(relay.sent).toEqual([
      {
        type: 'lease_release',
        protocolVersion: 1,
        requestId: expect.any(String),
        sessionId: 'sess-1',
        nodeId: 'node-a',
      },
    ]);
  });

  it('awaits whenReady before sending, so a request made before the connection is open is never silently dropped', async () => {
    const relay = new FakeRelay();
    let releaseReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const client = new RelayLeaseClient(relay, { whenReady: () => readyPromise });

    const promise = client.acquire('sess-1', 'node-a');
    // Nothing sent yet: whenReady() hasn't resolved.
    expect(relay.sent).toHaveLength(0);

    releaseReady?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(relay.sent).toHaveLength(1);

    const requestId = (lastSent(relay) as { requestId: string }).requestId;
    relay.deliver({
      type: 'lease_result',
      protocolVersion: 1,
      requestId,
      sessionId: 'sess-1',
      result: { outcome: 'granted', expiresAt: 1 },
    });
    await expect(promise).resolves.toEqual({ granted: true, expiresAt: 1 });
  });
});
