import path from 'node:path';

/**
 * The invariant issue #929 names, checked wherever this package generates a
 * process-supervisor unit: whatever `execStart` (+ `execArgs`) launches
 * MUST be the daemon process itself, never a wrapper that forks it and
 * returns. Both supervisors this package generates units for track exactly
 * one pid as "the job" — `systemd-provisioning.ts`'s `KillMode=process`
 * signals only that pid (deliberately: so a stop never reaches the
 * session-scoped agent processes the daemon itself spawns), and `launchd-
 * provisioning.ts`'s `KeepAlive` restarts the job the instant that pid
 * exits. A forking wrapper in front breaks both the same way: the real
 * incident behind this issue was `tsx`'s CLI, which forks the actual
 * daemon and returns — the wrapper's own exit is what `KillMode=process`
 * signals / what `launchd` sees as "the job exited", while the daemon it
 * forked keeps running, reparented, unsupervised by either mechanism, and
 * still answering as the same node identity. Two processes serving one
 * identity, indefinitely, because nothing then notices.
 *
 * There is no way to prove "this command execs the daemon directly and
 * never forks" from a string alone — this is a deny-list of the concrete
 * dev-loop wrapper CLIs known to fork (`tsx` chief among them, the exact
 * one that bit production), not a general static analysis. Every
 * unit-generating function in this package (`systemd-provisioning.ts`'s
 * `generateSystemdUnit`, `launchd-provisioning.ts`'s `generateLaunchdPlist`
 * — the two #658/#654 both build on) calls
 * {@link assertDirectDaemonEntrypoint} unconditionally before rendering, so
 * every caller of either — remote `ssh:` provisioning, the Linux-local
 * backend, and the launchd backend alike — is covered by construction,
 * with nothing further for a new call site to opt into.
 */
const KNOWN_FORKING_WRAPPER_NAMES: Record<string, true> = {
  tsx: true,
  'ts-node': true,
  'ts-node-dev': true,
  'ts-node-esm': true,
  nodemon: true,
  pm2: true,
  forever: true,
};

/** Strips one trailing JS/TS extension (`.mjs`/`.cjs`/`.mts`/`.cts`/`.js`/`.ts`) so a path segment like `tsx.mjs` or `cli.cjs` still compares against {@link KNOWN_FORKING_WRAPPER_NAMES} on its real stem. */
function stripKnownExtension(segment: string): string {
  return segment.replace(/\.[cm]?[jt]s$/i, '');
}

/**
 * Throws if `execStart` or any `execArgs` entry names a known forking
 * wrapper, anywhere in its path (`.../node_modules/tsx/dist/cli.mjs` — the
 * real production shape issue #929 found — names it in a path segment, not
 * the final basename, since the actual `ExecStart` there was plain `node`
 * with the wrapper appearing as an argument).
 */
export function assertDirectDaemonEntrypoint(
  execStart: string,
  execArgs: readonly string[] = [],
): void {
  for (const candidate of [execStart, ...execArgs]) {
    for (const segment of candidate.split(/[/\\]/)) {
      if (segment.length === 0) continue;
      const stem = stripKnownExtension(segment).toLowerCase();
      if (stem in KNOWN_FORKING_WRAPPER_NAMES) {
        throw new Error(
          `assertDirectDaemonEntrypoint: "${candidate}" names "${stem}", a known forking ` +
            "process wrapper (issue #929: tsx's CLI forks the real daemon and returns, so " +
            "KillMode=process/launchd's KeepAlive only ever supervises the wrapper — the " +
            'daemon it forked survives every restart, reparented and unsupervised, still ' +
            "answering as the same node identity). Point execStart/execArgs at the daemon's " +
            `own entry point directly (e.g. \`node ${path.join('current', 'node.mjs')}\`, never ` +
            'a dev-loop runner in front of it).',
        );
      }
    }
  }
}
