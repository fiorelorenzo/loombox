import type { AcpProvider } from '@loombox/providers-core';
import { claudeProvider } from '@loombox/providers-claude';

import { AgentSession } from './agent-session';
import { TranscriptStore } from './transcript-store';

export interface AgentSupervisorStartOptions {
  /** Absolute path the agent runs against; passed as both the spawn cwd and the ACP session cwd. */
  workspacePath: string;
  /** Provider id registered on this supervisor (default: 'claude'). */
  providerId?: string;
}

export interface AgentSupervisorOptions {
  /** Providers registered on construction; defaults to just claudeProvider. Tests inject fixtures here. */
  providers?: AcpProvider[];
  /**
   * Where this supervisor's `TranscriptStore` persists session state
   * (SPEC.md §5.6, §7.22; issue #77). Defaults to `defaultStateDir()`
   * (`$XDG_STATE_HOME/loombox/supervisor`, else `~/.loombox/supervisor`).
   * Always inject an `os.mkdtemp()` directory in tests — leaving this unset
   * writes to the real state dir the moment `start()` is called.
   */
  stateDir?: string;
}

/**
 * Owns every agent process spawned on this host (SPEC.md §5.6): spawns each
 * agent as a child process, persists a structured, resumable transcript to
 * disk (issue #77), survives client/node disconnects and exposes
 * attach/resume (issue #78), and emits completion/attention events
 * independently of any connected client (issue #79). v1 scope is still
 * local, in-process spawn only — SSH deploy (#80), the tmux fallback (#81),
 * and cross-node leasing (#82) are explicitly out of scope here.
 *
 * A session started here keeps running independent of any single caller:
 * `start()` spawns exactly once, and a caller that detaches (stops
 * listening, e.g. a node's WS client reconnecting) and later re-attaches
 * does so via `get(sessionId)`, never by calling `start()` again, so the
 * child is never respawned per attach. See `AgentSession`'s class doc
 * comment for exactly what survives a *supervisor process* restart
 * (`reloadPersistedSessions()`, below) versus a same-process caller
 * detach/re-attach — they are different guarantees.
 */
export class AgentSupervisor {
  private readonly providers = new Map<string, AcpProvider>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly store: TranscriptStore;

  constructor(options: AgentSupervisorOptions = {}) {
    for (const provider of options.providers ?? [claudeProvider]) {
      this.providers.set(provider.id, provider);
    }
    this.store = new TranscriptStore({ stateDir: options.stateDir });
  }

  /** Registers (or replaces) a provider adapter under its own id. */
  registerProvider(provider: AcpProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Spawns a new agent via the given provider and holds it alive. */
  async start({
    workspacePath,
    providerId = 'claude',
  }: AgentSupervisorStartOptions): Promise<AgentSession> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`AgentSupervisor: no provider registered for id "${providerId}"`);
    }

    const spawnConfig = provider.spawnConfig({ cwd: workspacePath });
    const session = await AgentSession.spawn(provider, spawnConfig, workspacePath, {
      store: this.store,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Enumerates every session persisted under this supervisor's state dir
   * (SPEC.md §5.6's "on startup the supervisor can enumerate persisted
   * sessions and reload their transcript"; issue #78) and, for any that
   * aren't already tracked in memory, reconstructs a replay-only
   * `AgentSession` (`isLive === false`) from its on-disk log and metadata —
   * see `AgentSession.fromPersisted()`'s doc comment for exactly why a
   * supervisor *process* restart never re-attaches to a still-running child
   * in this scope, only to its persisted history and last-known attention
   * state. Not called automatically by the constructor (a fresh
   * `AgentSupervisor` shouldn't have a side effect of scanning disk before
   * anyone asks it to); a host process calls this once at startup.
   */
  reloadPersistedSessions(): AgentSession[] {
    const reloaded: AgentSession[] = [];
    for (const sessionId of this.store.listSessionIds()) {
      if (this.sessions.has(sessionId)) continue;
      const meta = this.store.readMeta(sessionId);
      if (!meta) continue;

      const transcriptUpdates = this.store.readTranscriptUpdates(sessionId);
      const session = AgentSession.fromPersisted(meta, transcriptUpdates, this.store);
      this.sessions.set(sessionId, session);
      reloaded.push(session);
    }
    return reloaded;
  }

  /** Looks up a still-running (or, post-reload, replay-only) session by id; the re-attach path (never respawns). */
  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every session currently held by this supervisor. */
  listSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** Deliberately terminates a session's agent process and stops tracking it. The on-disk transcript is left in place. */
  stop(sessionId: string): void {
    this.sessions.get(sessionId)?.close();
    this.sessions.delete(sessionId);
  }
}
