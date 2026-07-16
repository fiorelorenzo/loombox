import type { AcpProvider } from '@loombox/providers-core';
import { claudeProvider } from '@loombox/providers-claude';

import { AgentSession } from './agent-session';

export interface AgentSupervisorStartOptions {
  /** Absolute path the agent runs against; passed as both the spawn cwd and the ACP session cwd. */
  workspacePath: string;
  /** Provider id registered on this supervisor (default: 'claude'). */
  providerId?: string;
}

export interface AgentSupervisorOptions {
  /** Providers registered on construction; defaults to just claudeProvider. Tests inject fixtures here. */
  providers?: AcpProvider[];
}

/**
 * Owns every agent process spawned on this host (SPEC.md §5.6). v0 scope is
 * deliberately narrow: local, in-process spawn only, no SSH deploy and no
 * disk persistence (both are v1, SPEC.md §12) — a session only survives as
 * long as this process does.
 *
 * A session started here keeps running independent of any single caller:
 * `start()` spawns exactly once, and a caller that detaches (stops
 * listening, e.g. a node's WS client reconnecting) and later re-attaches
 * does so via `get(sessionId)`, never by calling `start()` again, so the
 * child is never respawned per attach.
 */
export class AgentSupervisor {
  private readonly providers = new Map<string, AcpProvider>();
  private readonly sessions = new Map<string, AgentSession>();

  constructor(options: AgentSupervisorOptions = {}) {
    for (const provider of options.providers ?? [claudeProvider]) {
      this.providers.set(provider.id, provider);
    }
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
    const session = await AgentSession.spawn(provider, spawnConfig, workspacePath);
    this.sessions.set(session.id, session);
    return session;
  }

  /** Looks up a still-running session by id; the re-attach path (never respawns). */
  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every session currently held by this supervisor. */
  listSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** Deliberately terminates a session's agent process and stops tracking it. */
  stop(sessionId: string): void {
    this.sessions.get(sessionId)?.close();
    this.sessions.delete(sessionId);
  }
}
