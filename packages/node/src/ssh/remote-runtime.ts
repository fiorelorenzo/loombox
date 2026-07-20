import type { RemoteTransport } from './remote-transport';

/** Normalized remote OS/architecture (issue #85, SPEC §7.23 step 3: "it detects the remote OS/arch"). `rawOs`/`rawArch` keep `uname`'s own strings for display/debugging even when normalization can't place them into a known `os`/`arch`. */
export interface RemoteOsArch {
  os: 'linux' | 'darwin' | 'unknown';
  arch: 'x64' | 'arm64' | 'unknown';
  rawOs: string;
  rawArch: string;
}

function normalizeOs(rawOs: string): RemoteOsArch['os'] {
  if (rawOs === 'Linux') return 'linux';
  if (rawOs === 'Darwin') return 'darwin';
  return 'unknown';
}

function normalizeArch(rawArch: string): RemoteOsArch['arch'] {
  if (rawArch === 'x86_64' || rawArch === 'amd64') return 'x64';
  if (rawArch === 'aarch64' || rawArch === 'arm64') return 'arm64';
  return 'unknown';
}

/**
 * Detects the remote host's OS/architecture with a single `uname -s -m` call
 * (issue #85's acceptance: "Detected OS/arch is reported to the user before
 * anything is installed" — this is that detection step, read-only, no
 * install side effects).
 */
export async function detectRemoteOsArch(transport: RemoteTransport): Promise<RemoteOsArch> {
  const result = await transport.exec('uname -s -m');
  const [rawOs = '', rawArch = ''] = result.stdout.trim().split(/\s+/);
  return { os: normalizeOs(rawOs), arch: normalizeArch(rawArch), rawOs, rawArch };
}

/** A supported target for the mise-based bootstrap below (every platform mise itself ships an installer for). An `unknown` os or arch is never supported — SPEC's "or the user is told it needs manual install on an unsupported host". */
function isSupportedOsArch(osArch: RemoteOsArch): boolean {
  return osArch.os !== 'unknown' && osArch.arch !== 'unknown';
}

async function commandIsPresent(transport: RemoteTransport, command: string): Promise<boolean> {
  const result = await transport.exec(
    `command -v ${command} >/dev/null 2>&1 && echo present || echo missing`,
  );
  return result.stdout.trim() === 'present';
}

export type RuntimeBootstrapAction = 'noop' | 'install_mise_and_node' | 'unsupported';

/**
 * The outcome of {@link planRuntimeBootstrap}: what was detected, what (if
 * anything) needs installing, and — critically — the exact commands that
 * *would* run, without having run them yet. Issue #85's "shows exactly what
 * it is about to do before running it, and nothing runs without explicit
 * user confirmation" is a caller-side contract this package can't enforce by
 * itself (there is no UI here); the plan/execute split is what makes it
 * possible: a caller shows `commands/message` to the user and only calls
 * {@link executeRuntimeBootstrap} after getting an explicit yes.
 */
export interface RuntimeBootstrapPlan {
  osArch: RemoteOsArch;
  nodePresent: boolean;
  misePresent: boolean;
  supported: boolean;
  action: RuntimeBootstrapAction;
  /** Shell commands that would run, in order, to install what's missing. Empty for `noop`/`unsupported`. */
  commands: string[];
  /** Human-readable summary of the plan, meant to be shown to the user before confirmation. */
  message: string;
}

export interface PlanRuntimeBootstrapOptions {
  /** The mise-managed Node version to install/pin globally if bootstrapping; defaults to `'22'` (this repo's own baseline, AGENTS.md). */
  nodeVersion?: string;
}

/**
 * Detects OS/arch and whether `node`/`mise` are already resolvable on the
 * remote, and decides what (if anything) needs bootstrapping (issue #85).
 * Read-only beyond the two `command -v` probes and the `uname` call — it
 * never installs anything itself; see {@link executeRuntimeBootstrap} for
 * that, gated on the caller having shown this plan to the user first.
 */
export async function planRuntimeBootstrap(
  transport: RemoteTransport,
  options: PlanRuntimeBootstrapOptions = {},
): Promise<RuntimeBootstrapPlan> {
  const nodeVersion = options.nodeVersion ?? '22';
  const osArch = await detectRemoteOsArch(transport);
  const nodePresent = await commandIsPresent(transport, 'node');
  const misePresent = await commandIsPresent(transport, 'mise');
  const supported = isSupportedOsArch(osArch);

  if (!supported) {
    return {
      osArch,
      nodePresent,
      misePresent,
      supported,
      action: 'unsupported',
      commands: [],
      message:
        `loombox doesn't know how to bootstrap the runtime on ${osArch.rawOs}/${osArch.rawArch} — ` +
        'this host needs Node and the agent CLI installed manually before it can be used as an ssh: target.',
    };
  }

  if (nodePresent) {
    return {
      osArch,
      nodePresent,
      misePresent,
      supported,
      action: 'noop',
      commands: [],
      message: `node is already on PATH on ${osArch.rawOs}/${osArch.rawArch} — nothing to bootstrap.`,
    };
  }

  const commands = [
    'curl -fsSL https://mise.run | sh',
    `"$HOME/.local/bin/mise" install node@${nodeVersion} && "$HOME/.local/bin/mise" use -g node@${nodeVersion}`,
  ];

  return {
    osArch,
    nodePresent,
    misePresent,
    supported,
    action: 'install_mise_and_node',
    commands,
    message:
      `node is not on PATH on ${osArch.rawOs}/${osArch.rawArch}. loombox will install mise ` +
      `(https://mise.run) and use it to install and pin Node ${nodeVersion} globally. ` +
      'Review the exact commands below before confirming.',
  };
}

export interface RuntimeBootstrapCommandResult {
  command: string;
  exitCode: number;
  stderr: string;
}

export interface RuntimeBootstrapResult {
  ok: boolean;
  ranCommands: RuntimeBootstrapCommandResult[];
  /** The command that failed, if any (only set when `ok` is `false` and at least one command actually ran). */
  failedAt?: string;
}

/**
 * Runs `plan.commands` in order, stopping at the first non-zero exit (issue
 * #85's bootstrap is not "try everything and hope" — a failed step means the
 * remote is left in whatever partial state that step produced, surfaced via
 * `failedAt` rather than silently continuing). Never called by
 * {@link planRuntimeBootstrap} itself: this function is the only one that
 * touches the remote beyond detection, so a caller gating it on explicit
 * user confirmation (issue #85's "nothing runs without explicit user
 * confirmation") is enough to satisfy that contract — this function does not
 * (and, being UI-less, cannot) prompt on its own.
 *
 * A `noop` plan runs nothing and reports success; an `unsupported` plan
 * refuses outright and reports failure — both without ever touching
 * `transport`.
 */
export async function executeRuntimeBootstrap(
  transport: RemoteTransport,
  plan: RuntimeBootstrapPlan,
): Promise<RuntimeBootstrapResult> {
  if (plan.action === 'noop') {
    return { ok: true, ranCommands: [] };
  }
  if (plan.action === 'unsupported') {
    return { ok: false, ranCommands: [] };
  }

  const ranCommands: RuntimeBootstrapCommandResult[] = [];
  for (const command of plan.commands) {
    const result = await transport.exec(command);
    ranCommands.push({ command, exitCode: result.exitCode, stderr: result.stderr });
    if (result.exitCode !== 0) {
      return { ok: false, ranCommands, failedAt: command };
    }
  }
  return { ok: true, ranCommands };
}
