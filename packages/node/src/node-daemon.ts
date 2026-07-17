import { randomUUID, type webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';

import type { AcpTranscriptUpdate } from '@loombox/providers-core';
import { AgentSupervisor, type AgentSession } from '@loombox/supervisor';
import { deriveSessionKey, openJson, sealJson } from '@loombox/crypto';
import {
  PROTOCOL_V1,
  type PromptInjectV1,
  type SessionCreate,
  type SessionMetaPublic,
  type TargetDescriptor,
  type WireMessageV1,
} from '@loombox/protocol';

import { RelayConnection, type WebSocketConstructor } from './relay-connection';
import { SessionManager, type Session } from './session-manager';
import { DEFAULT_LOCAL_TARGET, type SshTargetConfig } from './target';
import { asAcpChildProcess, RemoteAgentChildProcess } from './ssh/remote-agent-child';
import { RemoteProcessRunner } from './ssh/remote-process-runner';
import { shQuote, type RemoteTransport } from './ssh/remote-transport';
import { SessionLeaseManager } from './ssh/session-lease';
import { Ssh2Transport } from './ssh/ssh2-transport';

type CryptoKey = webcrypto.CryptoKey;

export interface NodeDaemonOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** This node's stable identity. */
  nodeId: string;
  /** This device's stable id, sent in the `initialize` handshake (SPEC §8). */
  deviceId: string;
  /**
   * This device's ECDH P-256 identity public key, base64-encoded raw form.
   * Real per-node keypair generation/persistence is issue #64; a caller
   * supplies this directly until that lands.
   */
  devicePublicKey: string;
  /** Opaque Better Auth bearer token (SPEC §8). */
  authToken: string;
  /**
   * The account this node's sessions are scoped under (`SessionMetaPublic.accountId`,
   * the relay's routing/listing key). Must currently equal `authToken`: the
   * relay's auth stub (`deriveAccountIdStub`, `packages/relay/src/auth.ts`,
   * TODO #121) treats the raw bearer token as the account id verbatim. A real
   * Better Auth integration will let these diverge.
   */
  accountId: string;
  /**
   * This account's Account Master Key (SPEC §8, §16): every session key this
   * node derives (`@loombox/crypto`'s `deriveSessionKey`) comes from this one
   * 256-bit secret via its key tree. Real AMK distribution is the
   * device-pairing flow (#113/#114/#115, out of scope here); injected
   * directly until this node has its own pairing bootstrap.
   */
  amk: Uint8Array;
  /** Execution targets this node exposes (SPEC §5.2); defaults to just the `local` target. */
  targets?: TargetDescriptor[];
  /**
   * Connection recipes for this node's `ssh:` targets (issue #80), keyed by
   * matching `TargetDescriptor.id` in `targets`. A target announced with
   * `kind: 'ssh'` but no matching entry here fails session creation with a
   * clear error rather than silently falling back to anything.
   */
  sshTargets?: SshTargetConfig[];
  /** Builds the `RemoteTransport` for a given `ssh:` target; defaults to a real `Ssh2Transport`. Tests inject a `LocalProcessTransport`/`FakeTransport` factory instead. */
  sshTransportFactory?: (config: SshTargetConfig) => RemoteTransport;
  /**
   * Session ownership leasing across nodes (issue #82). Defaults to a fresh
   * in-memory manager, correct for a single-node deployment and for tests;
   * a multi-node deployment shares one `SessionLeaseManager` backed by a
   * distributed `LeaseStore` (e.g. relay-hosted) across every node instance.
   */
  leaseManager?: SessionLeaseManager;
  /** Poll interval (ms) for a `RemoteAgentChildProcess` bridge on an `ssh:` target session; defaults to 150ms. Tests lower this to speed up polling-based assertions. */
  remoteChildPollIntervalMs?: number;
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
  /** Which of this node's targets to run on (default: 'local'). */
  targetId?: string;
  /** Human-readable session title, travels only inside the encrypted private envelope (default: the project directory's basename). */
  title?: string;
}

/** The plaintext a session's private envelope (`session_create`/`session_announce`) decrypts to — SPEC §8's metadata boundary: title and project path never reach the relay in the clear. */
interface SessionPrivateMeta {
  title: string;
  projectPath: string;
}

/** The plaintext a `prompt_inject` envelope decrypts to. */
interface PromptPayload {
  text: string;
}

