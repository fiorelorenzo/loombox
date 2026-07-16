import type { AcpTurnEnd, AcpUpdate } from '@loombox/providers-core';
import {
  PROTOCOL_VERSION,
  type SessionMeta,
  type SessionUpdate,
  type WireMessage,
} from '@loombox/protocol';
import { AgentSupervisor, type AgentSession } from '@loombox/supervisor';

import { RelayConnection, type WebSocketConstructor } from './relay-connection';
import { SessionManager, type Session } from './session-manager';

export interface NodeDaemonOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** This node's stable identity. */
  nodeId: string;
  nodeName?: string;
  /** Injected for tests; defaults to a fresh instance. */
  sessionManager?: SessionManager;
  /** Injected for tests (e.g. to register a fixture provider); defaults to a fresh instance. */
  supervisor?: AgentSupervisor;
  /** WebSocket constructor override for tests; defaults to the global WebSocket. */
  webSocketImpl?: WebSocketConstructor;
  reconnect?: { initialBackoffMs?: number; maxBackoffMs?: number };
}

export interface CreateNodeSessionOptions {
  /** Absolute path to a local git repository to run the session against. */
  projectPath: string;
  /** Provider id registered on this node's supervisor (default: 'claude'). */
  provider?: string;
}

interface SessionBridge {
  session: Session;
  agentSession: AgentSession;
}

/**
 * Ties `SessionManager` + `AgentSupervisor` + `RelayConnection` together into
 * one node (SPEC.md §5.1, §5.6, §12 v0): creating a session spawns a
 * worktree and an agent, announces it to the relay, and every subsequent
 * agent update is pumped to the relay tagged with that session's id; an
 * inbound `prompt_inject` for one of this node's sessions is delivered to
 * that session's agent.
 */
export class NodeDaemon {
  readonly nodeId: string;

  private readonly sessionManager: SessionManager;
  private readonly supervisor: AgentSupervisor;
  private readonly relay: RelayConnection;
  private readonly bridges = new Map<string, SessionBridge>();

  constructor(options: NodeDaemonOptions) {
    this.nodeId = options.nodeId;
    this.sessionManager = options.sessionManager ?? new SessionManager();
    this.supervisor = options.supervisor ?? new AgentSupervisor();
    this.relay = new RelayConnection({
      relayUrl: options.relayUrl,
      nodeId: options.nodeId,
      nodeName: options.nodeName,
      webSocketImpl: options.webSocketImpl,
      initialBackoffMs: options.reconnect?.initialBackoffMs,
      maxBackoffMs: options.reconnect?.maxBackoffMs,
    });

    // The relay drops a node's sessions from its registry the moment that
    // node's socket closes, so every fresh 'open' (including reconnects)
    // must re-announce everything this node still holds.
    this.relay.on('open', () => this.reannounceAll());
    this.relay.on('message', (message: WireMessage) => this.handleInbound(message));
  }

  /** Opens the outbound connection to the relay. */
  connect(): void {
    this.relay.connect();
  }

  /** Closes the relay connection; no further reconnect attempts follow. */
  close(): void {
    this.relay.close();
  }

  /** Test-only: see {@link RelayConnection.simulateDrop}. */
  simulateRelayDrop(): void {
    this.relay.simulateDrop();
  }

  /**
   * Creates a session (worktree via `SessionManager`), spawns its agent (via
   * `AgentSupervisor`), wires the agent's updates to the relay, and
   * announces it.
   */
  async createSession({
    projectPath,
    provider = 'claude',
  }: CreateNodeSessionOptions): Promise<Session> {
    const session = await this.sessionManager.createSession({ projectPath, provider });
    const agentSession = await this.supervisor.start({
      workspacePath: session.worktreePath,
      providerId: provider,
    });

    this.bridges.set(session.id, { session, agentSession });
    this.wireAgentSession(session.id, agentSession);
    this.announce(session);

    return session;
  }

  /** Submits a prompt directly into a session this node owns (bypassing the relay). */
  async promptSession(sessionId: string, text: string): Promise<void> {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) {
      throw new Error(`NodeDaemon: no session with id ${sessionId}`);
    }
    await bridge.agentSession.prompt(text);
  }

  private wireAgentSession(sessionId: string, agentSession: AgentSession): void {
    agentSession.on('update', (update: AcpUpdate) => {
      this.forwardUpdate(sessionId, {
        kind: update.kind,
        messageId: update.messageId,
        text: update.text,
      });
    });
    agentSession.on('turn_end', (turnEnd: AcpTurnEnd) => {
      this.forwardUpdate(sessionId, { kind: 'agent_turn_end', messageId: turnEnd.messageId ?? '' });
    });
    agentSession.on('error', (error: Error) => {
      this.forwardUpdate(sessionId, { kind: 'error', message: error.message });
    });
    agentSession.on('exit', (code: number | null) => {
      this.forwardUpdate(sessionId, {
        kind: 'error',
        message: `agent process exited (code ${code ?? 'unknown'})`,
      });
    });
  }

  private forwardUpdate(sessionId: string, update: SessionUpdate): void {
    this.relay.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      update,
    });
  }

  private announce(session: Session): void {
    const meta: SessionMeta = {
      id: session.id,
      nodeId: this.nodeId,
      projectPath: session.projectPath,
      worktreePath: session.worktreePath,
      target: session.target,
      provider: session.provider,
      createdAt: session.createdAt,
    };
    this.relay.send({ type: 'session_announce', protocolVersion: PROTOCOL_VERSION, session: meta });
  }

  private reannounceAll(): void {
    for (const { session } of this.bridges.values()) {
      this.announce(session);
    }
  }

  private handleInbound(message: WireMessage): void {
    if (message.type !== 'prompt_inject') return;

    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12 v0

    bridge.agentSession.prompt(message.text).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      this.forwardUpdate(message.sessionId, { kind: 'error', message: text });
    });
  }
}

/** Convenience composition: builds a `NodeDaemon` and immediately connects it to the relay. */
export function createNode(options: NodeDaemonOptions): NodeDaemon {
  const node = new NodeDaemon(options);
  node.connect();
  return node;
}
