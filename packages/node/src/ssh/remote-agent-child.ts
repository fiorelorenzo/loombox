import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import type { AcpChildProcess } from '@loombox/providers-core';

import { RemoteProcessRunner, type RemoteRunHandle } from './remote-process-runner';

/**
 * Bridges a detached remote run (issue #80's `RemoteProcessRunner`) into the
 * same `AcpChildProcess` shape `@loombox/providers-core`'s `AcpClient`
 * already accepts as an alternative to a spawn config (its constructor is
 * `childOrConfig: AcpChildProcess | AcpSpawnConfig`, issue #48). This is
 * deliberately the *only* new plumbing needed to give an `ssh:` target
 * session full parity with a `local` one: `AgentSupervisor`/`AgentSession`
 * and everything downstream (transcript persistence, attention state,
 * permission queue, the whole ACP JSON-RPC framing/parsing) is reused
 * unmodified — this class only has to look like a child process, not
 * reimplement anything ACP-shaped.
 *
 * How it looks like a child process without one: `stdin.write()` forwards to
 * `RemoteProcessRunner.writeInput()` (appends to the remote fifo the
 * detached process reads from); `stdout` is a local `PassThrough` fed by
 * polling `RemoteProcessRunner.readOutput()` on an interval and re-emitting
 * new bytes; liveness is polled the same way and surfaced as this process's
 * own `'exit'` event once the remote run stops being reported alive.
 *
 * Not a byte-perfect substitute for a real pipe: there's a `pollIntervalMs`
 * window (default 150ms) between the remote process actually writing/exiting
 * and this object noticing, and (documented limitation, acceptable for this
 * wave) output written in the small race between the last "still alive"
 * check and the process actually exiting can be lost. A real long-lived
 * streaming channel (SSH `exec` kept open, or `tail -f`) would remove both,
 * and is a reasonable follow-up once this mechanism has real-world mileage.
 */
export class RemoteAgentChildProcess extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: Writable;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private offset = 0;
  private stopped = false;

  constructor(
    private readonly runner: RemoteProcessRunner,
    private readonly handle: RemoteRunHandle,
    private readonly options: { pollIntervalMs?: number } = {},
  ) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.runner
          .writeInput(this.handle, typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
          .then(() => callback())
          .catch((error: unknown) =>
            callback(error instanceof Error ? error : new Error(String(error))),
          );
      },
    });
  }

  /**
   * Starts tailing the remote run's output and polling its liveness.
   *
   * `fromOffset` defaults to 0 (the beginning of the log), correct for a
   * *freshly launched* run — an empty log. For a genuine reattach to an
   * already-running process, a caller MUST instead pass the log's current
   * length (e.g. from `RemoteProcessRunner.readOutput(handle, 0)`'s
   * returned `offset`, read and discarded once before constructing this
   * bridge): a fresh `AcpClient` numbers its own outgoing JSON-RPC request
   * ids starting at 1 again, so replaying history from byte 0 risks a stale
   * logged response colliding with — and wrongly resolving — this new
   * client's own in-flight request of the same id.
   */
  start(fromOffset = 0): void {
    this.offset = fromOffset;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.options.pollIntervalMs ?? 150);
    this.pollTimer.unref?.();
  }

  private poll(): void {
    if (this.stopped) return;
    this.runner
      .isRunning(this.handle)
      .then(async (alive) => ({
        alive,
        result: await this.runner.readOutput(this.handle, this.offset),
      }))
      .then(({ alive, result }) => {
        if (this.stopped) return;
        if (result.data) {
          this.offset = result.offset;
          this.stdout.write(result.data);
        }
        if (!alive) this.handleExit(null);
      })
      .catch((error: unknown) => {
        if (this.stopped) return;
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
  }

  private handleExit(code: number | null): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.emit('exit', code);
  }

  /** Best-effort remote termination; matches `ChildProcess.kill()`'s synchronous-looking signature (the actual remote `kill` is fire-and-forget from here). */
  kill(): boolean {
    if (!this.stopped) {
      this.handleExit(null);
      this.runner.stop(this.handle).catch(() => {});
    }
    return true;
  }

  /**
   * Stops polling this run's output/liveness WITHOUT terminating the remote
   * process — for when this local bridge object is being torn down
   * independent of the session itself (e.g. `@loombox/node`'s `NodeDaemon`
   * shutting down: issue #80's "the driving node exiting entirely does not
   * kill the remote agent process"). Idempotent, and pre-empts a later
   * `kill()` call from actually terminating the remote process (`kill()`'s
   * own `!this.stopped` guard), which is exactly the desired ordering when a
   * caller detaches and then the object it detached from happens to also
   * get `close()`d. Does not emit `'exit'`: the process isn't dying, this
   * object is just no longer watching it.
   */
  detachLocal(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}

/**
 * Casts a {@link RemoteAgentChildProcess} to `AcpChildProcess` for handing to
 * `new AcpClient(...)`. A real `ChildProcess` has many members this class
 * doesn't implement (`pid`, `connected`, `send`, ...); `AcpClient` only ever
 * touches `.stdout`, `.stdin.write()`, `.on('error')`, `.on('exit')`, and
 * `.kill()` (verified against `packages/providers/core/src/client.ts`), all
 * of which this class provides — hence the explicit `unknown` bridge instead
 * of trying to satisfy the full `ChildProcess` shape.
 */
export function asAcpChildProcess(child: RemoteAgentChildProcess): AcpChildProcess {
  return child as unknown as AcpChildProcess;
}
