import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { AcpInitializeResult, AcpSpawnConfig, AcpUpdate, AcpUpdateKind } from './types';

/** A spawned ACP agent's stdio, or a caller-supplied config to spawn one (issue #48). */
export type AcpChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

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

interface SessionUpdateParams {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    messageId?: string;
    content?: { type?: string; text?: string };
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface SessionState {
  /** keyed by `${kind}:${messageId}` so a provider reusing an id across kinds can't collide (SPEC.md §7.24). */
  buffers: Map<string, string>;
  lastAgentMessageId: string | undefined;
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

/**
 * The generic ACP core client (SPEC.md §5.5, §10, §16; issue #48): performs the
 * ACP `initialize` handshake, opens a session via `session/new`, sends prompts
 * via `session/prompt`, and reduces incoming `session/update` notifications
 * for the v0 subset (`agent_message_chunk` / `user_message_chunk` only).
 *
 * Transport is JSON-RPC 2.0 over the child process's stdio as
 * newline-delimited JSON, per the real ACP baseline.
 *
 * Explicitly out of scope for v0 (do not extend here without re-reading
 * SPEC.md §5.5/§7.24 first): tool_call/tool_call_update, plan_update,
 * usage_update, session/request_permission, and the full transcript reducer.
 */
export class AcpClient extends EventEmitter {
  private readonly child: AcpChildProcess;
  private readonly rl: Interface;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, SessionState>();

  constructor(childOrConfig: AcpChildProcess | AcpSpawnConfig) {
    super();

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
  }

  /** ACP `initialize`: protocol version + capability negotiation (SPEC.md §5.5). */
  async initialize(): Promise<AcpInitializeResult> {
    return this.sendRequest<AcpInitializeResult>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'loombox', version: '0.0.0' },
    });
  }

  /** ACP `session/new`: opens a session rooted at `cwd`, returns its sessionId. */
  async newSession(cwd: string): Promise<string> {
    const result = await this.sendRequest<{ sessionId: string }>('session/new', {
      cwd,
      mcpServers: [],
    });
    this.sessions.set(result.sessionId, { buffers: new Map(), lastAgentMessageId: undefined });
    return result.sessionId;
  }

  /**
   * ACP `session/prompt`: sends a plain-text user turn and awaits its
   * response. Emits `'turn_end'` once the response (the turn's `StopReason`)
   * arrives, carrying the id of the last `agent_message_chunk` message seen
   * during this turn, if any.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    const result = await this.sendRequest<{ stopReason?: string }>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    const session = this.sessions.get(sessionId);
    this.emit('turn_end', {
      messageId: session?.lastAgentMessageId,
      stopReason: result.stopReason,
    });
  }

  /** Terminates the underlying agent process and stops reading its output. */
  close(): void {
    this.rl.close();
    this.child.kill();
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const request: JsonRpcRequestOut = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
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
    // An agent -> client request (e.g. session/request_permission, fs/*) is
    // out of scope for the v0 core client (SPEC.md §12); ignore rather than
    // hang the agent waiting for a response we won't send.
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

  private handleNotification(msg: JsonRpcNotificationIn): void {
    if (msg.method !== 'session/update') return;

    const params = msg.params as SessionUpdateParams | undefined;
    const update = params?.update;
    const kind = update?.sessionUpdate;
    if (kind !== 'agent_message_chunk' && kind !== 'user_message_chunk') return; // v0 subset only

    const sessionId = params?.sessionId;
    const messageId = update?.messageId;
    if (!sessionId || !messageId) return;

    const text = update?.content?.type === 'text' ? (update.content.text ?? '') : '';

    const session = this.sessions.get(sessionId) ?? {
      buffers: new Map(),
      lastAgentMessageId: undefined,
    };
    this.sessions.set(sessionId, session);

    const bufferKey = `${kind}:${messageId}`;
    const appended = (session.buffers.get(bufferKey) ?? '') + text;
    session.buffers.set(bufferKey, appended);
    if (kind === 'agent_message_chunk') session.lastAgentMessageId = messageId;

    const outUpdate: AcpUpdate = { kind: kind as AcpUpdateKind, messageId, text: appended };
    this.emit('update', outUpdate);
  }
}
