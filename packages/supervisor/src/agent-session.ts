import { EventEmitter } from 'node:events';

import { AcpClient } from '@loombox/providers-core';
import type {
  AcpChildProcess,
  AcpMcpServerConfig,
  AcpProvider,
  AcpSpawnConfig,
  AcpTranscriptUpdate,
  AcpTurnEnd,
  AcpUpdate,
  ConfigOptionStore,
  PendingPermissionRequest,
  PermissionQueue,
  PermissionResolveResult,
} from '@loombox/providers-core';

import type {
  AttentionState,
  AttentionStatus,
  SessionMetaFile,
  TranscriptStore,
} from './transcript-store';

/** Constructor options threading a `TranscriptStore` through `AgentSession.spawn()` (issue #77); optional so a caller that doesn't care about persistence still works exactly like v0. */
export interface AgentSessionSpawnOptions {
  store?: TranscriptStore;
  /**
   * This session's effective, already-secret-resolved MCP server set (SPEC.md
   * §7.7; issues #187/#189), passed through verbatim to `AcpClient.newSession`'s
   * own `mcpServers` option. The caller (`@loombox/node`'s `NodeDaemon`) is
   * responsible for having already run `resolveEffectiveMcpServers` +
   * `resolveMcpServerConfigs` over its MCP config + secret-grant stores
   * before reaching here — this class and `AcpClient` both just pass the
   * resolved list along; neither knows anything about config storage or
   * grants. Defaults to `undefined`, matching `AcpClient.newSession`'s own
   * "no servers configured" default.
   */
  mcpServers?: AcpMcpServerConfig[];
}

/**
 * One running (or, after a supervisor restart, previously-run) agent, spawned
 * and owned by the `AgentSupervisor` (SPEC.md §5.6): a live `AcpClient` over
 * the child process's stdio, an in-memory transcript cache of every update
 * seen so far, and — new in v1 — the same transcript+attention state mirrored
 * to disk via `TranscriptStore` (issue #77) so it survives this process
 * exiting (issue #78) and is inspectable even with nobody currently
 * listening (issue #79).
 *
 * Two ways an `AgentSession` comes to exist, with different guarantees:
 *
 * - `AgentSession.spawn(...)` — the live path (v0, unchanged in spirit):
 *   spawns the child and owns it for as long as this process runs.
 *   `isLive` is `true`. A caller "detaches" by removing its own listeners
 *   (`session.off(...)`), which does nothing to the underlying child or
 *   session, and a re-attaching caller adds new listeners and reads
 *   `getTranscript()`/`getTranscriptUpdates()`/`getAttentionState()` to catch
 *   up on everything it missed — the child keeps running throughout, and
 *   `prompt()` continues the same real conversation.
 * - `AgentSession.fromPersisted(...)` — the reload-after-restart path (v1,
 *   issue #78): reconstructs a *replay-only* session from what
 *   `TranscriptStore` has on disk, with no child process behind it.
 *   `isLive` is `false`; `getTranscript()`/`getTranscriptUpdates()`/
 *   `getAttentionState()` all work (that's the whole point — the history and
 *   last-known attention state survive), but `prompt()` throws, because
 *   there is nothing to send it to.
 *
 * Why there is no third option ("re-attach to a still-running child across a
 * supervisor restart"): v1 spawns the agent as a plain piped-stdio child, not
 * a detached/daemonized one with a recorded PID. The child's stdio pipes
 * belong to *this* supervisor process; when the supervisor process itself
 * exits, those pipes close (most ACP agents exit on stdin EOF, and even one
 * that lingered would have no channel left for this process to talk to it
 * over). So a supervisor *process* restart always means the previous child
 * is gone — `fromPersisted()` is honest about that rather than promising a
 * reconnect it can't deliver. A child surviving its own supervisor process
 * needs a detached/ssh-deployed supervisor (issue #80/#81), explicitly out of
 * scope here. Contrast that with a same-process client/node disconnect
 * (issue #78's other half): the child never stops running, and `spawn()`'s
 * live session is what a caller re-attaches to.
 */
export class AgentSession extends EventEmitter {
  readonly providerId: string;
  readonly workspacePath: string;

  private readonly client: AcpClient | undefined;
  private readonly provider: AcpProvider | undefined;
  private readonly store: TranscriptStore | undefined;
  private readonly transcript: AcpUpdate[] = [];
  /** The v1 update stream (SPEC.md §7.24's reducer input shape), mirrored to disk as it arrives; the in-memory cache over `store`'s on-disk log. */
  private readonly transcriptUpdates: AcpTranscriptUpdate[] = [];
  private terminalEmitted = false;
  /** Set by close(): stops any further on-disk persistence, so a late child
   * 'exit' event can't write into a session state dir a caller is tearing down. */
  private closed = false;
  private sessionId: string | undefined;
  private attentionState: AttentionState;

