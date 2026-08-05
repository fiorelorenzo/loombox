import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  HEARTBEAT_CAPABILITY,
  PROTOCOL_V1,
  initializeResult,
  safeParseWireMessageV1,
  type BuildIdentityV1,
  type Initialize,
  type Ping,
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
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface RelayConnectionOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** This node's stable device identity, sent in the `initialize` handshake. */
  deviceId: string;
  /**
   * This device's ECDH P-256 identity public key, base64-encoded raw form
   * (SPEC §8). See `NodeDaemonOptions.devicePublicKey`'s doc comment
   * (`node-daemon.ts`) for where this comes from (`./identity.ts`'s
   * `NodeIdentityStore`, issue #64).
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
  /**
   * How long to wait for `initialize_result` after a socket is created
   * before giving up on that attempt (default 15s). Covers both a TCP
   * connection that never completes and one that completes against a hung
   * relay process, or a proxy that accepted it and went nowhere — either
   * way `awaitingInitializeResult` would otherwise stay true forever and
   * this connection would sit open-but-useless with no reconnect (#511).
   */
  handshakeTimeoutMs?: number;
  /**
   * Interval between application-level `ping`s once a handshake completes
   * and the relay's `initialize_result.capabilities` includes
   * {@link HEARTBEAT_CAPABILITY} (default 30s, issue #511). A relay that
   * doesn't advertise it predates #511 and drops the frame silently, so no
   * ping is ever sent against one and the connection is never torn down
   * for silence.
   */
  heartbeatIntervalMs?: number;
  /**
   * This node's own build identity (issue #655): sent on every `initialize`
   * (and every reconnect's fresh one) so the relay can record and expose
   * "what version is this node running" — `main.ts` resolves this once at
   * startup via `build-identity.ts`'s `readNodeBuildIdentity()` and passes
   * the plain value here. Omitted (every existing test, and any node build
   * that predates #655) simply never sends the field — `initialize`'s
   * schema already tolerates that (additive, optional).
   */
  buildIdentity?: BuildIdentityV1;
}

/**
 * Owns one outbound WebSocket connection from this node to the v1 relay
 * (SPEC.md §5.1: "Connects outbound to the relay and registers as an E2E
 * device"; issue #65). Sends `initialize` (role `'node'`) as the first frame
 * on every (re)connect, awaits the relay's `initialize_result` before
 * considering the connection usable, and reconnects with capped exponential
 * backoff whenever the socket drops, without requiring a process restart.
 *
 * Three failure modes a plain "reconnect on close" misses, all closed by
 * issue #511 (a relay redeploy left a devbox node holding no socket for 4h
 * with zero retry attempts, because each of these hits before "close" ever
 * fires):
 * - `new WebSocketCtor(url)` throwing (DNS failure, a bad URL, TLS setup
 *   refusing while the relay's container is down) is caught and treated
 *   exactly like a socket that opened and then closed, so the retry chain
 *   never dies silently.
 * - A TCP connection that establishes but never gets `initialize_result`
 *   (a hung relay process, or a proxy that accepted it and went nowhere) is
 *   bounded by `handshakeTimeoutMs`.
 * - A half-open socket — what a killed relay container leaves behind, since
 *   no FIN ever arrives — is caught by the `heartbeatIntervalMs` ping/pong,
 *   once the relay advertises {@link HEARTBEAT_CAPABILITY}.
 *
 * Emits:
 * - `'open'` once a fresh socket has completed the `initialize` handshake
 *   (including on every reconnect) — the composing `NodeDaemon` uses this to
 *   re-announce its targets and sessions, which the relay drops from its
 *   registry the moment a node's socket closes.
 * - `'message'` with every valid inbound {@link WireMessageV1} (excluding the
 *   handshake's own `initialize_result` and heartbeat `pong`s, both consumed
 *   internally).
 * - `'close'` whenever the underlying socket closes (before a reconnect is scheduled).
 * - `'error'` when the relay rejects the handshake (e.g. `update_required` for
 *   a version mismatch, SPEC.md §10/#108), or when an attempt to open the
 *   socket itself fails (#511) — surfaced rather than failing silently.
 */
export class RelayConnection extends EventEmitter {
  private readonly options: RelayConnectionOptions;
  private readonly WebSocketCtor: WebSocketConstructor;
  private socket: WebSocketLike | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  /** Nonce of the most recently sent `ping` still awaiting its `pong`; `undefined` when none is outstanding. */
  private pendingPingNonce: string | undefined;
  private backoffMs: number;
  private userClosed = false;
  private awaitingInitializeResult = false;

  /** The protocol version the relay actually negotiated on the current/last connection, once known. */
  negotiatedVersion: number | undefined;
  /** The capability set the relay advertised in `initialize_result` on the current/last connection — the heartbeat gate (#511) reads this rather than assuming a relay answers `ping`. */
  negotiatedCapabilities: readonly string[] | undefined;

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
    this.clearHandshakeTimer();
    this.clearHeartbeatTimer();
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

