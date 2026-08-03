import { mkdtempSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalProcessTransport } from './local-process-transport';

/**
 * Kills every real process a `RemoteProcessRunner` in `setsid` mode has left
 * running under `home`'s `.loombox/remote-sessions` (`<baseDir>/<runId>/pid`,
 * see `remote-process-runner.ts`'s `paths()`), then removes `home` itself.
 *
 * This exists because `NodeDaemon.close()` deliberately does NOT kill a
 * session's detached remote agent (issue #80: a real remote host's agent
 * must survive the driving node closing so a later reattach still works),
 * so any test that stands a real local process in for "the remote" via
 * `LocalProcessTransport` leaks that process on every run, pass or fail,
 * unless something else reaps it (issue #518). Sweeping every pidfile under
 * `home` rather than tracking individual runners/handles means this stays
 * correct even when a test throws before its own assertions run.
 */
async function reapDetachedRemoteSessions(home: string): Promise<void> {
  const baseDir = path.join(home, '.loombox', 'remote-sessions');
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return; // baseDir was never created: no ssh: session launched under it.
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const pidPath = path.join(baseDir, entry.name, 'pid');
        let pid: number;
        try {
          pid = Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10);
        } catch {
          return; // never reached `setsid ... &`, or already reaped.
        }
        if (!Number.isInteger(pid) || pid <= 0) return;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already exited (e.g. a test that already called `runner.stop()`
          // itself) — nothing left to kill.
        }
      }),
  );
}

export interface RemoteSessionsSandbox {
  /**
   * Builds a `LocalProcessTransport` whose spawned shell sees its own
   * private, unique `HOME`, so `RemoteProcessRunner`'s un-overridable
   * default baseDir (`$HOME/.loombox/remote-sessions`) never collides with
   * another transport's — including one built by this same sandbox for a
   * *different* simulated remote host in the same test (e.g. a cross-node
   * lease-handoff test creating two `LocalProcessTransport`s for what it
   * treats as two distinct real machines). Reusing one shared `HOME` across
   * both would make a second `launch()` under the same session id silently
   * overwrite the first run's pidfile, orphaning the first process beyond
   * anything a pidfile sweep could ever find again. One private `HOME` per
   * transport is also what keeps every sweep confined to processes this
   * test alone launched, never another concurrent suite's (this box
   * regularly runs several worktrees at once, issue #518).
   */
  createTransport(): LocalProcessTransport;
  /** Kills every process every `createTransport()` call on this sandbox still has running, and removes their private `HOME`s. Call once per test, in `afterEach`, after `node?.close()`. */
  close(): Promise<void>;
}

export function openRemoteSessionsSandbox(): RemoteSessionsSandbox {
  const homes: string[] = [];

  return {
    createTransport() {
      // Sync, not `mkdtemp`'s async form: `sshTransportFactory` is a plain
      // synchronous `(config) => RemoteTransport` (`node-daemon.ts`'s
      // `NodeDaemonOptions`) — nothing downstream awaits building the
      // transport itself, only its later `exec()` calls.
      const home = mkdtempSync(path.join(tmpdir(), 'loombox-remote-sessions-home-'));
      homes.push(home);
      return new LocalProcessTransport({ env: { ...process.env, HOME: home } });
    },
    async close() {
      await Promise.all(homes.map(reapDetachedRemoteSessions));
      await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
      homes.length = 0;
    },
  };
}