  private constructor(opts: {
    client: AcpClient | undefined;
    provider: AcpProvider | undefined;
    providerId: string;
    workspacePath: string;
    store: TranscriptStore | undefined;
  }) {
    super();
    this.client = opts.client;
    this.provider = opts.provider;
    this.providerId = opts.providerId;
    this.workspacePath = opts.workspacePath;
    this.store = opts.store;
    this.attentionState = { status: 'working', updatedAt: new Date().toISOString() };

    if (this.client) {
      this.wireClientEvents(this.client);
    }
  }

  /**
   * Spawns the child, completes the ACP `initialize` handshake, and opens a
   * session via `session/new` rooted at `workspacePath` (SPEC.md §5.5, §5.6).
   * When `options.store` is given, also persists this session's metadata and
   * every subsequent update/turn/attention transition to disk (issue #77).
   *
   * `childOrSpawnConfig` accepts either a spawn recipe (the `local` target's
   * path: `AcpClient` spawns the real child process itself) or an
   * already-constructed `AcpChildProcess` (the `ssh:` target's path, issue
   * #80: `@loombox/node`'s `RemoteAgentChildProcess` bridges a detached
   * remote process into this exact shape, so everything below this line —
   * persistence, attention state, the permission queue, ACP framing itself —
   * is identical for a local and a remote session; only how the "child"'s
   * stdio is actually backed differs, and that's `AcpClient`'s own existing
   * seam, issue #48, not something this method needs to know about).
   */
  static async spawn(
    provider: AcpProvider,
    childOrSpawnConfig: AcpChildProcess | AcpSpawnConfig,
    workspacePath: string,
    options: AgentSessionSpawnOptions = {},
  ): Promise<AgentSession> {
    const client = new AcpClient(childOrSpawnConfig);
    // Wrap and wire error/exit listeners onto `client` BEFORE awaiting the
    // handshake below: a child that fails to spawn or crashes mid-handshake
    // still has a listener in place, so the failure surfaces as this
    // session's own 'error'/'exit' event instead of an unhandled
    // EventEmitter throw.
    const session = new AgentSession({
      client,
      provider,
      providerId: provider.id,
      workspacePath,
      store: options.store,
    });

    await client.initialize();
    const sessionId = await client.newSession(workspacePath, { mcpServers: options.mcpServers });
    session.sessionId = sessionId;

    options.store?.createSession({ sessionId, providerId: provider.id, workspacePath });
    // Idle the moment the session exists: no turn is in flight yet.
    session.setAttention('awaiting_input');

    return session;
  }

  /**
   * Reconstructs a replay-only session from what `TranscriptStore` has on
   * disk (SPEC.md §5.6, §7.22; issue #78) — see the class doc comment for
   * exactly what this does and doesn't guarantee. `isLive` is `false`;
   * `prompt()` throws.
   */
  static fromPersisted(
    meta: SessionMetaFile,
    transcriptUpdates: AcpTranscriptUpdate[],
    store: TranscriptStore,
  ): AgentSession {
    const session = new AgentSession({
      client: undefined,
      provider: undefined,
      providerId: meta.providerId,
      workspacePath: meta.workspacePath,
      store,
    });
    session.sessionId = meta.sessionId;
    session.attentionState = meta.attention;
    session.transcriptUpdates.push(...transcriptUpdates);
    // A session already recorded as errored/exited before the restart stays
    // terminal: there is nothing left to transition out of.
    session.terminalEmitted =
      meta.attention.status === 'error' || meta.attention.status === 'exited';
    return session;
  }

  /** The ACP session id this agent is running, set once `spawn()`/`fromPersisted()` resolves. */
  get id(): string {
    if (!this.sessionId) {
      throw new Error('AgentSession: not initialized yet');
    }
    return this.sessionId;
  }

  /** `true` for a session with a real child process behind it (`spawn()`); `false` for a reload-only session (`fromPersisted()`) with no child to talk to (issue #78). */
  get isLive(): boolean {
    return this.client !== undefined;
  }

  /** The `session/request_permission` FIFO queue for this session's client (SPEC.md §7.24). Only meaningful (and only available) on a live session. */
  get permissions(): PermissionQueue {
    if (!this.client) {
      throw new Error(
        `AgentSession: session "${this.sessionId}" has no live agent process (persisted/replay-only) — there is no permission queue to read.`,
      );
    }
    return this.client.permissions;
  }

  /**
   * This session's config-option state (`model`/`mode`/`thought_level`/...;
   * SPEC.md §7.24; issue #149) — the same `ConfigOptionStore` `AcpClient`
   * already seeds on `session/new`/`session/resume` and updates on both a
   * user-driven `setConfigOption()` ack and an agent-initiated unprompted
   * change, exposed here (unmodified) exactly like `permissions` above, so a
   * caller (`@loombox/node`) can read the current catalog and subscribe to
   * `'changed'` without reaching past this class into `AcpClient` itself.
   * Only meaningful (and only available) on a live session.
   */
  get configOptions(): ConfigOptionStore {
    if (!this.client) {
      throw new Error(
        `AgentSession: session "${this.sessionId}" has no live agent process (persisted/replay-only) — there is no config-option store to read.`,
      );
    }
    return this.client.configOptions;
  }

