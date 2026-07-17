import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { deriveFeatureFlags } from './capabilities';
import type { AcpFeatureFlags } from './capabilities';
import { ConfigOptionStore } from './config-options';
import { PermissionQueue } from './permission-queue';
import type { PermissionResolveResult } from './permission-queue';
import type { ProviderRegistry } from './provider-registry';
import { createTranscriptState, reduceTranscript } from './transcript';
import type { TranscriptState } from './transcript';
import type {
  AcpAgentCapabilities,
  AcpConfigOption,
  AcpDiff,
  AcpInitializeResult,
  AcpPermissionOptionKind,
  AcpPlanEntry,
  AcpSessionSummary,
  AcpSpawnConfig,
  AcpToolCallStatus,
  AcpToolKind,
  AcpTranscriptUpdate,
  AcpUpdate,
  AcpUpdateKind,
} from './types';

/** A spawned ACP agent's stdio, or a caller-supplied config to spawn one (issue #48). */
export type AcpChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** Constructor options wiring a provider module's `enrich()` hook into the v1 update pipeline (issue #181). Optional and additive: omitting it keeps every update a pure pass-through. */
export interface AcpClientOptions {
  registry?: ProviderRegistry;
  providerId?: string;
}

interface JsonRpcRequestOut {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotificationIn {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcRequestIn {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

type JsonRpcInbound = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotificationIn | JsonRpcRequestIn;

/**
 * The wire shape of a `session/update` notification's `update` object,
 * widened (additive to v0's narrower inline type) to cover every
 * `sessionUpdate` kind the v1 transcript reducer and config-option store
 * understand: message/thought chunks, `tool_call`/`tool_call_update`,
 * `plan_update`, `usage_update`, and `config_option_update`.
 */
interface RawSessionUpdate {
  sessionUpdate?: string;
  messageId?: string;
  content?: unknown;
  id?: string;
  title?: string;
  toolKind?: AcpToolKind;
  status?: AcpToolCallStatus;
  diff?: AcpDiff;
  rawInput?: unknown;
  parentToolCallId?: string;
  locations?: unknown;
  entries?: AcpPlanEntry[];
  tokensUsed?: number;
  contextWindow?: number;
  costUsd?: number;
  options?: AcpConfigOption[];
}

interface SessionUpdateParams {
  sessionId?: string;
  update?: RawSessionUpdate;
}

interface RequestPermissionParamsWire {
  sessionId?: string;
  toolCall?: RawSessionUpdate & { id?: string };
  options?: { optionId: string; name: string; kind: AcpPermissionOptionKind }[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface SessionState {
  /** keyed by `${kind}:${messageId}` so a provider reusing an id across kinds can't collide (SPEC.md §7.24). */
  buffers: Map<string, string>;
  lastAgentMessageId: string | undefined;
  /** v1: the running transcript reducer state for this session (SPEC.md §7.24), additive to the v0 fields above. */
  transcriptState: TranscriptState;
  /** v1: every enriched `AcpTranscriptUpdate` this client has seen for this session, in arrival order — what `replay()`/`getHistory()` serve a re-attaching consumer (issue #176). */
  history: AcpTranscriptUpdate[];
  /** v1: client-assigned turn id for whatever turn is currently active (a real prompt, or a resume's replay batch); ACP itself carries no turn id on the wire (SPEC.md §7.24). */
  currentTurnId: string;
  turnCounter: number;
}

/** The ACP protocol version this client negotiates (ACP v1 baseline, SPEC.md §16). */
const PROTOCOL_VERSION = 1;

function isSpawnConfig(value: AcpChildProcess | AcpSpawnConfig): value is AcpSpawnConfig {
  return typeof (value as AcpSpawnConfig).command === 'string';
}

function isSuccessOrFailure(msg: JsonRpcInbound): msg is JsonRpcSuccess | JsonRpcFailure {
  return 'id' in msg && msg.id !== undefined && ('result' in msg || 'error' in msg);
}

function isNotification(msg: JsonRpcInbound): msg is JsonRpcNotificationIn {
  return 'method' in msg && !('id' in msg);
}

/** An agent -> client request (e.g. `session/request_permission`, `fs/*`): has both `method` and `id`, but no `result`/`error` (that's what distinguishes it from a response to our own outbound requests). */
function isIncomingRequest(msg: JsonRpcInbound): msg is JsonRpcRequestIn {
  return 'method' in msg && 'id' in msg && msg.id !== undefined;
}

/** Maps one wire `session/update` payload into the v1 transcript reducer's input shape; `undefined` for a kind this reducer doesn't cover (e.g. `config_option_update`, handled separately) or a malformed payload. */
function mapToTranscriptUpdate(
  kind: string,
  sessionId: string,
  update: RawSessionUpdate,
  turnId: string,
): AcpTranscriptUpdate | undefined {
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (!update.messageId) return undefined;
      const content = update.content as { type?: string; text?: string } | undefined;
      const text = content?.type === 'text' ? (content.text ?? '') : '';
      return { kind, turnId, messageId: update.messageId, text };
    }
    case 'tool_call':
    case 'tool_call_update': {
      if (!update.id) return undefined;
      return {
        kind,
        id: update.id,
        turnId,
        title: update.title,
        toolKind: update.toolKind,
        status: update.status,
        diff: update.diff,
        rawInput: update.rawInput,
        content: update.content,
        parentToolCallId: update.parentToolCallId,
        locations: update.locations,
      };
    }
    case 'plan_update':
      return { kind: 'plan_update', entries: update.entries ?? [] };
    case 'usage_update':
      return {
        kind: 'usage_update',
        sessionId,
        tokensUsed: update.tokensUsed,
        contextWindow: update.contextWindow,
        costUsd: update.costUsd,
      };
    default:
      return undefined;
  }
}

/**
 * The generic ACP core client (SPEC.md §5.5, §10, §16). Performs the ACP
 * `initialize` handshake, opens/resumes/lists sessions, sends prompts, and
 * reduces incoming `session/update` notifications along two parallel paths:
 * the v0 subset (`agent_message_chunk`/`user_message_chunk` only, emitted as
 * the legacy `'update'` event every existing consumer — `@loombox/node`,
 * `@loombox/supervisor`, `apps/web` — already depends on, kept byte-for-byte
 * unchanged) and the fuller v1 surface (`'transcript_update'`, the
 * `session/request_permission` FIFO queue, config-option state, capability
 * flags), additive to it.
 *
 * Transport is JSON-RPC 2.0 over the child process's stdio as
 * newline-delimited JSON, per the real ACP baseline.
 */
export class AcpClient extends EventEmitter {
  private readonly child: AcpChildProcess;
  private readonly rl: Interface;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, SessionState>();

