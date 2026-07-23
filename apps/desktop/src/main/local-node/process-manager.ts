import { spawn, type ChildProcess } from 'node:child_process';

import type { LocalNodeStatus } from '../../shared/bridge';

export interface LaunchCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Supervises (at most) one local node child process (issue #403's
 * `spawnLocalNode`/`stopLocalNode`). The actual `@loombox/node` launch
 * command (its built CLI entry + the env it needs — relay URL, node/device
 * id, auth token, AMK) isn't resolved yet (see `../../shared/bridge.ts`'s
 * doc comment on this section) — that's `../ipc/handlers.ts`'s job when it
 * eventually has one to pass in. This class only owns the generic
 * spawn/track/stop mechanics, independent of what command it's given, which
 * is what makes it testable here without any of that config existing yet.
 */
export class LocalNodeProcessManager {
  private child: ChildProcess | undefined;
  private currentStatus: LocalNodeStatus = 'stopped';

  status(): LocalNodeStatus {
    return this.currentStatus;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  /** No-op (returns the current status) if a process is already running — call {@link stop} first to relaunch. */
  spawn(launch: LaunchCommand): LocalNodeStatus {
    if (this.child) {
      return this.currentStatus;
    }
    this.currentStatus = 'starting';
    const child = spawn(launch.command, launch.args ?? [], {
      env: { ...process.env, ...launch.env },
      stdio: 'ignore',
    });
    this.child = child;

    child.once('spawn', () => {
      if (this.child === child) this.currentStatus = 'running';
    });
    child.once('error', () => {
      if (this.child === child) {
        this.currentStatus = 'error';
        this.child = undefined;
      }
    });
    child.once('exit', () => {
      if (this.child === child) {
        this.currentStatus = 'stopped';
        this.child = undefined;
      }
    });

    return this.currentStatus;
  }

  /** No-op if nothing is running. Sends `SIGTERM`; the tracked `exit` handler above (not this method) is what actually flips `status()` back to `'stopped'`, so a caller polling `status()` sees `'running'` until the process has genuinely exited. */
  stop(): void {
    this.child?.kill('SIGTERM');
  }
}