  /**
   * Creates the socket and wires it up; never throws (#511). A constructor
   * failure (DNS, a bad URL, TLS setup refusing while the relay's container
   * is down) is indistinguishable from a socket that opened and immediately
   * died, so it gets the same treatment: surfaced as an `'error'` and
   * followed by a scheduled retry, rather than escaping the bare
   * `setTimeout` `scheduleReconnect` runs this in and killing the retry
   * chain for the life of the process.
   */
  private open(): void {
    try {
      this.attemptOpen();
    } catch (cause) {
      this.socket = undefined;
      this.emit('error', cause instanceof Error ? cause : new Error(String(cause)));
      this.scheduleReconnect();
    }
  }

  private attemptOpen(): void {
    const socket = new this.WebSocketCtor(this.options.relayUrl);
    this.socket = socket;
    this.awaitingInitializeResult = true;
    this.armHandshakeTimeout(socket);

    socket.addEventListener('open', () => {
      this.backoffMs = this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
      const initialize: Initialize = {
        type: 'initialize',
        protocolVersion: PROTOCOL_V1,
        role: 'node',
        authToken: this.options.authToken,
        deviceId: this.options.deviceId,
        devicePublicKey: this.options.devicePublicKey,
        ...(this.options.buildIdentity ? { buildIdentity: this.options.buildIdentity } : {}),
      };
      socket.send(JSON.stringify(initialize));
    });

    socket.addEventListener('message', (event: { data: unknown }) => {
      const parsed = this.parseRaw(event.data);
      if (parsed === undefined) return;

      if (this.awaitingInitializeResult) {
        this.awaitingInitializeResult = false;
        this.clearHandshakeTimer();
        const result = initializeResult.safeParse(parsed);
        if (result.success) {
          this.negotiatedVersion = result.data.negotiatedVersion;
          this.negotiatedCapabilities = result.data.capabilities;
          this.armHeartbeat(socket, result.data.capabilities);
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
      if (!message.success) return;
      if (message.data.type === 'pong') {
        // A heartbeat reply is transport bookkeeping (#511), not a domain
        // message — never forwarded to consumers. A stale/duplicate pong
        // (nonce mismatch) is simply ignored, never credited as proof the
        // *current* ping was answered.
        if (message.data.nonce === this.pendingPingNonce) this.pendingPingNonce = undefined;
        return;
      }
      this.emit('message', message.data);
    });

    // A socket is "gone" on whichever of these arrives, and only the first
    // one counts (#511).
    //
    // The comment that used to sit here claimed "'close' always follows
    // 'error' for the global WebSocket client", and reconnect scheduling
    // lived in the 'close' handler alone on the strength of it. That is true
    // of the browser's WebSocket and false of Node's (undici): a *failed
    // connection attempt* — precisely what every retry hits while the relay
    // is down — emits 'error' and no 'close' at all. Only a socket that
    // reached OPEN and then dropped emits 'close'. So the first retry after
    // a relay restart ended the retry chain for the life of the process,
    // which is the four-hour outage #511 was filed for. Reproduced directly:
    // relay killed -> 'close' -> retry scheduled -> retry refused ->
    // 'error', no 'close', nothing ever scheduled again.
    let gone = false;
    const onSocketGone = (): void => {
      if (gone) return;
      gone = true;
      this.clearHandshakeTimer();
      this.clearHeartbeatTimer();
      // Only disown the socket if it is still the current one: a late event
      // from a superseded attempt must never clear a newer live socket.
      if (this.socket === socket) this.socket = undefined;
      this.emit('close');
      this.scheduleReconnect();
    };

    socket.addEventListener('close', onSocketGone);
    socket.addEventListener('error', onSocketGone);
  }

  /**
   * Bounds how long a socket may sit `awaitingInitializeResult` (#511): a
   * TCP connection that never completes never fires `'open'` at all, and
   * one that completes against a hung relay process, or a proxy that
   * accepted it and went nowhere, fires `'open'` but then nothing. Either
   * way, closing the socket drives the existing `'close'` → reconnect path;
   * this closes over the specific `socket` this timer was armed for
   * (never `this.socket`) so it can only ever act on that one attempt.
   */
  private armHandshakeTimeout(socket: WebSocketLike): void {
    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined;
      socket.close();
    }, timeoutMs);
  }

  /**
   * Starts the ping/pong liveness check (#511) — only once the relay has
   * advertised {@link HEARTBEAT_CAPABILITY}: an older relay drops an
   * unknown `ping` frame silently instead of answering it, so arming this
   * unconditionally would tear down a perfectly healthy connection every
   * interval and never recover, strictly worse than the bug being fixed.
   * Each tick either finds the previous ping still unanswered — a half-open
   * socket looks identical to a healthy one otherwise, since a killed relay
   * container sends no FIN — and closes the socket, or sends the next ping.
   */
  private armHeartbeat(socket: WebSocketLike, capabilities: readonly string[]): void {
    if (!capabilities.includes(HEARTBEAT_CAPABILITY)) return;
    const intervalMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setInterval(() => {
      if (this.pendingPingNonce !== undefined) {
        this.clearHeartbeatTimer();
        socket.close();
        return;
      }
      const nonce = randomUUID();
      this.pendingPingNonce = nonce;
      const ping: Ping = { type: 'ping', protocolVersion: PROTOCOL_V1, nonce };
      socket.send(JSON.stringify(ping));
    }, intervalMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.pendingPingNonce = undefined;
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
