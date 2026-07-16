import { writable, type Readable, type Writable } from 'svelte/store';
import {
  PROTOCOL_VERSION,
  safeParseWireMessage,
  type SessionMeta,
  type SessionUpdate,
  type WireMessage,
} from '@loombox/protocol';

/**
 * The subset of the WHATWG `WebSocket` interface this module relies on, kept
 * narrow so tests can inject a fake implementation. Both the browser's global
 * `WebSocket` and Node 22's global `WebSocket` (used by the hermetic tests
 * below) satisfy this — no new dependency (mirrors
 * packages/node/src/relay-connection.ts's approach on the node side).
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

/** Connection lifecycle exposed to the UI. v0 does not auto-reconnect (that's v1; see the class docstring). */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/**
 * One append-only entry in a session's transcript. v0 renders a **plain
 * log** only: text chunks accumulated by `messageId`, plus a `done` flag set
 * by `agent_turn_end`. Tool-call widgets, thinking blocks, and diffs are
 * explicitly v1 (SPEC §7.24, §16).
 */
export interface TranscriptEntry {
  /** The ACP `messageId` this entry accumulates chunks for. */
  id: string;
  role: 'user' | 'agent' | 'error';
  text: string;
  /** Set once an `agent_turn_end` for this `messageId` has been observed. */
  done: boolean;
}

export interface RelayClientOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** This client's identity, sent as `client_hello`'s `clientId`; generated if omitted. */
  clientId?: string;
  /** WebSocket constructor override; defaults to the global `WebSocket`. Tests inject a fake. */
  webSocketImpl?: WebSocketConstructor;
}