  private readonly registry: ProviderRegistry | undefined;
  private readonly providerId: string | undefined;

  private readonly permissionQueue = new PermissionQueue();
  private readonly pendingPermissionRpcIds = new Map<string, number>();
  private readonly configOptionStore = new ConfigOptionStore();

  private lastAgentCapabilities: AcpAgentCapabilities | undefined;
  private lastConfigCatalog: AcpConfigOption[] = [];

  constructor(childOrConfig: AcpChildProcess | AcpSpawnConfig, options: AcpClientOptions = {}) {
    super();
    this.registry = options.registry;
    this.providerId = options.providerId;

    this.child = isSpawnConfig(childOrConfig)
      ? (spawn(childOrConfig.command, childOrConfig.args, {
          cwd: childOrConfig.cwd,
          env: childOrConfig.env ? { ...process.env, ...childOrConfig.env } : process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as AcpChildProcess)
      : childOrConfig;

    this.child.on('error', (err: Error) => this.emit('error', err));
    this.child.on('exit', (code: number | null) => this.emit('exit', code));

    this.rl = createInterface({ input: this.child.stdout, terminal: false });
    this.rl.on('line', (line: string) => this.handleLine(line));

    // A resolution on the permission queue (from any subscriber, including
    // a session-level Stop's optimistic cancelAll) is what actually replies
    // to the agent's still-pending `session/request_permission` call.
    this.permissionQueue.on('resolved', (result: PermissionResolveResult) => {
      if (result.status !== 'resolved') return;
      const rpcId = this.pendingPermissionRpcIds.get(result.requestId);
      if (rpcId === undefined) return;
      this.pendingPermissionRpcIds.delete(result.requestId);
      this.sendResponse(rpcId, { outcome: result.outcome });
    });
    this.permissionQueue.on('enqueued', (request: unknown) =>
      this.emit('permission_request', request),
    );
  }

  /** ACP `initialize`: protocol version + capability negotiation (SPEC.md §5.5). Caches `agentCapabilities`/`configOptions` for `getFeatureFlags()` and each new/resumed session's config-option seed. */
  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.sendRequest<AcpInitializeResult>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'loombox', version: '0.0.0' },
    });
    this.lastAgentCapabilities = result.agentCapabilities;
    this.lastConfigCatalog = result.configOptions ?? [];
    return result;
  }

  /** ACP `session/new`: opens a session rooted at `cwd`, returns its sessionId. */
  async newSession(cwd: string): Promise<string> {
    const result = await this.sendRequest<{ sessionId: string }>('session/new', {
      cwd,
      mcpServers: [],
    });
    this.ensureSession(result.sessionId);
    this.configOptionStore.setAll(result.sessionId, this.lastConfigCatalog, { unprompted: false });
    return result.sessionId;
  }

