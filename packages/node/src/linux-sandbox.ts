import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

/**
 * The Linux namespace/bind-mount sandbox primitive (SPEC §7.17's "design
 * toward namespace/bind-mount scoping to the session's worktree"; issue
 * #257): confines a real child process to an explicit set of bind mounts
 * via `bwrap` (bubblewrap — the unprivileged sandboxing tool Flatpak itself
 * runs on, chosen over a hand-rolled `unshare`+`pivot_root` sequence
 * because it already solves the same "no root, no setuid" constraint this
 * issue names, is present on this dev box and any mainstream Linux distro
 * that ships Flatpak support, and is a single well-audited binary this
 * module only ever shells out to — never linked, forked, or vendored, so
 * its own (LGPL-2.1) license never touches this MIT tree). No Windows/macOS
 * backend exists here on purpose: see `session-sandbox.ts`'s doc comment
 * for the platform split this issue's acceptance bar itself asks for.
 *
 * **What "confined" means, concretely.** {@link buildBubblewrapArgv} does
 * not carve a hole in an otherwise-open filesystem (a `--ro-bind / /`
 * would satisfy "the worktree is writable" but not "a read outside the
 * worktree is denied" — SPEC's own acceptance bar for this issue). It
 * builds the sandboxed root up from nothing: only `/usr`, `/etc`,
 * `/proc`, a fresh `/dev`, a fresh `/tmp`, and the caller's explicit
 * {@link SandboxMounts} exist inside it at all. A path that was never
 * bind-mounted does not exist in there — a read gets `ENOENT`, not
 * `EACCES`, and a write gets "no such file or directory" for the same
 * reason. Verified live on this box (not just asserted): a real `sh -c`
 * child confined to one directory got `cat: No such file or directory`
 * reading a sibling directory's file, and `cannot create ...: Directory
 * nonexistent` writing into it — the host file was untouched afterward.
 *
 * **Network is deliberately left shared** (`--share-net` after
 * `--unshare-all`). This issue is about filesystem scoping; the
 * project's own `PermissionPolicy` (`permission-policy.ts`) already owns
 * the network-destination allow/deny dimension, one layer up
 * (`PolicyEnforcedExecutionTarget`/`PolicyEnforcedPty`) — duplicating a
 * second, cruder network gate here (an all-or-nothing namespace) would
 * conflict with, not reinforce, that existing policy surface, which this
 * issue's own instructions say never to bypass or duplicate.
 */

/** Which sandbox implementation, if any, this host can actually run. `'none'` covers both "no backend exists for this platform" (non-Linux) and "the backend exists but this kernel refuses it" (see {@link SandboxCapability.reason}) — a caller only ever needs to branch on `available`, not on why. */
export type SandboxBackend = 'bubblewrap' | 'none';

/** The result of asking "can this host actually sandbox a process right now" — never a guess: `available: true` only follows a real, executed self-test (see {@link detectSandboxCapability}), not merely finding the `bwrap` binary on `PATH`. */
export interface SandboxCapability {
  readonly available: boolean;
  readonly backend: SandboxBackend;
  /** Human-readable, always set when `available` is `false` — this is the string `resolveSessionSandbox`'s refusal / degraded-mode log line surfaces verbatim, so it must already read like an operator-facing explanation, not an error code. */
  readonly reason?: string;
}

export interface DetectSandboxCapabilityOptions {
  /** Defaults to `process.platform`. Overridable so a test can exercise the "non-Linux" branch without needing a second OS. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env.PATH`. Overridable so a test can exercise "bwrap not on PATH" deterministically instead of depending on this host's actual install state. */
  pathEnv?: string;
  /** Replaces the real self-test spawn. Overridable so a test can exercise "bwrap is present but this kernel refuses unprivileged namespaces" (a real, seen-in-production failure mode — AppArmor's 2024 `unprivileged_userns_clone` lockdown on some distros) without needing a kernel that's actually broken this way. */
  probe?: (bwrapPath: string) => boolean;
}

const BWRAP_BIN = 'bwrap';