interface SessionBridge {
  session: Session;
  agentSession: AgentSession;
  targetId: string;
  title: string;
  /** Local monotonic counter for the `seq` field this node stamps on outgoing session updates; the relay reassigns the authoritative seq on receipt (`store.sessions.nextSeq`), so this only needs to satisfy the wire schema, not be globally authoritative. */
  seq: number;
  /**
   * Chains every `encryptAndSendUpdate` call for this session so concurrent
   * `crypto.subtle.encrypt` calls can never resolve — and so get sent to the
   * relay — out of the order their updates actually happened in.
   */
  sendQueue: Promise<void>;
  /**
   * Set only for an `ssh:` target's session (issue #80): the local bridge
   * object polling the remote run. `close()` must reach this directly
   * (rather than going through `AgentSupervisor.stop()`, which always kills)
   * so this node exiting stops *this local bridge* without terminating the
   * still-running remote agent process.
   */
  remoteChild?: RemoteAgentChildProcess;
}

/**
 * Ties `SessionManager` + `AgentSupervisor` + the v1 `RelayConnection`
 * together into one E2E-encrypted node (SPEC.md §5.1, §5.6, §8, §12 v1;
 * `docs/v1-plan.md`; issues #65, #66). Creating a session spawns a worktree
 * and an agent, announces it to the relay as clear `SessionMetaPublic`
 * routing metadata plus an encrypted `{title, projectPath}` envelope, and
 * every subsequent agent transcript update is sealed under that session's
 * derived key and pumped to the relay tagged with a monotonic `seq`. An
 * inbound `prompt_inject` for one of this node's sessions is decrypted and
 * delivered to that session's agent. The relay never sees plaintext: it only
 * ever forwards/stores `EncryptedEnvelope`s and the clear routing fields
 * `SessionMetaPublic` deliberately allows (id, nodeId, targetId, accountId,
 * provider, timestamps).
 *
 * Emits `'connected'` once the relay handshake completes and this node has
 * (re-)announced its targets and sessions (including on every reconnect) —
 * useful for a caller/test that needs to know the node is actually routable
 * before, say, asking it to create a session via a client-initiated
 * `session_create`.
 */
export class NodeDaemon extends EventEmitter {
  readonly nodeId: string;

  private readonly accountId: string;
  private readonly amk: Uint8Array;
  private readonly targets: TargetDescriptor[];
  private readonly sessionManager: SessionManager;
  private readonly supervisor: AgentSupervisor;
  private readonly relay: RelayConnection;
  private readonly bridges = new Map<string, SessionBridge>();
  private readonly sessionKeys = new Map<string, Promise<CryptoKey>>();

  private readonly sshTargetConfigs = new Map<string, SshTargetConfig>();
  private readonly sshTransportFactory: (config: SshTargetConfig) => RemoteTransport;
  private readonly leaseManager: SessionLeaseManager;
  private readonly remoteChildPollIntervalMs: number | undefined;
  /** One pooled `RemoteTransport` + `RemoteProcessRunner` per `ssh:` target id, reused across every session on that target rather than reconnecting per session (SPEC §5.2/§7.23's "pooled ... SSH transport"). */
  private readonly remoteConnections = new Map<
    string,
    { transport: RemoteTransport; runner: RemoteProcessRunner }
  >();

  constructor(options: NodeDaemonOptions) {
    super();
    this.nodeId = options.nodeId;
    this.accountId = options.accountId;
    this.amk = options.amk;
    this.targets = options.targets ?? [DEFAULT_LOCAL_TARGET];
    this.sessionManager = options.sessionManager ?? new SessionManager();
    this.supervisor = options.supervisor ?? new AgentSupervisor();
    for (const config of options.sshTargets ?? []) {
      this.sshTargetConfigs.set(config.id, config);
    }
    this.sshTransportFactory =
      options.sshTransportFactory ??
      ((config) =>
        new Ssh2Transport({
          host: config.host,
          port: config.port,
          username: config.user ?? 'root',
          privateKeyPath: config.privateKeyPath,
          passphrase: config.passphrase,
          password: config.password,
          agent: config.agent,
        }));
    this.leaseManager = options.leaseManager ?? new SessionLeaseManager();
    this.remoteChildPollIntervalMs = options.remoteChildPollIntervalMs;
    this.relay = new RelayConnection({
      relayUrl: options.relayUrl,
      deviceId: options.deviceId,
      devicePublicKey: options.devicePublicKey,
      authToken: options.authToken,
      webSocketImpl: options.webSocketImpl,
      initialBackoffMs: options.reconnect?.initialBackoffMs,
      maxBackoffMs: options.reconnect?.maxBackoffMs,
    });

    // The relay drops a node's targets/sessions from its registry the
    // moment that node's socket closes, so every fresh 'open' (including
    // reconnects) must re-announce everything this node still holds.
    this.relay.on('open', () => {
      this.reannounceAll();
      this.emit('connected');
    });
    this.relay.on('message', (message: WireMessageV1) => this.handleInbound(message));
    // A rejected handshake (#108's "update required") is surfaced as an
    // 'error' event by RelayConnection; EventEmitter throws on an
    // unhandled 'error' event, so this must always have a listener.
    this.relay.on('error', (error: Error) => {
      console.warn(`NodeDaemon(${this.nodeId}): relay connection error: ${error.message}`);
    });
  }