  /**
   * ACP `session/resume`: reopens a previously-created session. The agent is
   * expected to stream that session's history back as ordinary
   * `session/update` notifications (the same wire mechanism a live turn
   * uses) before or while responding — so it runs through the exact same
   * reducer path as a live stream (SPEC.md §7.24: "The same reducer runs
   * identically for a live stream and for replayed history on reconnect").
   * Also (re-)seeds this session's config-option state from the cached
   * `initialize` catalog, just like `newSession` does.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<string> {
    const session = this.ensureSession(sessionId);
    session.currentTurnId = `resume:${++session.turnCounter}`;
    this.configOptionStore.setAll(sessionId, this.lastConfigCatalog, { unprompted: false });

    const result = await this.sendRequest<{ sessionId?: string }>('session/resume', {
      sessionId,
      cwd,
    });
    return result.sessionId ?? sessionId;
  }

  /** ACP `session/list`: every session this agent process still holds. */
  async listSessions(): Promise<AcpSessionSummary[]> {
    const result = await this.sendRequest<{ sessions?: AcpSessionSummary[] }>('session/list', {});
    return result.sessions ?? [];
  }

  /**
   * ACP `session/cancel`: a fire-and-forget notification (no response is
   * expected). Per SPEC.md §7.24's "Multi-request ordering", also
   * optimistically resolves every open `session/request_permission` for
   * this session as cancelled immediately, rather than waiting for the
   * agent's own follow-up.
   */
  cancel(sessionId: string): void {
    this.permissionQueue.cancelAll(sessionId);
    const notification = { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } };
    this.child.stdin.write(`${JSON.stringify(notification)}\n`);
  }

  /**
   * ACP `session/prompt`: sends a plain-text user turn and awaits its
   * response. Emits `'turn_end'` once the response (the turn's `StopReason`)
   * arrives, carrying the id of the last `agent_message_chunk` message seen
   * during this turn, if any.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    const session = this.ensureSession(sessionId);
    session.currentTurnId = `turn:${++session.turnCounter}`;

    const result = await this.sendRequest<{ stopReason?: string }>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    this.emit('turn_end', {
      messageId: session.lastAgentMessageId,
      stopReason: result.stopReason,
    });
  }

  /** Maps this client's negotiated `initialize` capabilities onto the flat UI feature-flag surface (SPEC.md §5.5; issue #180). */
  getFeatureFlags(): AcpFeatureFlags {
    return deriveFeatureFlags(this.lastAgentCapabilities);
  }

  /** The `session/request_permission` FIFO queue state machine for every session this client has seen (SPEC.md §7.24; issue #178). */
  get permissions(): PermissionQueue {
    return this.permissionQueue;
  }

  /** Per-session config-option state (`model`/`mode`/`thought_level`/...; SPEC.md §7.24; issue #179). */
  get configOptions(): ConfigOptionStore {
    return this.configOptionStore;
  }

  /**
   * Sends a user-driven config-option change (`session/set_config_option`)
   * and applies the agent's full, wholesale-replaced option list to
   * `configOptions` once it acks — never a per-category patch.
   */
  async setConfigOption(
    sessionId: string,
    category: string,
    choiceId: string,
  ): Promise<AcpConfigOption[]> {
    const result = await this.sendRequest<{ options?: AcpConfigOption[] }>(
      'session/set_config_option',
      { sessionId, category, choiceId },
    );
    this.configOptionStore.setAll(sessionId, result.options ?? [], { unprompted: false });
    return this.configOptionStore.get(sessionId);
  }

  /** This session's current v1 transcript state (SPEC.md §7.24's reducer output); `createTranscriptState()`'s empty shape if the session is unknown. */
  getTranscriptState(sessionId: string): TranscriptState {
    return this.sessions.get(sessionId)?.transcriptState ?? createTranscriptState();
  }

  /** Every enriched `AcpTranscriptUpdate` seen for a session so far, oldest first. */
  getHistory(sessionId: string): AcpTranscriptUpdate[] {
    return [...(this.sessions.get(sessionId)?.history ?? [])];
  }

