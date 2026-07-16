import { EventEmitter } from 'node:events';

import { PROTOCOL_VERSION, safeParseWireMessage, type WireMessage } from '@loombox/protocol';

/**
 * The subset of the WHATWG `WebSocket` interface this module relies on, kept
 * narrow so tests can inject a fake implementation. Node 22 ships a global
 * `WebSocket` client that satisfies this (SPEC.md §5.1) — no new dependency.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;

const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 10_000;

export interface RelayConnectionOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** This node's stable identity, sent as the first frame's `nodeId`. */
  nodeId: string;
  nodeName?: string;
  /** Delay before the first reconnect attempt (default 250ms). */
  initialBackoffMs?: number;
  /** Cap on the reconnect delay after repeated failures (default 10s). */
  maxBackoffMs?: number;
  /** WebSocket constructor to use; defaults to the global `WebSocket` (Node 22+). Tests inject a fake. */
  webSocketImpl?: WebSocketConstructor;
}

/**
 * Owns one outbound WebSocket connection from this node to the relay
 * (SPEC.md §5.1: "Connects outbound to the relay and registers as an E2E
 * device"). Sends `node_hello` as the first frame on every (re)connect, and
 * reconnects with capped exponential backoff whenever the socket drops,
 * without requiring a process restart.
 *
 * Emits:
 * - `'open'` once a fresh socket has sent its `node_hello` (including on
 *   every reconnect) — the composing daemon uses this to re-announce any
 *   sessions the relay would otherwise have dropped (relay behavior: a
 *   node's sessions are removed from the registry when its socket closes).
 * - `'message'` with every valid inbound {@link WireMessage}.
 * - `'close'` whenever the underlying socket closes (before a reconnect is scheduled).
 */
export class RelayConnection extends EventEmitter {
  private readonly options: RelayConnectionOptions;
  private readonly WebSocketCtor: WebSocketConstructor;
  private socket: WebSocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs: number;
  private userClosed = false;

  constructor(options: RelayConnectionOptions) {
    super();
    this.options = options;
    this.backoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;

    const ctor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
    if (!ctor) {
      throw new Error(
        'RelayConnection: no global WebSocket available; pass webSocketImpl explicitly (needs Node 22+)',
      );
    }
    this.WebSocketCtor = ctor;
  }

  /** Opens the connection (idempotent while already connecting/open). */
  connect(): void {
    this.userClosed = false;
    if (this.socket) return;
    this.open();
  }

  /** Sends a wire message if the socket is currently open; silently drops it otherwise. */
  send(message: WireMessage): void {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /** Deliberately closes the connection; no further reconnect attempts follow. */
  close(): void {
    this.userClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Test-only: forcibly drops the current socket without marking this
   * connection user-closed, so the normal reconnect-with-backoff path runs
   * exactly as it would for a real network drop. Production code never calls
   * this.
   */
  simulateDrop(): void {
    this.socket?.close();
  }

  private open(): void {
    const socket = new this.WebSocketCtor(this.options.relayUrl);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.backoffMs = this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
      this.send({
        type: 'node_hello',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.options.nodeId,
        nodeName: this.options.nodeName,
      });
      this.emit('open');
    });

    socket.addEventListener('message', (event: { data: unknown }) => {
      const message = this.parseInbound(event.data);
      if (message) this.emit('message', message);
    });

    socket.addEventListener('close', () => {
      this.socket = undefined;
      this.emit('close');
      this.scheduleReconnect();
    });

    // The 'close' event always follows 'error' for the global WebSocket
    // client, so reconnect scheduling lives in the 'close' handler only;
    // this listener exists purely so an error never becomes an unhandled
    // event.
    socket.addEventListener('error', () => {});
  }

  private scheduleReconnect(): void {
    if (this.userClosed) return;

    const delay = this.backoffMs;
    this.backoffMs = Math.min(
      this.backoffMs * 2,
      this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.userClosed) this.open();
    }, delay);
  }

  private parseInbound(data: unknown): WireMessage | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return undefined;
    }
    const result = safeParseWireMessage(parsed);
    return result.success ? result.data : undefined;
  }
}