  /** Opens the outbound connection to the relay. */
  connect(): void {
    this.relay.connect();
  }

  /**
   * Closes the relay connection (no further reconnect attempts follow) and
   * stops every session's agent process — except an `ssh:` target session's
   * remote agent, which this node deliberately does *not* terminate: it
   * detaches this node's local bridge only, leaving the setsid/tmux-detached
   * remote process running (issue #80's "the driving node exiting entirely
   * does not kill the remote agent process").
   */
  close(): void {
    for (const [sessionId, bridge] of this.bridges) {
      bridge.remoteChild?.detachLocal();
      this.supervisor.stop(sessionId);
    }
    this.bridges.clear();
    for (const { transport } of this.remoteConnections.values()) {
      transport.close().catch(() => {});
    }
    this.remoteConnections.clear();
    this.relay.close();
  }

  /** Test-only: see {@link RelayConnection.simulateDrop}. */
  simulateRelayDrop(): void {
    this.relay.simulateDrop();
  }

  /**
   * Creates a session directly on this node (worktree via `SessionManager`,
   * agent via `AgentSupervisor`), wires the agent's transcript updates to
   * the relay, and announces it — the node-initiated path (as opposed to a
   * client's `session_create` routed in over the relay, handled by
   * {@link handleInbound}).
   */
  async createSession(options: CreateNodeSessionOptions): Promise<Session> {
    return this.createSessionInternal({
      projectPath: options.projectPath,
      provider: options.provider ?? 'claude',
      targetId: options.targetId ?? 'local',
      title: options.title ?? basename(options.projectPath),
    });
  }