  /**
   * Re-emits this session's buffered `AcpTranscriptUpdate` history as
   * `'transcript_update'` events, in original order, without re-reducing or
   * re-storing anything — so a consumer that attaches its listener late
   * (e.g. a UI component mounting after the session already has history)
   * can call this once to catch up (SPEC.md §5.5's "session/resume +
   * replay"; issue #176).
   */
  replay(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const update of session.history) {
      this.emit('transcript_update', { sessionId, update, state: session.transcriptState });
    }
  }

  /** Terminates the underlying agent process and stops reading its output. */
  close(): void {
    this.rl.close();
    this.child.kill();
  }

  private ensureSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        buffers: new Map(),
        lastAgentMessageId: undefined,
        transcriptState: createTranscriptState(),
        history: [],
        currentTurnId: 'turn:0',
        turnCounter: 0,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const request: JsonRpcRequestOut = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private sendResponse(id: number, result: unknown): void {
    const response: JsonRpcSuccess = { jsonrpc: '2.0', id, result };
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcInbound;
    try {
      msg = JSON.parse(trimmed) as JsonRpcInbound;
    } catch (err) {
      this.emit('error', new Error(`AcpClient: failed to parse line as JSON: ${String(err)}`));
      return;
    }

    if (isSuccessOrFailure(msg)) {
      this.handleResponse(msg);
      return;
    }
    if (isNotification(msg)) {
      this.handleNotification(msg);
      return;
    }
    if (isIncomingRequest(msg)) {
      this.handleIncomingRequest(msg);
      return;
    }
  }

  private handleResponse(msg: JsonRpcSuccess | JsonRpcFailure): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if ('error' in msg) {
      pending.reject(new Error(`AcpClient: ${msg.error.message} (code ${msg.error.code})`));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * An agent -> client request. `session/request_permission` (SPEC.md
   * §7.24, §5.5; issue #178) is the only one this v1 client answers: it
   * enqueues onto the FIFO permission queue and replies once a subscriber
   * resolves it (see the `permissionQueue.on('resolved', ...)` wiring in
   * the constructor). Anything else (e.g. `fs/*`) stays out of scope and is
   * ignored, same as v0 — never respond incorrectly to a method this client
   * doesn't actually implement.
   */
  private handleIncomingRequest(msg: JsonRpcRequestIn): void {
    if (msg.method !== 'session/request_permission') return;

    const params = msg.params as RequestPermissionParamsWire | undefined;
    if (!params?.sessionId || !params.toolCall?.id) return;

    const requestId = `perm:${msg.id}`;
    this.pendingPermissionRpcIds.set(requestId, msg.id);
    this.permissionQueue.enqueue({
      requestId,
      sessionId: params.sessionId,
      toolCall: {
        kind: 'tool_call',
        id: params.toolCall.id,
        title: params.toolCall.title,
        toolKind: params.toolCall.toolKind,
        status: params.toolCall.status,
        diff: params.toolCall.diff,
        rawInput: params.toolCall.rawInput,
        content: params.toolCall.content,
        parentToolCallId: params.toolCall.parentToolCallId,
        locations: params.toolCall.locations,
      },
      options: params.options ?? [],
    });
  }

  private handleNotification(msg: JsonRpcNotificationIn): void {
    if (msg.method !== 'session/update') return;

    const params = msg.params as SessionUpdateParams | undefined;
    const update = params?.update;
    const kind = update?.sessionUpdate;
    const sessionId = params?.sessionId;
    if (!kind || !sessionId || !update) return;

    // config_option_update is agent-pushed, unprompted config state (SPEC.md
    // §7.24; issue #179) — it never touches the transcript reducer.
    if (kind === 'config_option_update') {
      this.configOptionStore.setAll(sessionId, update.options ?? [], { unprompted: true });
      return;
    }

    const session = this.ensureSession(sessionId);

    // v0 subset, unchanged: agent_message_chunk / user_message_chunk append
    // into `session.buffers` and emit the legacy 'update' event every
    // existing consumer already depends on.
    if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
      const messageId = update.messageId;
      if (messageId) {
        const content = update.content as { type?: string; text?: string } | undefined;
        const text = content?.type === 'text' ? (content.text ?? '') : '';
        const bufferKey = `${kind}:${messageId}`;
        const appended = (session.buffers.get(bufferKey) ?? '') + text;
        session.buffers.set(bufferKey, appended);
        if (kind === 'agent_message_chunk') session.lastAgentMessageId = messageId;

        const outUpdate: AcpUpdate = { kind: kind as AcpUpdateKind, messageId, text: appended };
        this.emit('update', outUpdate);
      }
    }

    // v1: fold every reducer-understood kind into this session's running
    // TranscriptState, additive to the v0 path above (SPEC.md §7.24).
    const transcriptUpdate = mapToTranscriptUpdate(kind, sessionId, update, session.currentTurnId);
    if (!transcriptUpdate) return;

    const enriched =
      this.registry && this.providerId
        ? this.registry.enrich(this.providerId, transcriptUpdate, update)
        : transcriptUpdate;

    session.history.push(enriched);
    session.transcriptState = reduceTranscript(session.transcriptState, enriched);
    this.emit('transcript_update', { sessionId, update: enriched, state: session.transcriptState });
  }
}
