import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  markSandboxed,
  type AcpSpawnConfig,
  type SandboxedSpawnConfig,
} from '@loombox/providers-core';

import {
  detectSandboxCapability,
  sandboxCommand,
  SandboxUnavailableError,
  type SandboxCapability,
} from './linux-sandbox';

/**
 * The integration layer between `linux-sandbox.ts`'s bare `bwrap` primitive
 * and a real session (SPEC §7.17; issue #257): decides whether THIS host
 * requires sandboxing at all, and if so, builds the
 * `AgentSupervisorStartOptions.wrapSpawnConfig` hook a `local` session's
 * launch path (`node-daemon.ts`'s `launchLocalSession`) passes straight
 * through to `AgentSupervisor.start()`.
 *
 * **The platform split this issue's acceptance bar asks for.** Linux is
 * where sandboxing is REQUIRED (SPEC §7.17: "optional must not mean off by
 * default once it ships" — see `permission-policy.ts`'s doc comment for why
 * that line is about sandboxing, not the permission policy itself): a
 * missing/refused `bwrap` here throws {@link SandboxUnavailableError}
 * rather than returning a hook that quietly does nothing, so a caller that
 * doesn't handle the throw cannot accidentally launch a session unsandboxed.
 * Any other platform (macOS today; no Windows backend either) is where
 * SPEC's "documented weaker fallback" applies — a fallback this issue does
 * not build — so `required` comes back `false` and `wrapSpawnConfig` is
 * left `undefined`: the caller runs the session exactly as it did before
 * this module existed, not refused. That is a real, load-bearing boundary,
 * not an oversight: forcing every non-Linux host to refuse every local
 * session the moment this module was wired in would turn on a hard failure
 * for a platform with no way to satisfy it yet.
 *
 * **`ssh:` targets never reach this module at all.** An `ssh:` session's
 * agent process runs on the remote target machine
 * (`node-daemon.ts`'s `launchReservedSshSession`, via
 * `AgentSupervisor.startWithChild()`), whose mount namespace this process
 * has no way to touch — bind-mounting a "local worktree" makes no sense
 * against a machine this process isn't running on. Confining THAT agent
 * would need the sandbox primitive to run remotely, over the SSH
 * transport, which is out of scope here; the `ssh:` path keeps working
 * exactly as it already does, unsandboxed, same as before this issue.
 */
export interface ResolveSessionSandboxOptions {
  /** The session's own worktree (`Session.worktreePath`) — the sole directory the sandboxed agent process can write to. */
  workspacePath: string;
  /**
   * Extra read-only paths beyond the base OS layout (`/usr`, `/etc`; see
   * `buildBubblewrapArgv`) and the auto-discovered agent-toolchain root
   * (see this module's `resolveToolchainMounts`) — e.g. a shared MCP server
   * binary this session's provider also needs to see.
   */
  extraReadOnlyMounts?: readonly string[];
  /**
   * Extra read-write paths beyond the workspace — a deliberate, documented
   * exception (see `SandboxMounts.readWrite`'s own doc comment), e.g. an
   * npm/npx package-cache directory an operator has decided is safe to
   * share across sessions. Empty by default: this function never widens
   * the writable surface on its own.
   */
  extraReadWriteMounts?: readonly string[];
  /** Overridable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Overridable for tests; defaults to a real `detectSandboxCapability()` call. */
  capability?: SandboxCapability;
  /** Overridable for tests; defaults to `process.env.PATH`. */
  pathEnv?: string;
}

export interface SessionSandboxResolution {
  /** Whether THIS platform is one where SPEC requires sandboxing (Linux) as opposed to the documented, not-yet-built fallback (everywhere else). */
  readonly required: boolean;
  readonly capability: SandboxCapability;
  /** Present only when `required` is `true` — `undefined` on a platform where sandboxing isn't required, so this session runs exactly as it did before this module existed rather than being refused. */
  readonly wrapSpawnConfig?: (config: AcpSpawnConfig) => SandboxedSpawnConfig;
}

/**
 * Resolves this host's sandboxing story for one session, and — on a host
 * where sandboxing is required — either returns a working
 * {@link SessionSandboxResolution.wrapSpawnConfig} hook or throws
 * {@link SandboxUnavailableError}. Never returns a `wrapSpawnConfig` that
 * would silently no-op: on Linux without a working `bwrap`, this function
 * itself is the fail-closed gate — call it BEFORE any spawn attempt (as
 * `launchLocalSession` does), and let its throw propagate into the same
 * `sendSessionStatus(id, 'error', …)` path an ordinary spawn failure
 * already takes, so the client sees the session refused rather than
 * silently unconfined.
 */
export function resolveSessionSandbox(
  options: ResolveSessionSandboxOptions,
): SessionSandboxResolution {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    return {
      required: false,
      capability: {
        available: false,
        backend: 'none',
        reason:
          `namespace/bind-mount sandboxing (bubblewrap) is Linux-only; this host reports ` +
          `platform "${platform}" — SPEC §7.17's documented weaker macOS fallback isn't built ` +
          'yet, so this session runs unsandboxed rather than being refused',
      },
    };
  }

  const capability = options.capability ?? detectSandboxCapability();
  if (!capability.available) {
    // Fail closed (issue #257's non-negotiable constraint): Linux is where
    // sandboxing is required, so an unavailable sandbox here refuses the
    // session outright rather than falling back to running it unconfined.
    throw new SandboxUnavailableError(capability.reason ?? 'no sandbox backend available');
  }

  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const wrapSpawnConfig = (config: AcpSpawnConfig): SandboxedSpawnConfig => {
    const readOnly = new Set(options.extraReadOnlyMounts ?? []);
    for (const root of resolveToolchainMounts(config.command, pathEnv)) readOnly.add(root);

    const sandboxed = sandboxCommand({
      command: config.command,
      args: config.args,
      mounts: {
        readWrite: [options.workspacePath, ...(options.extraReadWriteMounts ?? [])],
        readOnly: [...readOnly],
      },
      chdir: options.workspacePath,
      capability,
    });
    return markSandboxed({ ...config, command: sandboxed.command, args: sandboxed.args });
  };

  return { required: true, capability, wrapSpawnConfig };
}