  /** Submits a prompt directly into a session this node owns (bypassing the relay). */
  async promptSession(sessionId: string, text: string): Promise<void> {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) {
      throw new Error(`NodeDaemon: no session with id ${sessionId}`);
    }
    await this.assertStillLeaseholder(bridge);
    await bridge.agentSession.prompt(text);
  }

  /**
   * Enforces issue #82's "only the current leaseholder node may send
   * prompts/control to a session's supervisor" for an `ssh:` target session
   * (identified by `bridge.remoteChild` being set — a `local` session has no
   * cross-node contention to guard against, since no other node can reach
   * this machine's own child process). A no-op for a `local` bridge.
   */
  private async assertStillLeaseholder(bridge: SessionBridge): Promise<void> {
    if (!bridge.remoteChild) return;
    const stillHeld = await this.leaseManager.isLeaseholder(bridge.session.id, this.nodeId);
    if (!stillHeld) {
      throw new Error(
        `NodeDaemon: lost the ownership lease for session ${bridge.session.id}; refusing to drive it further (issue #82)`,
      );
    }
  }

  private async createSessionInternal(opts: {
    sessionId?: string;
    projectPath: string;
    provider: string;
    targetId: string;
    title: string;
  }): Promise<Session> {
    const target = this.targets.find((candidate) => candidate.id === opts.targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${opts.targetId}"`);
    }
    if (target.kind === 'ssh') {
      return this.createSshSessionInternal(target.id, opts);
    }

    const session = await this.sessionManager.createSession({
      id: opts.sessionId,
      projectPath: opts.projectPath,
      provider: opts.provider,
    });
    const agentSession = await this.supervisor.start({
      workspacePath: session.worktreePath,
      providerId: opts.provider,
    });

    return this.finishSessionCreation(session, agentSession, opts);
  }

  /**
   * The `ssh:` target path (issue #80): acquires this session's ownership
   * lease (#82), deploys-and-launches the provider's agent detached on the
   * remote host via the pooled `RemoteProcessRunner` for this target — with
   * a tmux/screen fallback when the native mechanism isn't available (#81)
   * — bridges it into an `AcpChildProcess` (`RemoteAgentChildProcess`), and
   * hands that to `AgentSupervisor.startWithChild()`. From here on this
   * session is driven through `AgentSession`/`AgentSupervisor` exactly like
   * a `local` one: {@link finishSessionCreation} is the same shared tail
   * both paths use to wire transcript forwarding and announce to the relay.
   */
  private async createSshSessionInternal(
    targetId: string,
    opts: { sessionId?: string; projectPath: string; provider: string; title: string },
  ): Promise<Session> {
    const sessionId = opts.sessionId ?? randomUUID();

    const lease = await this.leaseManager.acquire(sessionId, this.nodeId);
    if (!lease.granted) {
      throw new Error(
        `NodeDaemon: cannot create session ${sessionId} on ssh: target "${targetId}": ` +
          `lease already held by node "${lease.heldBy}" (expires ${new Date(lease.expiresAt).toISOString()})`,
      );
    }

    const provider = this.supervisor.getProvider(opts.provider);
    if (!provider) {
      throw new Error(`NodeDaemon: no provider registered for id "${opts.provider}"`);
    }

    const runner = await this.getRemoteRunner(targetId);
    const spawnConfig = provider.spawnConfig({ cwd: opts.projectPath });
    const command = [spawnConfig.command, ...(spawnConfig.args ?? [])].map(shQuote).join(' ');

    const { mode, usedFallback, handle } = await runner.launchWithFallback(sessionId, command);
    if (usedFallback) {
      console.warn(
        `NodeDaemon: ssh target "${targetId}" has no setsid+mkfifo available; session ${sessionId} launched under the ${mode} fallback (#81)`,
      );
    }

    const remoteChild = new RemoteAgentChildProcess(runner, handle, {
      pollIntervalMs: this.remoteChildPollIntervalMs,
    });
    remoteChild.start();

    const agentSession = await this.supervisor.startWithChild({
      workspacePath: opts.projectPath,
      providerId: opts.provider,
      child: asAcpChildProcess(remoteChild),
    });

    // No per-session remote git worktree in this wave (see target.ts's doc
    // comment): the session runs directly in `projectPath` on the remote
    // host, so `worktreePath` mirrors it and `branch` is genuinely N/A.
    const session: Session = {
      id: sessionId,
      projectPath: opts.projectPath,
      worktreePath: opts.projectPath,
      target: 'ssh',
      provider: opts.provider,
      branch: '',
      createdAt: Date.now(),
    };

    return this.finishSessionCreation(
      session,
      agentSession,
      { targetId, title: opts.title },
      remoteChild,
    );
  }

  /** Gets (or opens) the pooled `RemoteTransport`/`RemoteProcessRunner` for an `ssh:` target, reused across every session on it. */
  private async getRemoteRunner(targetId: string): Promise<RemoteProcessRunner> {
    const existing = this.remoteConnections.get(targetId);
    if (existing) return existing.runner;

    const config = this.sshTargetConfigs.get(targetId);
    if (!config) {
      throw new Error(
        `NodeDaemon: no ssh target config for target "${targetId}" (pass it via NodeDaemonOptions.sshTargets)`,
      );
    }
    const transport = this.sshTransportFactory(config);
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);
    this.remoteConnections.set(targetId, { transport, runner });
    return runner;
  }

  private async finishSessionCreation(
    session: Session,
    agentSession: AgentSession,
    opts: { targetId: string; title: string },
    remoteChild?: RemoteAgentChildProcess,
  ): Promise<Session> {
    const bridge: SessionBridge = {
      session,
      agentSession,
      targetId: opts.targetId,
      title: opts.title,
      seq: 0,
      sendQueue: Promise.resolve(),
      remoteChild,
    };
    this.bridges.set(session.id, bridge);
    this.wireAgentSession(bridge);
    await this.announce(bridge);

    return session;
  }

  private wireAgentSession(bridge: SessionBridge): void {
    bridge.agentSession.on('transcript_update', (update: AcpTranscriptUpdate) => {
      this.forwardUpdate(bridge.session.id, update);
    });
    // `AcpTranscriptUpdate` has no wire slot for turn-end/error/exit
    // notifications (v1's session_update envelope carries only the ACP
    // transcript-reducer's own update kinds — SPEC §7.24) — those stay
    // node-local observability for now, logged rather than silently dropped.
    bridge.agentSession.on('error', (error: Error) => {
      console.warn(`NodeDaemon: session ${bridge.session.id} agent error: ${error.message}`);
    });
    bridge.agentSession.on('exit', (code: number | null) => {
      console.warn(
        `NodeDaemon: session ${bridge.session.id} agent exited (code ${code ?? 'unknown'})`,
      );
    });
  }

  /** Encrypts and pumps one transcript update to the relay, preserving arrival order (see `SessionBridge.sendQueue`'s doc comment). */
  private forwardUpdate(sessionId: string, update: AcpTranscriptUpdate): void {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) return;

    bridge.sendQueue = bridge.sendQueue
      .then(() => this.encryptAndSendUpdate(bridge, update))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to encrypt/send session_update for ${sessionId}: ${message}`,
        );
      });
  }

  private async encryptAndSendUpdate(
    bridge: SessionBridge,
    update: AcpTranscriptUpdate,
  ): Promise<void> {
    const key = await this.getSessionKey(bridge.session.id);
    const envelope = await sealJson(bridge.session.id, update, key);
    bridge.seq += 1;
    this.relay.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: bridge.session.id,
      seq: bridge.seq,
      envelope,
    });
  }

  private async announce(bridge: SessionBridge): Promise<void> {
    const key = await this.getSessionKey(bridge.session.id);
    const privateMeta: SessionPrivateMeta = {
      title: bridge.title,
      projectPath: bridge.session.projectPath,
    };
    const privateEnvelope = await sealJson(bridge.session.id, privateMeta, key);
    const meta: SessionMetaPublic = {
      id: bridge.session.id,
      nodeId: this.nodeId,
      targetId: bridge.targetId,
      accountId: this.accountId,
      provider: bridge.session.provider,
      createdAt: bridge.session.createdAt,
    };
    this.relay.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: meta,
      privateEnvelope,
    });
  }

  private sendTargetAnnounce(): void {
    this.relay.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: this.nodeId,
      targets: this.targets,
    });
  }

  private reannounceAll(): void {
    this.sendTargetAnnounce();
    for (const bridge of this.bridges.values()) {
      this.announce(bridge).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`NodeDaemon: failed to re-announce session ${bridge.session.id}: ${message}`);
      });
    }
  }

  private handleInbound(message: WireMessageV1): void {
    switch (message.type) {
      case 'session_create':
        this.handleSessionCreate(message);
        return;
      case 'prompt_inject':
        this.handlePromptInject(message);
        return;
      default:
        // Every other v1 message type (permission_response, config_option,
        // presence, blob_*, ...) is out of this wave's scope; ignore rather
        // than crash on a message this node doesn't yet act on.
        return;
    }
  }

  /** A client asked (via the relay) for this node to start a new session on one of its targets. */
  private handleSessionCreate(message: SessionCreate): void {
    if (!this.targets.some((target) => target.id === message.targetId)) {
      console.warn(`NodeDaemon: session_create for unknown target "${message.targetId}"`);
      return;
    }

    this.decryptSessionCreate(message)
      .then((privateMeta) =>
        this.createSessionInternal({
          sessionId: message.sessionId,
          projectPath: privateMeta.projectPath,
          provider: message.provider,
          targetId: message.targetId,
          title: privateMeta.title,
        }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to create session ${message.sessionId} from session_create: ${detail}`,
        );
      });
  }

  private async decryptSessionCreate(message: SessionCreate): Promise<SessionPrivateMeta> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<SessionPrivateMeta>(message.sessionId, message.privateEnvelope, key);
  }

  /** A client injected a follow-up prompt (via the relay) into one of this node's sessions. */
  private handlePromptInject(message: PromptInjectV1): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.assertStillLeaseholder(bridge)
      .then(() => this.decryptPromptInject(message))
      .then((payload) => bridge.agentSession.prompt(payload.text))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle prompt_inject for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptPromptInject(message: PromptInjectV1): Promise<PromptPayload> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<PromptPayload>(message.sessionId, message.envelope, key);
  }

  private getSessionKey(sessionId: string): Promise<CryptoKey> {
    let key = this.sessionKeys.get(sessionId);
    if (!key) {
      key = deriveSessionKey(this.amk, this.accountId, sessionId);
      this.sessionKeys.set(sessionId, key);
    }
    return key;
  }
}

/** Convenience composition: builds a `NodeDaemon` and immediately connects it to the relay. */
export function createNode(options: NodeDaemonOptions): NodeDaemon {
  const node = new NodeDaemon(options);
  node.connect();
  return node;
}
