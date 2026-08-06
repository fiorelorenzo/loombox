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
   * (see this module's `resolveToolchainRoot`) — e.g. a shared MCP server
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
    const toolchainRoot = resolveToolchainRoot(config.command, pathEnv);
    const readOnly = new Set(options.extraReadOnlyMounts ?? []);
    if (toolchainRoot) readOnly.add(toolchainRoot);

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

/**
 * Best-effort discovery of the read-only directory tree the wrapped
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
 * Heuristic, not exhaustive, and documented as such rather than silently
 * assumed complete: resolves `command` the same way `execvp()` (and so
 * `bwrap`'s own final exec) will — an absolute/relative path used as-is,
 * a bare name searched down `PATH` in order — then follows symlinks
 * (version-manager shims are very often one). If the resolved binary
 * lives directly in a `bin/` directory (the near-universal
 * `<toolchain-root>/bin/<exe>` layout every version manager above uses),
 * mounts the PARENT of `bin/` — the whole toolchain root, e.g. the `lib/
 * node_modules` sibling `npm`/`npx` need beside their own `bin/npx` —
 * rather than just the directory holding the one binary. Anything not
 * fitting that shape still gets its own containing directory mounted,
 * which is correct for a single self-contained binary (this repo's own
 * `omp`) but under-mounts a toolchain split across more than one
 * directory in some OTHER shape — a real, known limitation: an operator
 * hitting it adds the extra path via `extraReadOnlyMounts` themselves.
 * Already-`/usr`-rooted commands (`git`, `sh`, ...) return `undefined`:
 * `buildBubblewrapArgv` mounts `/usr` unconditionally, so naming it again
 * here would be redundant, not incorrect.
 */
function resolveToolchainRoot(command: string, pathEnv: string): string | undefined {
  const candidates = command.includes(path.sep)
    ? [command]
    : pathEnv
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) return undefined;

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }
  if (real === '/usr' || real.startsWith('/usr/')) return undefined;

  const dir = path.dirname(real);
  return path.basename(dir) === 'bin' ? path.dirname(dir) : dir;
}