function generateId(prefix: string): string {
  const hasRandomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const unique = hasRandomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}_${unique}`;
}

/**
 * Applies one `SessionUpdate` to a transcript array and returns the new
 * array (pure, so it's trivial to unit test on its own). This is the
 * append-by-`messageId` reducer SPEC §5.5/§16 describes, restricted to the
 * plain-log subset v0 needs: `agent_message_chunk`/`user_message_chunk`
 * append text onto the entry with that `messageId` (creating it on first
 * sight), `agent_turn_end` marks it done, `error` appends a standalone entry.
 */
export function reduceTranscript(
  entries: readonly TranscriptEntry[],
  update: SessionUpdate,
): TranscriptEntry[] {
  switch (update.kind) {
    case 'agent_message_chunk':
    case 'user_message_chunk': {
      const role = update.kind === 'agent_message_chunk' ? 'agent' : 'user';
      const index = entries.findIndex((entry) => entry.id === update.messageId);
      if (index === -1) {
        return [...entries, { id: update.messageId, role, text: update.text, done: false }];
      }
      const existing = entries[index]!;
      const next = [...entries];
      next[index] = { ...existing, text: existing.text + update.text };
      return next;
    }
    case 'agent_turn_end': {
      const index = entries.findIndex((entry) => entry.id === update.messageId);
      if (index === -1) return [...entries];
      const existing = entries[index]!;
      const next = [...entries];
      next[index] = { ...existing, done: true };
      return next;
    }
    case 'error':
      return [
        ...entries,
        { id: generateId('err'), role: 'error', text: update.message, done: true },
      ];
    default:
      return [...entries];
  }
}

/**
 * Owns one outbound WebSocket connection from the PWA to the relay (SPEC
 * §5.4 "list sessions ... view live output", §7.3 "send follow-up
 * prompts"): sends `client_hello`, keeps a reactive session list fed by the
 * relay's `session_list` snapshot plus subsequent `session_announce`es, and
 * reduces each session's `session_update` stream into a plain append-only
 * transcript (v0 scope; SPEC §16 defers tool-call widgets/thinking/diffs to
 * v1). `sendPrompt` forwards a `prompt_inject` for the composer (§7.3) and,
 * since the relay never echoes it back, optimistically appends the user's
 * own turn locally so it shows immediately.
 *
 * v0 is deliberately minimal: **online only** (no reconnect-with-backoff,
 * no offline composer outbox — both v1) and **one in-flight prompt per
 * session** (`busyFor` flips true on send, false on that session's next
 * `agent_turn_end`/`error`), per the v0 acceptance in SPEC §12.
 *
 * All state is exposed as plain `svelte/store` readables (the `subscribe`
 * contract), which has no DOM dependency, so this whole module is unit
 * tested here against a real in-process `@loombox/relay` with no browser and
 * no jsdom. The full browser/phone confirmation is issue #54 (human-gated),
 * see scripts/v0-e2e-harness.mjs for the equivalent headless proof on the
 * node side.
 */
export class RelayClient {
  readonly clientId: string;
  readonly status: Readable<ConnectionStatus>;
  readonly sessions: Readable<SessionMeta[]>;

  private readonly options: RelayClientOptions;
  private readonly WebSocketCtor: WebSocketConstructor;
  private readonly statusStore: Writable<ConnectionStatus>;
  private readonly sessionsStore: Writable<SessionMeta[]>;
  private readonly transcripts = new Map<string, Writable<TranscriptEntry[]>>();
  private readonly busy = new Map<string, Writable<boolean>>();
  private socket: WebSocketLike | undefined;

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.clientId = options.clientId ?? generateId('client');

    const ctor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
    if (!ctor) {
      throw new Error('RelayClient: no global WebSocket available; pass webSocketImpl explicitly');
    }
    this.WebSocketCtor = ctor;

    this.statusStore = writable<ConnectionStatus>('idle');
    this.sessionsStore = writable<SessionMeta[]>([]);
    this.status = this.statusStore;
    this.sessions = this.sessionsStore;
  }

  /** Opens the connection (no-op if already connecting/open) and sends `client_hello` once open. */
  connect(): void {
    if (this.socket) return;
    this.statusStore.set('connecting');

    const socket = new this.WebSocketCtor(this.options.relayUrl);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.send({
        type: 'client_hello',
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.clientId,
      });
      this.statusStore.set('open');
    });

    socket.addEventListener('message', (event: { data: unknown }) => {
      const message = this.parseInbound(event.data);
      if (message) this.handleInbound(message);
    });

    socket.addEventListener('close', () => {
      this.socket = undefined;
      this.statusStore.set('closed');
    });

    // 'close' always follows 'error' for the WHATWG WebSocket, so status is
    // set there too; this listener just keeps an error from going unhandled
    // and surfaces the 'error' status a beat sooner for the UI.
    socket.addEventListener('error', () => {
      this.statusStore.set('error');
    });
  }

  /** Deliberately closes the connection. v0 does not auto-reconnect (v1). */
  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /** The append-only transcript store for one session; created empty on first access. */
  transcriptFor(sessionId: string): Readable<TranscriptEntry[]> {
    return this.transcriptStoreFor(sessionId);
  }

  /** Whether a prompt is currently in flight for one session (v0: at most one at a time). */
  busyFor(sessionId: string): Readable<boolean> {
    return this.busyStoreFor(sessionId);
  }

  /**
   * Sends a follow-up prompt for `sessionId` (SPEC §7.3, the composer).
   * Marks the session busy until its next `agent_turn_end`/`error` update,
   * and optimistically appends the user's own turn to the transcript first
   * (the relay/node never echo `prompt_inject` back as a `user_message_chunk`,
   * so without this the user's own message would never appear). Returns the
   * generated `promptId`.
   */
  sendPrompt(sessionId: string, text: string): string {
    const promptId = generateId('prompt');
    this.applyUpdate(sessionId, { kind: 'user_message_chunk', messageId: promptId, text });
    this.busyStoreFor(sessionId).set(true);
    this.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      promptId,
      text,
    });
    return promptId;
  }

  private transcriptStoreFor(sessionId: string): Writable<TranscriptEntry[]> {
    let store = this.transcripts.get(sessionId);
    if (!store) {
      store = writable<TranscriptEntry[]>([]);
      this.transcripts.set(sessionId, store);
    }
    return store;
  }

  private busyStoreFor(sessionId: string): Writable<boolean> {
    let store = this.busy.get(sessionId);
    if (!store) {
      store = writable(false);
      this.busy.set(sessionId, store);
    }
    return store;
  }

  private applyUpdate(sessionId: string, update: SessionUpdate): void {
    const store = this.transcriptStoreFor(sessionId);
    store.update((entries) => reduceTranscript(entries, update));

    if (update.kind === 'agent_turn_end' || update.kind === 'error') {
      this.busyStoreFor(sessionId).set(false);
    }
  }

  private handleInbound(message: WireMessage): void {
    switch (message.type) {
      case 'session_list':
        this.sessionsStore.set(message.sessions);
        return;
      case 'session_announce':
        this.sessionsStore.update((sessions) => {
          const index = sessions.findIndex((session) => session.id === message.session.id);
          if (index === -1) return [...sessions, message.session];
          const next = [...sessions];
          next[index] = message.session;
          return next;
        });
        return;
      case 'session_update':
        this.applyUpdate(message.sessionId, message.update);
        return;
      default:
        return;
    }
  }

  private send(message: WireMessage): void {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(message));
    }
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
