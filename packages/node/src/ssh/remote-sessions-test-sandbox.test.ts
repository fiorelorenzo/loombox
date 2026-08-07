import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteProcessRunner } from './remote-process-runner';
import {
  openRemoteSessionsSandbox,
  type RemoteSessionsSandbox,
} from './remote-sessions-test-sandbox';

/**
 * Proves issue #646: the sandbox's `afterEach` reaper used to
 * `process.kill(pid, 'SIGKILL')` the `setsid` leader alone, so a fixture
 * command that forked a real child (any real agent or command) leaked that
 * child every time — exactly the class of leak issue #518 exists to
 * prevent, and the harness was supposed to be the backstop for. It went
 * unnoticed because every test using this sandbox already called
 * `runner.stop()` first, which (after #645) reaps the whole tree before the
 * afterEach reaper ever runs — so the reaper's own bug was masked by the
 * thing it exists to back up. This test deliberately skips that graceful
 * stop, so only the reaper itself is under test.
 */
describe('openRemoteSessionsSandbox: afterEach reaper signals the whole process group, not just the leader (issue #646)', () => {
  let sandbox: RemoteSessionsSandbox | undefined;
  let outside: ChildProcess | undefined;

  afterEach(async () => {
    await sandbox?.close();
    sandbox = undefined;
    // This test's own "process outside the group" is never tracked by the
    // sandbox — on purpose, that's what it's proving — so it needs its own
    // teardown here, independent of the reaper under test.
    if (outside?.pid !== undefined) {
      try {
        process.kill(-outside.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    outside = undefined;
  });

  it('reaps a forked child left behind by a test that never calls runner.stop(), but leaves a process outside that group alone', async () => {
    sandbox = openRemoteSessionsSandbox();
    const transport = sandbox.createTransport();
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);

    const runId = randomUUID();
    const childPidFile = path.join(tmpdir(), `loombox-reaper-child-${runId}.pid`);
    // Same fixture shape as `remote-process-runner.test.ts`'s #642 group-kill
    // test: a real forked child left in the launcher's own setsid process
    // group, standing in for "any real agent or command that spawns
    // children". `runner.stop()` is deliberately never called on this
    // handle — the exact scenario issue #646 names: a test that crashes
    // before its own stop call, or spawns outside the runner entirely, must
    // still be cleaned up by the afterEach reaper alone.
    const command = `sh -c 'sleep 60 & echo $! > ${childPidFile}; wait'`;
    await runner.launch(runId, command, 'setsid');

    // Polling a real OS pid file on a real clock — same documented
    // real-timer exception `remote-process-runner.test.ts` uses: there is no
    // event to await instead, and fake timers can't fake actual process
    // state.
    let childPid = 0;
    const readDeadline = Date.now() + 2000;
    while (Date.now() < readDeadline && !childPid) {
      try {
        childPid = Number.parseInt((await readFile(childPidFile, 'utf8')).trim(), 10);
      } catch {
        // Not written yet.
      }
      if (!childPid) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 25);
        await promise;
      }
    }
    expect(childPid).toBeGreaterThan(0);
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(true);

    // A real, independent process sharing NOTHING with the sandbox: its own
    // session (`detached: true` calls `setsid()` before exec, so its own
    // distinct process group), started directly by this test rather than
    // through `RemoteProcessRunner` — exactly "a process outside the group"
    // the reaper must never touch, however wide its own group-kill reaches.
    outside = spawn('sh', ['-c', 'exec sleep 60'], { detached: true, stdio: 'ignore' });
    const outsidePid = outside.pid;
    expect(outsidePid).toBeDefined();
    let outsideAliveBeforeClose = true;
    try {
      process.kill(outsidePid!, 0);
    } catch {
      outsideAliveBeforeClose = false;
    }
    expect(outsideAliveBeforeClose).toBe(true);

    // This is exactly what the real `afterEach` hook calls — the reaper
    // alone, with no explicit `runner.stop()` ever having run on the
    // sandboxed session above.
    await sandbox.close();

    // Same real-timer exception as above: confirming an actual OS process
    // has exited.
    const killDeadline = Date.now() + 3000;
    while (childAlive && Date.now() < killDeadline) {
      try {
        process.kill(childPid, 0);
      } catch {
        childAlive = false;
      }
      if (childAlive) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 25);
        await promise;
      }
    }
    expect(childAlive).toBe(false);

    let outsideAlive = true;
    try {
      process.kill(outsidePid!, 0);
    } catch {
      outsideAlive = false;
    }
    expect(outsideAlive).toBe(true);

    await rm(childPidFile, { force: true });
    await transport.close();
  });
});