  /** Submits a new prompt into this session and awaits the turn's response. Throws on a replay-only session (`isLive === false`): there is no child left to send it to (issue #78). */
  async prompt(text: string): Promise<void> {
    if (!this.client) {
      throw new Error(
        `AgentSession: session "${this.sessionId}" has no live agent process (persisted/replay-only after a supervisor restart) — start a new session instead of prompting this one.`,
      );
    }
    this.setAttention('working');
    await this.client.prompt(this.id, text);
  }

  /** Every v0 update seen so far, oldest first, for a re-attaching caller to catch up (unchanged from v0; `@loombox/node` depends on this exact shape). */
  getTranscript(): AcpUpdate[] {
    return [...this.transcript];
  }

  /** Every v1 `AcpTranscriptUpdate` seen so far, oldest first (SPEC.md §7.24's reducer input shape) — the in-memory cache over the on-disk log (issue #77). Populated on a live session as updates stream in, and pre-loaded from disk on a `fromPersisted()` session. */
  getTranscriptUpdates(): AcpTranscriptUpdate[] {
    return [...this.transcriptUpdates];
  }

  /** This session's latest attention snapshot (SPEC.md §7.13; issue #79) — recorded regardless of whether any caller is currently listening for the `'attention'` event, and readable by a caller that only just attached. */
  getAttentionState(): AttentionState {
    return this.attentionState;
  }

  /** Deliberately terminates the underlying agent process. A no-op on a replay-only session (`isLive === false`): there is nothing to close. */
  close(): void {
    this.closed = true;
    this.client?.close();
  }

  private wireClientEvents(client: AcpClient): void {
    client.on('update', (update: AcpUpdate) => {
      const enriched = this.provider ? this.provider.enrich(update) : update;
      this.transcript.push(enriched);
      this.emit('update', enriched);
    });

    // v1: the fuller update surface persisted to disk (SPEC.md §7.24; issue
    // #77). Fires alongside (not instead of) the v0 'update' path above —
    // `AcpClient` emits both from the same incoming `session/update`.
    client.on(
      'transcript_update',
      (payload: { sessionId: string; update: AcpTranscriptUpdate }) => {
        if (payload.sessionId !== this.sessionId) return;
        this.transcriptUpdates.push(payload.update);
        if (!this.closed) this.store?.appendTranscriptUpdate(this.sessionId, payload.update);
        this.emit('transcript_update', payload.update);
      },
    );

    client.on('turn_end', (turnEnd: AcpTurnEnd) => {
      if (this.sessionId && !this.closed) this.store?.appendTurnEnd(this.sessionId, turnEnd);
      // A turn only ends once any permission it needed was already resolved,
      // so it's always safe to fall back to idle here.
      this.setAttention('awaiting_input', turnEnd);
      this.emit('turn_end', turnEnd);
    });

    client.on('permission_request', (request: PendingPermissionRequest) => {
      if (request.sessionId !== this.sessionId) return;
      this.setAttention('permission_required', {
        requestId: request.requestId,
        toolCallId: request.toolCall.id,
      });
    });

    client.permissions.on('resolved', (result: PermissionResolveResult) => {
      if (result.status !== 'resolved' || result.sessionId !== this.sessionId) return;
      // Only drop back out of 'permission_required' once nothing else is
      // still waiting on this session, and only if that's still the current
      // state (a terminal error/exit must never be clobbered back to
      // 'working' by a permission resolving concurrently with a crash).
      if (this.attentionState.status !== 'permission_required') return;
      if (client.permissions.list(result.sessionId).length === 0) {
        this.setAttention('working');
      }
    });

    client.on('error', (error: Error) => this.handleTerminal('error', error));
    client.on('exit', (code: number | null) => this.handleTerminal('exit', code));
  }

  private setAttention(status: AttentionStatus, detail?: unknown): void {
    const state: AttentionState = { status, updatedAt: new Date().toISOString(), detail };
    this.attentionState = state;
    if (this.sessionId && !this.closed) this.store?.appendAttention(this.sessionId, state);
    // Emitted unconditionally: whether anyone is listening right now is
    // irrelevant to whether this state transition happened (SPEC.md §5.6's
    // "emits events independently of any connected client"; issue #79). The
    // persisted snapshot above is what a caller that attaches later reads.
    this.emit('attention', state);
  }

  private handleTerminal(kind: 'error' | 'exit', payload: Error | number | null): void {
    // The underlying child can fire both 'error' and 'exit' for the same
    // failure; only the first is surfaced so a caller sees exactly one
    // terminal event instead of racing to handle a second.
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    if (kind === 'error') {
      this.setAttention('error', { message: (payload as Error).message });
      this.emit('error', payload as Error);
    } else {
      this.setAttention('exited', { code: payload as number | null });
      this.emit('exit', payload as number | null);
    }
  }
}
