import { EventEmitter } from 'node:events';

import { AcpClient } from '@loombox/providers-core';
import type { AcpProvider, AcpSpawnConfig, AcpTurnEnd, AcpUpdate } from '@loombox/providers-core';

/**
 * One running agent, spawned and owned by the AgentSupervisor (SPEC.md §5.6):
 * a live `AcpClient` over the child process's stdio, plus a small in-memory
 * transcript buffer of every `session/update` seen so far.
 *
 * Deliberately a plain `EventEmitter`: a caller "detaches" by removing its
 * own listeners (`session.off(...)`), which does nothing to the underlying
 * child or session, and a re-attaching caller adds new listeners and reads
 * `getTranscript()` to catch up on what it missed. v0 has no disk
 * persistence (that's v1, SPEC.md §12) — the transcript buffer lives only as
 * long as this process does.
 */
export class AgentSession extends EventEmitter {
  readonly providerId: string;
  readonly workspacePath: string;

  private readonly client: AcpClient;
  private readonly provider: AcpProvider;
  private readonly transcript: AcpUpdate[] = [];
  private terminalEmitted = false;
  private sessionId: string | undefined;

  private constructor(client: AcpClient, provider: AcpProvider, workspacePath: string) {
    super();
    this.client = client;
    this.provider = provider;
    this.providerId = provider.id;
    this.workspacePath = workspacePath;

    this.client.on('update', (update: AcpUpdate) => {
      const enriched = this.provider.enrich(update);
      this.transcript.push(enriched);
      this.emit('update', enriched);
    });
    this.client.on('turn_end', (turnEnd: AcpTurnEnd) => this.emit('turn_end', turnEnd));
    this.client.on('error', (error: Error) => this.handleTerminal('error', error));
    this.client.on('exit', (code: number | null) => this.handleTerminal('exit', code));
  }

  /**
   * Spawns the child, completes the ACP `initialize` handshake, and opens a
   * session via `session/new` rooted at `workspacePath` (SPEC.md §5.5, §5.6).
   */
  static async spawn(
    provider: AcpProvider,
    spawnConfig: AcpSpawnConfig,
    workspacePath: string,
  ): Promise<AgentSession> {
    const client = new AcpClient(spawnConfig);
    const session = new AgentSession(client, provider, workspacePath);
    await client.initialize();
    session.sessionId = await client.newSession(workspacePath);
    return session;
  }

  /** The ACP session id this agent is running, set once `spawn()` resolves. */
  get id(): string {
    if (!this.sessionId) {
      throw new Error('AgentSession: not initialized yet');
    }
    return this.sessionId;
  }

  /** Submits a new prompt into this session and awaits the turn's response. */
  async prompt(text: string): Promise<void> {
    await this.client.prompt(this.id, text);
  }

  /** Every update seen so far, oldest first, for a re-attaching caller to catch up. */
  getTranscript(): AcpUpdate[] {
    return [...this.transcript];
  }

  /** Deliberately terminates the underlying agent process. */
  close(): void {
    this.client.close();
  }

  private handleTerminal(kind: 'error' | 'exit', payload: Error | number | null): void {
    // The underlying child can fire both 'error' and 'exit' for the same
    // failure; only the first is surfaced so a caller sees exactly one
    // terminal event instead of racing to handle a second.
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    if (kind === 'error') {
      this.emit('error', payload as Error);
    } else {
      this.emit('exit', payload as number | null);
    }
  }
}
