import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireNodeLock,
  NODE_LOCK_FILE_NAME,
  NodeLockCorruptError,
  NodeLockHeldError,
} from './node-lock';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-lock-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('acquireNodeLock (unit)', () => {
  it('writes a lock file recording this process as the holder', () => {
    const lock = acquireNodeLock({ stateDir, nodeId: 'test-node' });
    expect(existsSync(lock.path)).toBe(true);
    const content = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number; nodeId: string };
    expect(content.pid).toBe(process.pid);
    expect(content.nodeId).toBe('test-node');
    lock.release();
  });

  it('a second acquire against an already-held state dir throws NodeLockHeldError naming the live holder', () => {
    const lock = acquireNodeLock({ stateDir, nodeId: 'holder' });
    try {
      acquireNodeLock({ stateDir, nodeId: 'contender' });
      expect.fail('expected acquireNodeLock to throw NodeLockHeldError');
    } catch (error) {
      expect(error).toBeInstanceOf(NodeLockHeldError);
      expect((error as NodeLockHeldError).holderPid).toBe(process.pid);
      expect((error as NodeLockHeldError).holderNodeId).toBe('holder');
    }
    lock.release();
  });

  it('release() removes the lock file, freeing the state dir for a fresh acquire', () => {
    const lock = acquireNodeLock({ stateDir });
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    acquireNodeLock({ stateDir }).release();
  });

  it('release() is idempotent — calling it twice is a silent no-op', () => {
    const lock = acquireNodeLock({ stateDir });
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("release() leaves an already-reclaimed lock alone instead of deleting a different, live holder's file", () => {
    const lock = acquireNodeLock({ stateDir });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate this acquisition's holder having been perceived stale and
    // stolen from elsewhere — the lock file now belongs to someone else.
    writeFileSync(
      lock.path,
      JSON.stringify({
        pid: 999_999,
        nodeId: 'someone-else',
        hostname: 'x',
        acquiredAt: new Date().toISOString(),
        token: 'a-different-token',
      }),
    );
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('a corrupted lock file is refused rather than silently treated as stale and stolen', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, NODE_LOCK_FILE_NAME), 'not json at all');
    expect(() => acquireNodeLock({ stateDir })).toThrow(NodeLockCorruptError);
  });

  it('a lock recorded for a process that has already exited is treated as stale and reclaimed', async () => {
    // A real, short-lived child process, fully reaped (Node waits/reaps its
    // own spawned children internally) before this test reads it back —
    // guarantees `process.kill(deadPid, 0)` throws ESRCH, the exact
    // staleness signal a hard-killed daemon's lock relies on.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const { promise, resolve } = Promise.withResolvers<void>();
    dead.once('exit', resolve);
    await promise;
    const deadPid = dead.pid;
    if (deadPid === undefined) throw new Error('expected the fixture child to have a pid');

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, NODE_LOCK_FILE_NAME),
      JSON.stringify({
        pid: deadPid,
        nodeId: 'ghost',
        hostname: 'x',
        acquiredAt: new Date().toISOString(),
        token: 't',
      }),
    );

    const lock = acquireNodeLock({ stateDir, nodeId: 'reclaimer' });
    const content = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number };
    expect(content.pid).toBe(process.pid);
    lock.release();
  });

  const bootIdAvailable = (() => {
    if (process.platform !== 'linux') return false;
    try {
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!bootIdAvailable)(
    'a lock recorded under a different boot id is treated as stale even for a currently-live pid (Linux only — the reboot case a pid-liveness check alone cannot see)',
    () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, NODE_LOCK_FILE_NAME),
        JSON.stringify({
          pid: process.pid, // genuinely alive right now — a pid-only check would call this live.
          nodeId: 'pre-reboot-ghost',
          hostname: 'x',
          bootId: 'not-the-real-boot-id',
          acquiredAt: new Date().toISOString(),
          token: 't',
        }),
      );
      acquireNodeLock({ stateDir }).release();
    },
  );
});

