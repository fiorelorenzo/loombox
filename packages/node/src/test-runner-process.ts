import { spawn } from 'node:child_process';

import { shQuote, type RemoteTransport } from './ssh/remote-transport';
import type { RemoteProcessRunner } from './ssh/remote-process-runner';
import { startWindowsLocalRun } from './windows/windows-job-runner';

/**
 * Runs a project's configured test/lint/build command and streams its
 * output live (SPEC §7.15; issue #244), for both a `local` target
 * (`startLocalRun`) and an `ssh:` one (`startSshRun`). Neither function
 * knows anything about permission policy or which of test/lint/build is
 * running — `NodeDaemon` evaluates policy and resolves the command string
 * *before* calling either (see that class's `executeRun`), so a denied
 * command never reaches this module at all.
 *
 * **Local**: dispatches on `process.platform`. On POSIX, `child_process.
 * spawn` with `detached: true`, which makes the spawned `sh` the leader of
 * its own new process group — the actual mechanism behind "no leftover
 * process after cancel": `cancel()` signals the whole group via the
 * negative-pid convention (`process.kill(-pid, ...)`), not just the
 * leader, so a command that forks children (any real test runner) doesn't
 * leak them. On `win32`, `startLocalRun` hands off to `./windows/windows-
 * job-runner.ts`'s `startWindowsLocalRun` — same `StartRunOptions` in,
 * same `RunHandle` out — which spawns a PowerShell-hosted Win32 Job Object
 * instead of a process group (issue #940: Windows has no process groups
 * for `detached`/negative-pid to mean anything; see that module's own doc
 * comment for why a Job Object is the correct equivalent and never
 * `taskkill /T`). Genuinely never run on a real Windows machine — issue
 * #939 tracks real-machine verification for this whole platform.
 *
 * **ssh:**: reuses `RemoteProcessRunner` (setsid+fifo+log-tail) rather than
 * opening a second ssh channel — see that module's own doc comment for why
 * (`RemoteTransport` has no persistent streaming primitive; issue #80).
 * `RemoteProcessRunner.launch` only ever records a detached job's pid, not
 * its eventual exit status (its callers so far — agent sessions, terminals
 * — are long-lived and reattach-driven, never "wait for this to finish and
 * tell me pass/fail"), so this file adds its own exit-code capture on top,
 * entirely outside that class: the launched command is wrapped to write its
 * own `$?` to a side file this module names and reads back, never touching
 * `remote-process-runner.ts` itself. Cancel calls `RemoteProcessRunner.stop`
 * unchanged — its `setsid` branch is a process-*group* kill (issue #642),
 * which is what makes this module's own ssh cancel tree-safe.
 *
 * Both run the command through `sh -c` (never argv-split — same convention
 * every other project-configured command in this codebase already uses:
 * `RemoteProcessRunner.launch`'s own callers, `TerminalSupervisor`'s
 * `cd ... && clear`) so "command not found" is a uniform POSIX 127 on
 * either target, one classification path instead of branching on ENOENT
 * versus a remote shell's own "not found" text.
 */

/** Client-generated run ids share `terminalId`'s "opaque, no structure this package cares about" shape, but an ssh run's exit-file path (below) is built directly from one — checked against the same safe-charset convention `RemoteProcessRunner`'s own `assertSafeRunId` enforces before it ever reaches a shell command. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

/** Awaits `ms` milliseconds — the poll loop's own pacing between `RemoteProcessRunner.readOutput`/`isRunning` rounds (this module's doc comment: no push-based alternative exists). */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export type RunOutcome = 'pass' | 'fail' | 'could_not_start';

export interface RunExitResult {
  outcome: RunOutcome;
  /** The real exit code when the process reported one (including 127); `null` when it never spawned, or was terminated by a signal with no numeric status of its own (most cancellations). */
  exitCode: number | null;
  /** Set for `outcome: 'could_not_start'`. */
  reason?: string;
  /** Set when this exit was the direct result of `RunHandle.cancel()`. */
  cancelled?: boolean;
}

export interface RunHandle {
  /** Kills the whole process tree this run started and never throws. Resolves once the kill has been issued (local) or the remote group's death is confirmed (ssh, via `RemoteProcessRunner.stop`'s own contract). */
  cancel(): Promise<void>;
}

export interface StartRunOptions {
  /** The already-configured shell command line to run (e.g. `pnpm test`) — interpreted by `sh -c`, never argv-split. */
  command: string;
  onOutput: (chunk: Uint8Array) => void;
  /** Called exactly once, whether the run finished, failed to start, or was cancelled. */
  onExit: (result: RunExitResult) => void;
}

/** Classifies a real, observed POSIX exit code — never called for a process that never spawned at all (that's always `could_not_start` with `exitCode: null`, decided by the caller). */
function classifyExitCode(exitCode: number): RunExitResult {
  if (exitCode === 127) {
    return { outcome: 'could_not_start', exitCode, reason: 'command not found' };
  }
  return exitCode === 0 ? { outcome: 'pass', exitCode } : { outcome: 'fail', exitCode };
}

