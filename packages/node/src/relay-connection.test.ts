import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_CAPABILITY, PROTOCOL_V1, type WireMessageV1 } from '@loombox/protocol';

import {
  RelayConnection,
  type RelayConnectionOptions,
  type WebSocketConstructor,
  type WebSocketLike,
} from './relay-connection';

const BASE_OPTIONS = {
  relayUrl: 'ws://relay.test/ws',
  deviceId: 'device-1',
  devicePublicKey: 'cGlkLXB1YmxpYy1rZXk',
  authToken: 'token-1',
};

type PingMessage = Extract<WireMessageV1, { type: 'ping' }>;

type WsListener = (...args: never[]) => void;

/**
 * A fully synthetic `WebSocketLike` — no real network I/O — giving each test
 * exact control over when `open`/`message`/`close` fire, which is what
 * `WebSocketLike`'s own doc comment (`relay-connection.ts`) says the narrow
 * interface is for. `close()` defers its `'close'` event by a macrotask,
 * mirroring the real WebSocket/`ws` client (never synchronous), so a test
 * that drops a socket must flush a fake-timer tick to observe it.
 */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: WireMessageV1[] = [];
  private readonly listeners: Record<'open' | 'message' | 'close' | 'error', WsListener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  private closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    this.listeners[type].push(listener as WsListener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WireMessageV1);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    // Deferred, never synchronous — matches the real WebSocket/`ws` client,
    // which never fires 'close' inline from a `.close()` call. A microtask
    // (not a fake/real timer) keeps this deterministic under
    // `vi.useFakeTimers()`: `await vi.advanceTimersByTimeAsync(...)` always
    // drains pending microtasks as part of advancing.
    queueMicrotask(() => {
      for (const listener of this.listeners.close) listener();
    });
  }

  /** Test driver: the relay accepted the TCP/TLS connection. */
  triggerOpen(): void {
    this.readyState = 1;
    for (const listener of this.listeners.open) listener();
  }

  /** Test driver: a frame arrived from the relay. */
  triggerMessage(message: unknown): void {
    const event = { data: JSON.stringify(message) };
    for (const listener of this.listeners.message) (listener as (e: typeof event) => void)(event);
  }

  /**
   * Test driver: the connection attempt failed outright — Node's global
   * (undici) WebSocket fires `'error'` and NEVER `'close'` for this, unlike
   * the browser's. See the `onSocketGone` comment in `relay-connection.ts`:
   * this asymmetry is what left the node with a dead retry chain in #511,
   * and it is invisible to any test that only ever drives `close()`.
   */
  triggerErrorWithoutClose(): void {
    this.readyState = 3;
    this.closed = true;
    for (const listener of this.listeners.error) listener();
  }
}

/**
 * A `WebSocketConstructor` that throws for the first `failFirst` construction
 * attempts (issue #511's DNS/bad-URL/TLS-refusal case) before succeeding,
 * and records every socket it does manage to create.
 */
function fakeWebSocketCtor(failFirst = 0): { ctor: WebSocketConstructor; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  let attempts = 0;
  class TrackedSocket extends FakeSocket {
    constructor(url: string) {
      attempts += 1;
      if (attempts <= failFirst) {
        throw new Error(`fakeWebSocketCtor: simulated connect failure (attempt ${attempts})`);
      }
      super(url);
      sockets.push(this);
    }
  }
  return { ctor: TrackedSocket, sockets };
}

/** Drives a `FakeSocket` through the full `initialize` -> `initialize_result` handshake `RelayConnection` expects. */
function completeHandshake(socket: FakeSocket, capabilities: string[] = []): void {
  socket.triggerOpen();
  socket.triggerMessage({
    type: 'initialize_result',
    protocolVersion: PROTOCOL_V1,
    negotiatedVersion: PROTOCOL_V1,
    capabilities,
  });
}

