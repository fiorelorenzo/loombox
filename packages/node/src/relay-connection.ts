import { EventEmitter } from 'node:events';

import {
  PROTOCOL_V1,
  initializeResult,
  safeParseWireMessageV1,
  type Initialize,
  type WireMessageV1,
} from '@loombox/protocol';

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
  /** This node's stable device identity, sent in the `initialize` handshake. */
  deviceId: string;
  /**
   * This device's ECDH P-256 identity public key, base64-encoded raw form
   * (SPEC §8). Real per-node keypair generation/persistence is issue #64;
   * `NodeDaemon`'s caller supplies this directly until that lands.
   */
  devicePublicKey: string;
  /** Opaque Better Auth bearer token (SPEC §8); the relay validates only its shape today (TODO #121). */
  authToken: string;
  /** Delay before the first reconnect attempt (default 250ms). */
  initialBackoffMs?: number;
  /** Cap on the reconnect delay after repeated failures (default 10s). */
  maxBackoffMs?: number;
  /** WebSocket constructor to use; defaults to the global `WebSocket` (Node 22+). Tests inject a fake. */
  webSocketImpl?: WebSocketConstructor;
}

/**
 * Owns one outbound WebSocket connection from this node to the v1 relay
 * (SPEC.md §5.1: "Connects outbound to the relay and registers as an E2E
 * device"; issue #65). Sends `initialize` (role `'node'`) as the first frame
 * on every (re)connect, awaits the relay's `initialize_result` before
 * considering the connection usable, and reconnects with capped exponential
 * backoff whenever the socket drops, without requiring a process restart.
 *
 * Emits:
 * - `'open'` once a fresh socket has completed the `initialize` handshake
 *   (including on every reconnect) — the composing `NodeDaemon` uses this to
 *   re-announce its targets and sessions, which the relay drops from its
 *   registry the moment a node's socket closes.
 * - `'message'` with every valid inbound {@link WireMessageV1} (excluding the
 *   handshake's own `initialize_result`, consumed internally).
 * - `'close'` whenever the underlying socket closes (before a reconnect is scheduled).
 * - `'error'` when the relay rejects the handshake (e.g. `update_required` for
 *   a version mismatch, SPEC.md §10/#108) — surfaced rather than failing silently.
 */
export class RelayConnection extends EventEmitter {
  private readonly options: RelayConnectionOptions;
  private readonly WebSocketCtor: WebSocketConstructor;
  private socket: WebSocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs: number;
  private userClosed = false;
  private awaitingInitializeResult = false;

  /** The protocol version the relay actually negotiated on the current/last connection, once known. */
  negotiatedVersion: number | undefined;

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

  /** Sends a v1 wire message if the socket is currently open; silently drops it otherwise. */
  send(message: WireMessageV1): void {
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
    this.awaitingInitializeResult = true;

    socket.addEventListener('open', () => {
      this.backoffMs = this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
      const initialize: Initialize = {
        type: 'initialize',
        protocolVersion: PROTOCOL_V1,
        role: 'node',
        authToken: this.options.authToken,
        deviceId: this.options.deviceId,
        devicePublicKey: this.options.devicePublicKey,
      };
      socket.send(JSON.stringify(initialize));
    });

    socket.addEventListener('message', (event: { data: unknown }) => {
      const parsed = this.parseRaw(event.data);
      if (parsed === undefined) return;

      if (this.awaitingInitializeResult) {
        this.awaitingInitializeResult = false;
        const result = initializeResult.safeParse(parsed);
        if (result.success) {
          this.negotiatedVersion = result.data.negotiatedVersion;
          this.emit('open');
        } else {
          // The relay rejects an incompatible/invalid handshake with an
          // `update_required` notice (or an unparseable frame) then closes
          // the socket (#108) — surface it rather than hanging silently.
          // The 'close' handler below still runs and schedules a reconnect.
          this.emit(
            'error',
            new Error(`RelayConnection: handshake rejected by relay: ${JSON.stringify(parsed)}`),
          );
        }
        return;
      }

      const message = safeParseWireMessageV1(parsed);
      if (message.success) this.emit('message', message.data);
    });

    socket.addEventListener('close', () => {
      this.socket = undefined;
      this.emit('close');
      this.scheduleReconnect();
    });

    // The 'close' event always follows 'error' for the global WebSocket
    // client, so reconnect scheduling lives in the 'close' handler only;
    // this listener exists purely so a transport-level error never becomes
    // an unhandled event.
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

  private parseRaw(data: unknown): unknown {
    try {
      return JSON.parse(String(data));
    } catch {
      return undefined;
    }
  }
}
