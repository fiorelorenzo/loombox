import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteProcessRunner } from './ssh/remote-process-runner';
import {
  openRemoteSessionsSandbox,
  type RemoteSessionsSandbox,
} from './ssh/remote-sessions-test-sandbox';
import { isSafeRunId, startLocalRun, startSshRun, type RunExitResult } from './test-runner-process';

/** Collects every `onOutput`/`onExit` call in arrival order, decoding output chunks as UTF-8 text for easy assertion. */
function collectRun(): {
  output: string[];
  exit: () => Promise<RunExitResult>;
  onOutput: (chunk: Uint8Array) => void;
  onExit: (result: RunExitResult) => void;
} {
  const output: string[] = [];
  const { promise, resolve } = Promise.withResolvers<RunExitResult>();
  return {
    output,
    exit: () => promise,
    onOutput: (chunk) => output.push(Buffer.from(chunk).toString('utf8')),
    onExit: (result) => resolve(result),
  };
}

/** True while a process with `pid` still exists (`kill -0`'s own semantics) — the tree-kill assertion's one real check. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Real wall-clock wait, used only where this suite genuinely needs one: proving output arrives WHILE a real OS process is still running (a live-stream vs. buffered-until-exit distinction that only exists in real time, no fake-timer substitute), and polling real cross-process state (a pidfile a spawned shell writes, a remote log this module tails) that nothing in this process can `await` directly. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe('startLocalRun', () => {
  it('streams output as it is produced, not buffered until exit', async () => {
    const run = collectRun();
    const handle = startLocalRun({
      command: 'echo start; sleep 0.3; echo end',
      onOutput: run.onOutput,
      onExit: run.onExit,
    });
    // Real wait, deliberately shorter than the command's own `sleep 0.3`
    // (see `sleep`'s doc comment): the point is observing output while the
    // process is provably still running, not something a fake timer can
    // stand in for.
    await sleep(120);
    expect(run.output.join('')).toContain('start');
    expect(run.output.join('')).not.toContain('end');
    const result = await run.exit();
    expect(result).toEqual({ outcome: 'pass', exitCode: 0 });
    expect(run.output.join('')).toBe('start\nend\n');
    await handle.cancel();
  });

  it('reports outcome: pass with the real exit code 0', async () => {
    const run = collectRun();
    startLocalRun({ command: 'exit 0', onOutput: run.onOutput, onExit: run.onExit });
    expect(await run.exit()).toEqual({ outcome: 'pass', exitCode: 0 });
  });

  it('reports outcome: fail with the real non-zero exit code', async () => {
    const run = collectRun();
    startLocalRun({ command: 'exit 3', onOutput: run.onOutput, onExit: run.onExit });
    expect(await run.exit()).toEqual({ outcome: 'fail', exitCode: 3 });
  });

  it('reports outcome: could_not_start with exitCode 127 for a missing command, via sh -c uniformly', async () => {
    const run = collectRun();
    startLocalRun({
      command: 'this-command-does-not-exist-anywhere',
      onOutput: run.onOutput,
      onExit: run.onExit,
    });
    const result = await run.exit();
    expect(result.outcome).toBe('could_not_start');
    expect(result.exitCode).toBe(127);
  });

  it('cancel() kills the whole process tree, including a forked grandchild — not just the launched shell (issue #244 acceptance)', async () => {
    const pidFile = path.join(tmpdir(), `loombox-local-run-child-pid-${randomUUID()}`);
    const run = collectRun();
    const handle = startLocalRun({
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      onOutput: run.onOutput,
      onExit: run.onExit,
    });

    // Polls a real file a real spawned shell writes — there is no promise
    // or event in THIS process to await instead.
    let childPid = 0;
    for (let i = 0; i < 50; i++) {
      try {
        childPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
        if (childPid > 0) break;
      } catch {
        // pidFile not written yet.
      }
      await sleep(20);
    }
    expect(childPid).toBeGreaterThan(0);
    expect(processAlive(childPid)).toBe(true);

    await handle.cancel();
    const result = await run.exit();
    expect(result.cancelled).toBe(true);

    // The single most important assertion in this file: the forked child
    // (not merely the `sh` leader) is actually gone.
    expect(processAlive(childPid)).toBe(false);
  });

  it('cancelling an already-exited run is a harmless no-op', async () => {
    const run = collectRun();
    const handle = startLocalRun({ command: 'exit 0', onOutput: run.onOutput, onExit: run.onExit });
    await run.exit();
    await expect(handle.cancel()).resolves.toBeUndefined();
  });
});

describe('isSafeRunId', () => {
  it('accepts an alphanumeric/dash/underscore id', () => {
    expect(isSafeRunId('run-abc123_def')).toBe(true);
  });

  it('rejects an id with shell metacharacters', () => {
    expect(isSafeRunId('../evil; rm -rf /')).toBe(false);
  });
});

describe('startSshRun (against a real local process standing in for the remote, via RemoteProcessRunner)', () => {
  let sandbox: RemoteSessionsSandbox;

  afterEach(async () => {
    await sandbox?.close();
  });

  it('streams output as it is produced (polled), not buffered until exit', async () => {
    sandbox = openRemoteSessionsSandbox();
    const transport = sandbox.createTransport();
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);

    const run = collectRun();
    const handle = await startSshRun({
      runner,
      transport,
      runId: `run-${randomUUID()}`,
      command: 'echo start; sleep 0.5; echo end',
      onOutput: run.onOutput,
      onExit: run.onExit,
      pollIntervalMs: 100,
    });

    // Real wait, deliberately shorter than the command's own `sleep 0.5`
    // (see `sleep`'s doc comment above): proving the poll loop delivers
    // output before the remote command exits, not after.
    await sleep(250);
    expect(run.output.join('')).toContain('start');
    expect(run.output.join('')).not.toContain('end');

    const result = await run.exit();
    expect(result).toEqual({ outcome: 'pass', exitCode: 0 });
    expect(run.output.join('')).toBe('start\nend\n');
    await handle.cancel();
  });

  it('reports outcome: fail with the real non-zero exit code', async () => {
    sandbox = openRemoteSessionsSandbox();
    const transport = sandbox.createTransport();
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);

    const run = collectRun();
    await startSshRun({
      runner,
      transport,
      runId: `run-${randomUUID()}`,
      command: 'exit 5',
      onOutput: run.onOutput,
      onExit: run.onExit,
      pollIntervalMs: 50,
    });
    expect(await run.exit()).toEqual({ outcome: 'fail', exitCode: 5 });
  });

  it('reports outcome: could_not_start with exitCode 127 for a missing command, via sh -c uniformly', async () => {
    sandbox = openRemoteSessionsSandbox();
    const transport = sandbox.createTransport();
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);

    const run = collectRun();
    await startSshRun({
      runner,
      transport,
      runId: `run-${randomUUID()}`,
      command: 'this-command-does-not-exist-anywhere',
      onOutput: run.onOutput,
      onExit: run.onExit,
      pollIntervalMs: 50,
    });
    const result = await run.exit();
    expect(result.outcome).toBe('could_not_start');
    expect(result.exitCode).toBe(127);
  });

  it('rejects an unsafe runId rather than interpolating it into the exit-file path', async () => {
    sandbox = openRemoteSessionsSandbox();
    const transport = sandbox.createTransport();
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);

    const run = collectRun();
    await expect(
      startSshRun({
        runner,
        transport,
        runId: '../evil; rm -rf /',
        command: 'true',
        onOutput: run.onOutput,
        onExit: run.onExit,
      }),
    ).rejects.toThrow(/unsafe run id/);
  });

  // Depends on issue #642's `buildStopScript` process-*group* kill fix
  // (PR #645) — `RemoteProcessRunner.stop()` only reaches the setsid
  // leader's own pid until that lands. This is the ssh-side counterpart of
  // `startLocalRun`'s identically-named test above; it exercises the exact
  // same fixture (a forked, still-running grandchild) over this module's
  // own exit-code side-channel and `RemoteProcessRunner.stop()`.
  it('cancel() kills the whole remote process tree, including a forked grandchild (depends on #642/#645)', async () => {
    sandbox = openRemoteSessionsSandbox();
    const transport = sandbox.createTransport();
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);

    const run = collectRun();
    const handle = await startSshRun({
      runner,
      transport,
      runId: `run-${randomUUID()}`,
      command: 'sleep 30 & echo $! & wait',
      onOutput: run.onOutput,
      onExit: run.onExit,
      pollIntervalMs: 50,
    });

    // Polls this run's own streamed output for the forked `sleep 30`'s pid
    // (the first line, from `echo $!`) — there is no promise or event in
    // THIS process to await instead of the remote log tail.
    let childPid = 0;
    for (let i = 0; i < 50; i++) {
      const match = /^(\d+)/.exec(run.output.join(''));
      if (match) {
        childPid = Number.parseInt(match[1]!, 10);
        break;
      }
      await sleep(50);
    }
    expect(childPid).toBeGreaterThan(0);
    expect(processAlive(childPid)).toBe(true);

    await handle.cancel();
    const result = await run.exit();
    expect(result.cancelled).toBe(true);
    expect(processAlive(childPid)).toBe(false);
  });
});