/**
 * Wires a fresh `RelayConnection` against a fresh fake-socket factory, with
 * `'open'`/`'close'` counted and `'error'`/`'message'` captured. Every test
 * needs the `'error'` listener regardless of whether it expects one: Node's
 * `EventEmitter` throws synchronously on an unhandled `'error'` emit.
 */
function harness(
  options: Partial<RelayConnectionOptions> = {},
  failFirst = 0,
): {
  relay: RelayConnection;
  sockets: FakeSocket[];
  errors: Error[];
  messages: WireMessageV1[];
  counts: { opens: number; closes: number };
} {
  const { ctor, sockets } = fakeWebSocketCtor(failFirst);
  const relay = new RelayConnection({ ...BASE_OPTIONS, ...options, webSocketImpl: ctor });
  const errors: Error[] = [];
  const messages: WireMessageV1[] = [];
  const counts = { opens: 0, closes: 0 };
  relay.on('error', (error: Error) => errors.push(error));
  relay.on('message', (message: WireMessageV1) => messages.push(message));
  relay.on('open', () => {
    counts.opens += 1;
  });
  relay.on('close', () => {
    counts.closes += 1;
  });
  return { relay, sockets, errors, messages, counts };
}

describe('RelayConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handshake', () => {
    it('sends initialize on open and emits open with the negotiated version and capabilities once initialize_result arrives', () => {
      const h = harness();
      h.relay.connect();
      const socket = h.sockets[0];
      socket.triggerOpen();

      expect(socket.sent).toEqual([
        {
          type: 'initialize',
          protocolVersion: PROTOCOL_V1,
          role: 'node',
          authToken: BASE_OPTIONS.authToken,
          deviceId: BASE_OPTIONS.deviceId,
          devicePublicKey: BASE_OPTIONS.devicePublicKey,
        },
      ]);

      socket.triggerMessage({
        type: 'initialize_result',
        protocolVersion: PROTOCOL_V1,
        negotiatedVersion: PROTOCOL_V1,
        capabilities: [HEARTBEAT_CAPABILITY],
      });

      expect(h.counts.opens).toBe(1);
      expect(h.errors).toEqual([]);
      expect(h.relay.negotiatedVersion).toBe(PROTOCOL_V1);
      expect(h.relay.negotiatedCapabilities).toEqual([HEARTBEAT_CAPABILITY]);

      h.relay.close();
    });

    it('includes buildIdentity in initialize when configured (issue #655), and omits it when not (back-compat default)', () => {
      const buildIdentity = { version: '0.5.1', commit: 'node-sha' };
      const h = harness({ buildIdentity });
      h.relay.connect();
      h.sockets[0].triggerOpen();

      expect(h.sockets[0].sent).toEqual([
        {
          type: 'initialize',
          protocolVersion: PROTOCOL_V1,
          role: 'node',
          authToken: BASE_OPTIONS.authToken,
          deviceId: BASE_OPTIONS.deviceId,
          devicePublicKey: BASE_OPTIONS.devicePublicKey,
          buildIdentity,
        },
      ]);

      h.relay.close();
    });

    it('emits error instead of open when the relay rejects the handshake, and still reconnects once the relay closes the socket (#108)', async () => {
      const h = harness({ initialBackoffMs: 50 });
      h.relay.connect();
      h.sockets[0].triggerOpen();
      h.sockets[0].triggerMessage({ type: 'update_required', protocolVersion: PROTOCOL_V1 });

      expect(h.counts.opens).toBe(0);
      expect(h.errors).toHaveLength(1);

      h.sockets[0].close();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.counts.closes).toBe(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(h.sockets).toHaveLength(2);

      h.relay.close();
    });
  });

  describe('reconnecting after a plain drop', () => {
    it('reconnects with capped exponential backoff, doubling until the cap and resetting once reconnected', async () => {
      const h = harness({ initialBackoffMs: 100, maxBackoffMs: 300 });
      h.relay.connect();
      completeHandshake(h.sockets[0]);

      h.relay.simulateDrop();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.counts.closes).toBe(1);
      expect(h.sockets).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(h.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(2); // first retry at the 100ms initial backoff

      h.relay.simulateDrop();
      await vi.advanceTimersByTimeAsync(199);
      expect(h.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(3); // second retry at 200ms (100 doubled)

      completeHandshake(h.sockets[2]);
      expect(h.counts.opens).toBe(2);

      h.relay.close();
    });

    it('stops retrying once close() is called', async () => {
      const h = harness({ initialBackoffMs: 50 });
      h.relay.connect();
      completeHandshake(h.sockets[0]);

      h.relay.close();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(h.sockets).toHaveLength(1);
    });
  });

  describe('a WebSocket constructor that fails (#511)', () => {
    it('recovers when it throws for the first few attempts, surfacing each as an error event rather than escaping', async () => {
      const h = harness({ initialBackoffMs: 100, maxBackoffMs: 1000 }, 2);

      expect(() => h.relay.connect()).not.toThrow();
      expect(h.errors).toHaveLength(1);
      expect(h.sockets).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(100); // first retry also throws
      expect(h.errors).toHaveLength(2);
      expect(h.sockets).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(200); // second retry (backoff doubled) succeeds
      expect(h.sockets).toHaveLength(1);

      completeHandshake(h.sockets[0]);
      expect(h.counts.opens).toBe(1);
      expect(h.counts.closes).toBe(0);

      h.relay.close();
    });

    it('never throws synchronously out of connect(), even when the very first attempt fails', () => {
      const h = harness({}, 1);
      expect(() => h.relay.connect()).not.toThrow();
      expect(h.errors).toHaveLength(1);
      h.relay.close();
    });

    it('reconnects when a failed attempt reports only error and never close (the #511 outage)', async () => {
      const h = harness({ initialBackoffMs: 100, maxBackoffMs: 400 });
      h.relay.connect();
      completeHandshake(h.sockets[0]);
      expect(h.counts.opens).toBe(1);

      // The relay goes away: an established socket does report 'close'.
      h.relay.simulateDrop();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.sockets).toHaveLength(2);

      // The relay is still down, so the retry is refused outright — the case
      // that reports 'error' alone. Before the fix, the chain ended here.
      h.sockets[1].triggerErrorWithoutClose();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.sockets).toHaveLength(3);

      h.sockets[2].triggerErrorWithoutClose();
      await vi.advanceTimersByTimeAsync(400);
      expect(h.sockets).toHaveLength(4);

      // And it recovers for real once the relay is back.
      completeHandshake(h.sockets[3]);
      expect(h.counts.opens).toBe(2);

      h.relay.close();
    });

    it('counts an error and a close on the same socket as one disconnect, never two retries', async () => {
      const h = harness({ initialBackoffMs: 100, maxBackoffMs: 400 });
      h.relay.connect();
      completeHandshake(h.sockets[0]);

      // The browser's WebSocket fires both for one failure; scheduling off
      // each independently would double the retry rate and desync backoff.
      h.sockets[0].triggerErrorWithoutClose();
      h.sockets[0].close();
      await vi.advanceTimersByTimeAsync(100);

      expect(h.counts.closes).toBe(1);
      expect(h.sockets).toHaveLength(2);

      h.relay.close();
    });
  });

  describe('handshake timeout (#511)', () => {
    it('closes and reconnects when the socket never reaches open at all', async () => {
      const h = harness({ handshakeTimeoutMs: 5000, initialBackoffMs: 100 });
      h.relay.connect();
      expect(h.sockets).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(h.counts.closes).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0); // flush the fake socket's deferred close event
      expect(h.counts.closes).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(h.sockets).toHaveLength(2);

      h.relay.close();
    });

    it('closes and reconnects when the relay accepts the socket but never answers initialize', async () => {
      const h = harness({ handshakeTimeoutMs: 5000, initialBackoffMs: 100 });
      h.relay.connect();
      h.sockets[0].triggerOpen();
      expect(h.sockets[0].sent).toHaveLength(1); // `initialize` went out; nothing ever answers it

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.counts.closes).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(h.sockets).toHaveLength(2);

      h.relay.close();
    });

    it('does not fire once initialize_result arrives before the deadline', async () => {
      const h = harness({ handshakeTimeoutMs: 5000 });
      h.relay.connect();
      completeHandshake(h.sockets[0]);

      await vi.advanceTimersByTimeAsync(10_000); // well past what the timeout would have been
      expect(h.counts.closes).toBe(0);
      expect(h.sockets).toHaveLength(1);

      h.relay.close();
    });
  });

  describe('heartbeat (#511)', () => {
    it('never sends a ping and is never torn down for silence when the relay does not advertise heartbeat', async () => {
      const h = harness({ heartbeatIntervalMs: 1000 });
      h.relay.connect();
      completeHandshake(h.sockets[0], []);
      expect(vi.getTimerCount()).toBe(0); // no heartbeat interval was ever armed

      await vi.advanceTimersByTimeAsync(1000 * 50);

      expect(h.sockets[0].sent.some((m) => m.type === 'ping')).toBe(false);
      expect(h.counts.closes).toBe(0);
      expect(h.sockets).toHaveLength(1);

      h.relay.close();
    });

    it('sends a ping after the interval, and a matching pong keeps the connection open across several intervals', async () => {
      const h = harness({ heartbeatIntervalMs: 1000 });
      h.relay.connect();
      completeHandshake(h.sockets[0], [HEARTBEAT_CAPABILITY]);
      const socket = h.sockets[0];

      for (let tick = 1; tick <= 5; tick++) {
        await vi.advanceTimersByTimeAsync(1000);
        const pings = socket.sent.filter((m): m is PingMessage => m.type === 'ping');
        expect(pings).toHaveLength(tick);
        socket.triggerMessage({
          type: 'pong',
          protocolVersion: PROTOCOL_V1,
          nonce: pings[pings.length - 1].nonce,
        });
      }

      expect(h.counts.closes).toBe(0);
      expect(h.sockets).toHaveLength(1);
      expect(h.messages.some((m) => m.type === 'pong')).toBe(false); // consumed internally

      h.relay.close();
    });

    it('tears down and reconnects when a relay advertising heartbeat stops answering pings', async () => {
      const h = harness({ heartbeatIntervalMs: 1000, initialBackoffMs: 200 });
      h.relay.connect();
      completeHandshake(h.sockets[0], [HEARTBEAT_CAPABILITY]);

      await vi.advanceTimersByTimeAsync(1000); // first ping goes out, never answered
      expect(h.sockets[0].sent.filter((m) => m.type === 'ping')).toHaveLength(1);
      expect(h.counts.closes).toBe(0);

      await vi.advanceTimersByTimeAsync(1000); // next tick: still no pong -> dead socket
      await vi.advanceTimersByTimeAsync(0);
      expect(h.counts.closes).toBe(1);
      expect(h.sockets).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(h.sockets).toHaveLength(2);

      h.relay.close();
    });
  });

  describe('close() clears every timer (#511)', () => {
    it('clears a pending reconnect backoff timer', async () => {
      const h = harness({ initialBackoffMs: 5000 });
      h.relay.connect();
      completeHandshake(h.sockets[0]);
      h.relay.simulateDrop();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      h.relay.close();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.sockets).toHaveLength(1);
    });

    it('clears a pending handshake timeout timer', () => {
      const h = harness({ handshakeTimeoutMs: 5000 });
      h.relay.connect();
      expect(vi.getTimerCount()).toBe(1);

      h.relay.close();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the heartbeat interval timer', () => {
      const h = harness({ heartbeatIntervalMs: 1000 });
      h.relay.connect();
      completeHandshake(h.sockets[0], [HEARTBEAT_CAPABILITY]);
      expect(vi.getTimerCount()).toBe(1);

      h.relay.close();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the reconnect backoff timer left by a failing constructor', () => {
      const h = harness({ initialBackoffMs: 5000 }, 1);
      h.relay.connect();
      expect(vi.getTimerCount()).toBe(1);

      h.relay.close();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