/** `/usr`-rooted paths are already covered unconditionally by `buildBubblewrapArgv` — naming one again would be redundant, not incorrect. */
function isUnderUsr(dir: string): boolean {
  return dir === '/usr' || dir.startsWith('/usr/');
}

/**
 * For a resolved executable path, the directory a caller should mount so
 * `execvpe` can find it: the near-universal `<toolchain-root>/bin/<exe>`
 * layout every version manager (mise, nvm, volta, homebrew) AND every npm
 * package's own `bin/` folder uses gets its `bin/`'s PARENT mounted (the
 * whole toolchain root); anything else gets its own containing directory.
 * Never elevates past a `bin/` directory sitting directly under the
 * filesystem root (`/bin`, `/sbin`) — that would compute `/` itself as
 * the "toolchain root", which is exactly the wide-open mount this whole
 * primitive exists to rule out. `resolveToolchainMounts`'s own `/usr`
 * early-return already handles the common merged-`/usr` case where this
 * would otherwise trigger (`/bin` is a symlink to `usr/bin`); this is the
 * defensive fallback for a non-merged-`/usr` distro, where `/bin` is a
 * real, separate directory `buildBubblewrapArgv` already `--ro-bind`s on
 * its own — mounting it again here is a harmless duplicate, not a hole.
 */
function toolchainRootFor(resolvedPath: string): string {
  const dir = path.dirname(resolvedPath);
  const elevatesToFilesystemRoot = path.dirname(dir) === path.sep;
  return path.basename(dir) === 'bin' && !elevatesToFilesystemRoot ? path.dirname(dir) : dir;
}

/**
 * Best-effort discovery of the read-only directory tree(s) the wrapped
 * command's OWN interpreter/toolchain needs to even `exec` inside the
 * sandbox — beyond `/usr`/`/etc`, which `buildBubblewrapArgv` already
 * covers unconditionally. Without this, a command resolved from a
 * version-manager install (mise, nvm, volta, homebrew's per-formula
 * cellar — none of which live under `/usr`; this very dev box's own
 * `node`/`npx`/`omp` resolve under `~/.local/share/mise/installs/...`)
 * would `execvp()`-fail with ENOENT inside the sandbox even though the
 * identical `PATH` lookup succeeds outside it — silently making every
 * real agent spawn un-launchable, not just a theoretical gap.
 *
 * **Always mounts the exact directory a `PATH` search would find
 * `command` in first** (`bwrap`'s own final `execvpe` re-does that same
 * `PATH` search fresh inside the new mount namespace — the file has to
 * actually be there, not just resolvable to something real on the host).
 * This is not optional even when that entry is itself a symlink: verified
 * against this project's own real `npx` (issue #257's acceptance bar
 * asks for exactly this kind of real-agent proof, not a synthetic one) —
 * `<node-root>/bin/npx` is a *relative* symlink to `../lib/node_modules/
 * npm/bin/npx-cli.js`, so mounting only the symlink's resolved TARGET
 * directory (an earlier version of this function did exactly that) left
 * `<node-root>/bin/` itself absent from the sandbox — `bwrap: execvp
 * npx: No such file or directory`, even though the eventual target was
 * perfectly visible. `toolchainRootFor` walks the `PATH`-resolved
 * location up through a `bin/` parent (covering the common
 * `<root>/bin/<exe>` shape, mounting the whole root rather than just
 * `bin/`), which — for a same-root RELATIVE symlink like `npx` above —
 * already covers the resolved target too, no second mount needed.
 *
 * A symlink whose target escapes that root entirely (a genuine
 * version-manager SHIM pointing at a separate, differently-versioned
 * install elsewhere) gets that target's own `toolchainRootFor` mounted
 * as a second, additional root — real, verified via this module's own
 * shim-symlink test. Heuristic, not exhaustive, and documented as such
 * rather than silently assumed complete: a toolchain split across
 * directories in some OTHER shape than "PATH entry" (+ optionally "one
 * symlink hop to elsewhere") under-mounts — an operator hitting that adds
 * the extra path via `extraReadOnlyMounts` themselves.
 */
function resolveToolchainMounts(command: string, pathEnv: string): string[] {
  const candidates = command.includes(path.sep)
    ? [command]
    : pathEnv
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) return [];

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }
  // The merged-`/usr` common case: `/bin/sh`'s real target is
  // `/usr/bin/sh` — already visible via `buildBubblewrapArgv`'s
  // unconditional `/usr` mount plus its `/bin -> usr/bin` symlink, so
  // both the PATH-resolved location AND its target already exist inside
  // the sandbox with no extra work, and no risk of `toolchainRootFor`
  // ever computing `/bin`'s "parent" as a mount root.
  if (isUnderUsr(real)) return [];

  const roots = new Set<string>();
  const originalRoot = toolchainRootFor(resolved);
  if (!isUnderUsr(originalRoot)) roots.add(originalRoot);

  const alreadyCovered = real === resolved || real.startsWith(`${originalRoot}${path.sep}`);
  if (!alreadyCovered) {
    const realRoot = toolchainRootFor(real);
    if (!isUnderUsr(realRoot)) roots.add(realRoot);
  }
  return [...roots];
}