/** Runs `command` locally and streams its combined stdout+stderr — a detached POSIX process group, or (`process.platform === 'win32'`) `./windows/windows-job-runner.ts`'s Job Object wrapper. See this module's own doc comment for the cancel mechanism on each platform. */
export function startLocalRun(options: StartRunOptions): RunHandle {
  if (process.platform === 'win32') return startWindowsLocalRun(options);

  const { command, onOutput, onExit } = options;
  let cancelled = false;
  let settled = false;

  const settle = (result: RunExitResult): void => {
    if (settled) return;
    settled = true;
    onExit(result);
  };

  let child;
  try {
    child = spawn('sh', ['-c', `(${command}) 2>&1`], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    settle({
      outcome: 'could_not_start',
      exitCode: null,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { cancel: () => Promise.resolve() };
  }

  child.stdout?.on('data', (chunk: Buffer) => onOutput(new Uint8Array(chunk)));
  child.on('error', (error) => {
    // The shell itself never started (e.g. `sh` missing from PATH) — there
    // is no exit code to report at all, unlike a 127 from inside it.
    settle({ outcome: 'could_not_start', exitCode: null, reason: error.message });
  });
  child.on('exit', (code) => {
    if (cancelled) {
      settle({ outcome: 'fail', exitCode: code, cancelled: true });
      return;
    }
    settle(code === null ? { outcome: 'fail', exitCode: null } : classifyExitCode(code));
  });

  return {
    cancel() {
      cancelled = true;
      if (child.pid !== undefined) {
        try {
          // The negative pid signals the whole process GROUP `detached:
          // true` made this child the leader of — issue #244's "no
          // leftover process after cancel". A bare `child.kill()` only
          // reaches the leader.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already exited.
        }
      }
      return Promise.resolve();
    },
  };
}

export interface StartSshRunOptions extends StartRunOptions {
  runner: RemoteProcessRunner;
  transport: RemoteTransport;
  /** Client-generated, validated with {@link isSafeRunId} by the caller before this is invoked. */
  runId: string;
  /** How often to poll the remote log/liveness (`RemoteProcessRunner.readOutput`/`isRunning`) — there is no push-based alternative (this module's own doc comment). Defaults to 300ms: frequent enough to feel live, cheap enough not to flood a real ssh connection. */
  pollIntervalMs?: number;
}

/** Runs `command` on an `ssh:` target via `RemoteProcessRunner`, polling its log and liveness since `RemoteTransport` has no streaming primitive. See this module's own doc comment for the exit-code side-channel this adds on top. */
export async function startSshRun(options: StartSshRunOptions): Promise<RunHandle> {
  const { runner, transport, runId, command, onOutput, onExit } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 300;

  if (!isSafeRunId(runId)) {
    throw new Error(`test-runner-process: unsafe run id "${runId}"`);
  }

  // Outside `RemoteProcessRunner`'s own `runDir` on purpose (this module's
  // doc comment: no changes to `remote-process-runner.ts`). `buildLaunchScript`
  // already redirects the launched command's own stdout+stderr into its log
  // for us (`<>fifo >>log 2>&1`), so this inner script needs no `2>&1` of
  // its own — only the trailing exit-code capture.
  const exitFile = `/tmp/loombox-test-run-${runId}.exit`;
  // `(command)` — a subshell — so a command that itself calls a bare
  // `exit N` (a shell builtin: some real test/lint scripts do this) only
  // exits that subshell, not this whole capture script; without the
  // parens, `exit N` would terminate `sh -c` immediately and `rc=$?`
  // below would never run.
  const innerScript = `(${command}); rc=$?; printf '%s' "$rc" > ${shQuote(exitFile)}; exit "$rc"`;
  const launchCommand = `sh -c ${shQuote(innerScript)}`;

  const { handle } = await runner.launchWithFallback(runId, launchCommand);

  let cancelled = false;
  let settled = false;
  let offset = 0;

  const settle = (result: RunExitResult): void => {
    if (settled) return;
    settled = true;
    onExit(result);
  };

  const flush = async (): Promise<void> => {
    const { data, offset: nextOffset } = await runner.readOutput(handle, offset);
    offset = nextOffset;
    if (data.length > 0) onOutput(new TextEncoder().encode(data));
  };

  const readCapturedExitCode = async (): Promise<number | null> => {
    const result = await transport.exec(`cat ${shQuote(exitFile)} 2>/dev/null`);
    await transport.exec(`rm -f ${shQuote(exitFile)}`).catch(() => {
      // Best-effort cleanup only.
    });
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  };

  void (async () => {
    try {
      while (!settled) {
        await flush();
        if (!(await runner.isRunning(handle))) break;
        await sleep(pollIntervalMs);
      }
      await flush();

      if (cancelled) {
        settle({ outcome: 'fail', exitCode: await readCapturedExitCode(), cancelled: true });
        return;
      }
      const exitCode = await readCapturedExitCode();
      settle(exitCode === null ? { outcome: 'fail', exitCode: null } : classifyExitCode(exitCode));
    } catch (error) {
      settle({
        outcome: 'could_not_start',
        exitCode: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return {
    async cancel() {
      cancelled = true;
      // Resolves only once the remote group is confirmed dead/force-killed
      // (issue #642's fixed `buildStopScript`) — by the time this returns
      // the poll loop above will observe `isRunning` false on its next
      // iteration and settle with `cancelled: true`.
      await runner.stop(handle);
    },
  };
}