/**
 * The real functional check: actually unshares user+mount+pid+ipc+uts
 * namespaces, bind-mounts `/usr` read-only inside the fresh root, and
 * runs `/usr/bin/true` — not just `bwrap --version`, which only proves
 * the binary exists and would still report success on a kernel that has
 * unprivileged user namespaces disabled entirely. A 5s timeout treats a
 * hang the same as a failure (`spawnSync`'s `status` stays `null`) rather
 * than blocking session creation indefinitely on a wedged sandbox host.
 */
function realBubblewrapSelfTest(bwrapPath: string): boolean {
  const result = spawnSync(
    bwrapPath,
    [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--die-with-parent',
      '--ro-bind',
      '/usr',
      '/usr',
      '--proc',
      '/proc',
      '--',
      '/usr/bin/true',
    ],
    { timeout: 5000 },
  );
  return result.status === 0 && !result.error;
}

/**
 * Cached across calls with no override (capability detection spawns a
 * real process — issue #516's "an unbounded/repeated spawn" lesson
 * applies here too, and a host's sandbox capability cannot change within
 * one daemon process's lifetime). Any override argument bypasses the
 * cache entirely, so tests never see a stale result from an earlier test
 * in the same run.
 */
let cachedCapability: SandboxCapability | undefined;

export function detectSandboxCapability(
  options: DetectSandboxCapabilityOptions = {},
): SandboxCapability {
  const usesDefaults =
    options.platform === undefined && options.pathEnv === undefined && options.probe === undefined;
  if (usesDefaults && cachedCapability) return cachedCapability;

  const platform = options.platform ?? process.platform;
  const capability = computeCapability(
    platform,
    options.pathEnv ?? process.env.PATH ?? '',
    options.probe,
  );
  if (usesDefaults) cachedCapability = capability;
  return capability;
}

function computeCapability(
  platform: NodeJS.Platform,
  pathEnv: string,
  probe?: (bwrapPath: string) => boolean,
): SandboxCapability {
  if (platform !== 'linux') {
    return {
      available: false,
      backend: 'none',
      reason: `namespace/bind-mount sandboxing (bubblewrap) is Linux-only; this host reports platform "${platform}"`,
    };
  }
  const bwrapDirs = pathEnv.split(path.delimiter).filter(Boolean);
  const bwrapPath = bwrapDirs
    .map((dir) => path.join(dir, BWRAP_BIN))
    .find((candidate) => existsSync(candidate));
  if (!bwrapPath) {
    return {
      available: false,
      backend: 'none',
      reason: 'bubblewrap ("bwrap") is not installed on PATH',
    };
  }
  const ok = (probe ?? realBubblewrapSelfTest)(bwrapPath);
  if (!ok) {
    return {
      available: false,
      backend: 'none',
      reason:
        'bubblewrap is installed but could not create an unprivileged user+mount namespace on ' +
        'this kernel (kernel.unprivileged_userns_clone=0, or an AppArmor/seccomp policy ' +
        'restricting unprivileged user namespaces, are the two known causes)',
    };
  }
  return { available: true, backend: 'bubblewrap' };
}

/** Test-only escape hatch: clears the process-lifetime cache {@link detectSandboxCapability} otherwise keeps for its no-override call shape. */
export function resetSandboxCapabilityCacheForTests(): void {
  cachedCapability = undefined;
}

/** Thrown wherever this module is asked to sandbox a command but {@link SandboxCapability.available} is false — the fail-closed signal every caller in this codebase (`SandboxedExecutionTarget.exec()`, `session-sandbox.ts`'s `resolveSessionSandbox` on Linux) treats as "refuse, never spawn unsandboxed". */
export class SandboxUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`sandbox unavailable: ${reason}`);
    this.name = 'SandboxUnavailableError';
  }
}