// Real two-process proof, issue #929's own acceptance bar: a fixture child
// process (`../test/fixtures/node-lock-holder.ts`) runs the actual
// `acquireNodeLock` under test in a genuine OS process, launched via
// `node --import tsx/esm` — never the forking `tsx` CLI wrapper, which
// would blur the exact distinction this issue is about (this test's
// `child_process.spawn` pid needs to be the process actually holding the
// lock).
const HOLDER_FIXTURE = path.join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'node-lock-holder.ts',
);

interface Holder {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout(): string;
  stderr(): string;
}

function spawnHolder(dir: string): Holder {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', HOLDER_FIXTURE, dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForLocked(holder: Holder): Promise<number> {
  await vi.waitFor(
    () => {
      if (/LOCKED pid=\d+/.test(holder.stdout())) return;
      if (holder.child.exitCode !== null || holder.child.signalCode !== null) {
        throw new Error(
          `holder exited before acquiring the lock (code=${String(holder.child.exitCode)} ` +
            `signal=${String(holder.child.signalCode)}); stdout=${holder.stdout()} stderr=${holder.stderr()}`,
        );
      }
      throw new Error('not locked yet');
    },
    { timeout: 10_000, interval: 50 },
  );
  const match = /LOCKED pid=(\d+)/.exec(holder.stdout());
  if (!match)
    throw new Error(`unreachable: matched above but not on re-check; stdout=${holder.stdout()}`);
  return Number(match[1]);
}

async function waitForExit(holder: Holder): Promise<void> {
  await vi.waitFor(
    () => {
      if (holder.child.exitCode === null && holder.child.signalCode === null)
        throw new Error('still running');
    },
    { timeout: 10_000, interval: 50 },
  );
}

describe('acquireNodeLock (real two-process integration, issue #929 acceptance)', () => {
  const spawned: Holder[] = [];

  afterEach(() => {
    for (const holder of spawned) {
      if (holder.child.exitCode === null && holder.child.signalCode === null) {
        holder.child.kill('SIGKILL');
      }
    }
    spawned.length = 0;
  });

  it(
    'a second node process against an already-held state dir fails loudly at startup, naming the live holder',
    { retry: 0, timeout: 20_000 },
    async () => {
      const holderA = spawnHolder(stateDir);
      spawned.push(holderA);
      const pidA = await waitForLocked(holderA);

      const holderB = spawnHolder(stateDir);
      spawned.push(holderB);
      await waitForExit(holderB);

      expect(holderB.child.exitCode).toBe(1);
      expect(holderB.stderr()).toContain('REFUSED');
      expect(holderB.stderr()).toContain('NodeLockHeldError');
      expect(holderB.stderr()).toContain(`pid=${pidA}`);

      // The refused contender never touched the winner — still up, still
      // holding the lock. Two processes serving one identity, caught in
      // under a second instead of surviving 15 hours (issue #929).
      expect(holderA.child.exitCode).toBeNull();
      expect(holderA.child.signalCode).toBeNull();
    },
  );

  it(
    "a hard-killed node's lock does not block the next start",
    { retry: 0, timeout: 20_000 },
    async () => {
      const holderA = spawnHolder(stateDir);
      spawned.push(holderA);
      const pidA = await waitForLocked(holderA);

      holderA.child.kill('SIGKILL');
      await waitForExit(holderA);
      expect(holderA.child.signalCode).toBe('SIGKILL');

      const holderC = spawnHolder(stateDir);
      spawned.push(holderC);
      const pidC = await waitForLocked(holderC);

      expect(pidC).not.toBe(pidA);
      expect(pidC).toBe(holderC.child.pid);

      // The lock on disk reflects the new holder, not a stale relic of the
      // killed one — the next restart genuinely recovers rather than
      // wedging forever behind a lockfile the dead process can never
      // release.
      const lockContent = JSON.parse(
        readFileSync(path.join(stateDir, NODE_LOCK_FILE_NAME), 'utf8'),
      ) as {
        pid: number;
      };
      expect(lockContent.pid).toBe(pidC);
    },
  );
});