/** One side of the bind-mount plan: `local` filesystem paths, identity-mapped (mounted at the same absolute path inside the sandbox as outside it), so neither the wrapped command's own argv nor its cwd need rewriting. */
export interface SandboxMounts {
  /** Writable inside the sandbox — the session worktree always belongs here; anything else added here (e.g. an `npx` cache dir) is a deliberate, documented exception, never a default-wide-open directory. */
  readWrite: readonly string[];
  /** Visible but read-only inside the sandbox. */
  readOnly: readonly string[];
}

export interface BuildSandboxedCommandOptions {
  command: string;
  args: readonly string[];
  mounts: SandboxMounts;
  /** Working directory the wrapped command starts in, once inside the sandbox (bubblewrap's own `--chdir`) — independent of whatever `cwd` the OUTER `bwrap` process itself is spawned with, which never affects containment since every mount/argv path here is already absolute. Must be visible under `mounts.readWrite`/`mounts.readOnly` or the command starts somewhere `ENOENT` denies it from ever seeing. */
  chdir: string;
}

/** Real host directories a merged-`/usr` layout (Debian/Ubuntu/Fedora and most modern distros) expresses as symlinks into `/usr`, mapped to the `usr`-relative target `--symlink` recreates inside the sandbox; a distro that keeps one of these as a real, separate directory instead gets an honest `--ro-bind` for it instead (checked via `lstatSync` below). */
const MERGED_USR_LINKS: Record<string, string> = {
  '/bin': 'usr/bin',
  '/sbin': 'usr/sbin',
  '/lib': 'usr/lib',
  '/lib32': 'usr/lib32',
  '/lib64': 'usr/lib64',
};

/**
 * Builds the real `bwrap` argv that confines `command`/`args` to
 * `mounts` — pure and synchronous beyond a handful of `existsSync`/
 * `lstatSync` checks against this host's own base OS layout (so a
 * distro without `/lib64`, or without merged-`/usr` symlinks, still gets
 * a correct plan rather than a `bwrap` invocation naming a path that
 * doesn't exist here). Does not itself spawn anything — {@link
 * sandboxCommand} is the fail-closed entry point every caller actually
 * uses.
 */
export function buildBubblewrapArgv(options: BuildSandboxedCommandOptions): string[] {
  const argv: string[] = [
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];

  if (existsSync('/usr')) argv.push('--ro-bind', '/usr', '/usr');
  if (existsSync('/etc')) argv.push('--ro-bind', '/etc', '/etc');

  for (const [link, usrRelativeTarget] of Object.entries(MERGED_USR_LINKS)) {
    if (!existsSync(link)) continue;
    let linkIsSymlink: boolean;
    try {
      linkIsSymlink = lstatSync(link).isSymbolicLink();
    } catch {
      linkIsSymlink = false;
    }
    if (linkIsSymlink) {
      argv.push('--symlink', usrRelativeTarget, link);
    } else {
      argv.push('--ro-bind', link, link);
    }
  }

  for (const dir of new Set(options.mounts.readOnly)) {
    argv.push('--ro-bind', dir, dir);
  }
  for (const dir of new Set(options.mounts.readWrite)) {
    argv.push('--bind', dir, dir);
  }

  argv.push('--chdir', options.chdir);
  argv.push('--', options.command, ...options.args);
  return argv;
}

export interface SandboxedSpawn {
  readonly command: string;
  readonly args: string[];
}

/**
 * The fail-closed entry point: wraps `command`/`args` to run confined to
 * `mounts` via bubblewrap, or throws {@link SandboxUnavailableError} —
 * never returns a "wrapped" command that is actually unsandboxed. A
 * caller that wants graceful degradation instead (SPEC §7.17's
 * documented macOS fallback) makes that choice itself, one layer up
 * (`session-sandbox.ts`'s `resolveSessionSandbox`), by not calling this
 * function at all on a platform where sandboxing isn't required.
 */
export function sandboxCommand(
  options: BuildSandboxedCommandOptions & { capability: SandboxCapability },
): SandboxedSpawn {
  if (!options.capability.available) {
    throw new SandboxUnavailableError(options.capability.reason ?? 'no sandbox backend available');
  }
  return { command: 'bwrap', args: buildBubblewrapArgv(options) };
}
