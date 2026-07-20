import { detectRemoteOsArch } from './remote-runtime';
import { shQuote, type RemoteTransport } from './remote-transport';

/**
 * Opt-in resident-node systemd installation on an `ssh:` target (issue #89,
 * SPEC §7.22/§7.23/§9; §16's grounding: "Resident daemon (systemd) on Linux
 * — hapi's `docs/guide/installation.md` systemd user-unit templates
 * (`Type=simple`/`Restart=always`/`KillMode=process`) + `systemd.service(5)`"
 * — the generic, standard-library `systemd.service(5)` pattern this cites is
 * reimplemented from scratch here; nothing is copied from hapi, AGPL or
 * otherwise).
 *
 * A **`systemd --user`** unit, deliberately, not a system-wide one: the
 * remote user this node connects as (SPEC §7.23's autodetected SSH login)
 * generally has no sudo, and a resident node has no business needing root —
 * `loginctl enable-linger` is the one extra step a user unit needs to
 * actually start on boot / outlive the login session that installed it
 * (without it, a user unit only runs while that user has an active login
 * session, defeating the whole point of "the driving laptop is off").
 *
 * Follows the exact same **plan/execute split** as `./supervisor-
 * provisioning.ts` and `./remote-runtime.ts`: {@link planSystemdProvisioning}
 * only reads (OS/systemctl presence, the currently-staged unit content) and
 * returns the exact shell commands `execute` would run, in order — shown to
 * the user before anything runs (issue #89's "declining this step still
 * leaves the target fully usable"); {@link executeSystemdProvisioning} is the
 * only function that writes to the remote, and only for an `install`/
 * `update` plan.
 */
export type SystemdProvisionAction = 'noop' | 'install' | 'update' | 'unsupported';

export const DEFAULT_UNIT_NAME = 'loombox-node.service';

export interface SystemdUnitConfig {
  /** Absolute path to the command this unit runs — typically the staged supervisor binary's own resident-node entry point (`./supervisor-provisioning.ts`'s `<baseDir>/supervisor-bin`). */
  execStart: string;
  /** Extra args appended after `execStart`, space-joined as-is (the caller is responsible for any quoting an arg with spaces needs — matches this unit file being plain text, not a shell invocation). */
  execArgs?: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  description?: string;
}

/**
 * Renders a `systemd --user` unit file for `config` — pure string
 * generation, no I/O. Deterministic for the same `config` (object key order
 * for `environment` follows `Object.entries`, so callers passing the same
 * object literal shape get byte-identical output every time), which is what
 * lets {@link planSystemdProvisioning} decide `noop` vs `update` by a plain
 * string comparison against what's already staged on the remote.
 */
export function generateSystemdUnit(config: SystemdUnitConfig): string {
  const execLine = [config.execStart, ...(config.execArgs ?? [])].join(' ');
  const lines = [
    '[Unit]',
    `Description=${config.description ?? 'loombox resident node'}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execLine}`,
    'Restart=always',
    'RestartSec=5',
    'KillMode=process',
  ];
  if (config.workingDirectory) {
    lines.push(`WorkingDirectory=${config.workingDirectory}`);
  }
  for (const [key, value] of Object.entries(config.environment ?? {})) {
    lines.push(`Environment=${key}=${value}`);
  }
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

/** Whether `command` resolves on the remote's `PATH` — also used by `./decommission.ts` (issue #90) to decide whether stop/disable is even worth attempting. */
export async function isCommandPresent(
  transport: RemoteTransport,
  command: string,
): Promise<boolean> {
  const result = await transport.exec(
    `command -v ${command} >/dev/null 2>&1 && echo present || echo missing`,
  );
  return result.stdout.trim() === 'present';
}

/** Resolves `$HOME/.config/systemd/user` on the remote, unless `override` is given. */
export async function resolveSystemdUnitDir(
  transport: RemoteTransport,
  override?: string,
): Promise<string> {
  if (override) return override;
  const result = await transport.exec('printf %s "$HOME/.config/systemd/user"');
  return result.stdout.trim();
}

/** Reads back the currently-staged unit content at `unitPath`, or `undefined` if nothing is staged there yet. */
async function readCurrentUnitContent(
  transport: RemoteTransport,
  unitPath: string,
): Promise<string | undefined> {
  const result = await transport.exec(`cat ${shQuote(unitPath)} 2>/dev/null`);
  return result.stdout.length > 0 ? result.stdout : undefined;
}

export interface SystemdProvisionPlan {
  unitName: string;
  unitPath: string;
  desiredContent: string;
  currentContent: string | undefined;
  /** Whether `systemctl` was found on the remote's `PATH` at all — `false` short-circuits to `action: 'unsupported'` before ever reading/comparing unit content. */
  systemctlPresent: boolean;
  action: SystemdProvisionAction;
  /** The exact shell commands {@link executeSystemdProvisioning} would run, in order — empty for `noop`/`unsupported`. Shown to the user before confirmation (issue #89's "nothing runs on the remote without your confirmation", mirroring `./remote-runtime.ts`'s `RuntimeBootstrapPlan.commands`). */
  commands: string[];
  message: string;
}

export interface PlanSystemdProvisioningOptions {
  unit: SystemdUnitConfig;
  unitName?: string;
  /** Overrides the remote systemd user-unit directory; defaults to `$HOME/.config/systemd/user`. */
  unitDir?: string;
}

/**
 * Detects whether this `ssh:` target can host a resident-node systemd user
 * unit and, if so, whether install/update/nothing is needed to reach
 * `options.unit`'s desired content — without writing anything to the remote.
 * An absent `systemctl` short-circuits to `'unsupported'` (issue #89's
 * "declining ... leaves the target fully usable" applies equally to a host
 * that simply can't run one — the target is never blocked on this).
 */
export async function planSystemdProvisioning(
  transport: RemoteTransport,
  options: PlanSystemdProvisioningOptions,
): Promise<SystemdProvisionPlan> {
  const unitName = options.unitName ?? DEFAULT_UNIT_NAME;
  const unitDir = await resolveSystemdUnitDir(transport, options.unitDir);
  const unitPath = `${unitDir}/${unitName}`;
  const desiredContent = generateSystemdUnit(options.unit);

  const osArch = await detectRemoteOsArch(transport);
  const systemctlPresent =
    osArch.os === 'linux' && (await isCommandPresent(transport, 'systemctl'));

  if (!systemctlPresent) {
    return {
      unitName,
      unitPath,
      desiredContent,
      currentContent: undefined,
      systemctlPresent: false,
      action: 'unsupported',
      commands: [],
      message:
        `loombox can't install a resident-node systemd unit on ${osArch.rawOs} — systemd --user ` +
        "isn't available on this host. Declining leaves the target fully usable, just without " +
        'autonomous continuation/offline-notification benefits (SPEC §7.22).',
    };
  }

  const currentContent = await readCurrentUnitContent(transport, unitPath);
  if (currentContent === desiredContent) {
    return {
      unitName,
      unitPath,
      desiredContent,
      currentContent,
      systemctlPresent,
      action: 'noop',
      commands: [],
      message: `${unitName} is already installed and up to date at ${unitPath}.`,
    };
  }

  const commands = [
    `mkdir -p ${shQuote(unitDir)}`,
    `printf '%s' ${shQuote(desiredContent)} > ${shQuote(unitPath)}`,
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${shQuote(unitName)}`,
    // Lets the user unit keep running (and start on boot) without an active
    // login session — the whole point of a resident node (SPEC §7.22).
    'loginctl enable-linger "$(id -un)"',
  ];

  const action: SystemdProvisionAction = currentContent === undefined ? 'install' : 'update';
  return {
    unitName,
    unitPath,
    desiredContent,
    currentContent,
    systemctlPresent,
    action,
    commands,
    message:
      action === 'install'
        ? `installing resident-node unit ${unitName} at ${unitPath}, enabled to start on boot and restart on failure.`
        : `updating resident-node unit ${unitName} at ${unitPath} to the current configuration.`,
  };
}

export interface SystemdProvisionCommandResult {
  command: string;
  exitCode: number;
  stderr: string;
}

export interface SystemdProvisionResult {
  ok: boolean;
  action: SystemdProvisionAction;
  ranCommands: SystemdProvisionCommandResult[];
  failedAt?: string;
  error?: string;
}

/**
 * Applies `plan` (from {@link planSystemdProvisioning}). `noop` runs nothing
 * and reports success; `unsupported` runs nothing and reports failure (a
 * caller declining/being unable to provision never touches the remote here
 * either way). For `install`/`update`, runs `plan.commands` in order,
 * stopping at the first non-zero exit — a failed step leaves the remote in
 * whatever partial state that step produced, surfaced via `failedAt` rather
 * than silently continuing (mirrors `executeRuntimeBootstrap`'s same
 * contract). On success, re-reads the unit file to confirm the content
 * genuinely landed (the same install-then-verify recipe
 * `./supervisor-provisioning.ts` uses) before reporting `ok: true`.
 */
export async function executeSystemdProvisioning(
  transport: RemoteTransport,
  plan: SystemdProvisionPlan,
): Promise<SystemdProvisionResult> {
  if (plan.action === 'noop') {
    return { ok: true, action: 'noop', ranCommands: [] };
  }
  if (plan.action === 'unsupported') {
    return { ok: false, action: 'unsupported', ranCommands: [], error: plan.message };
  }

  const ranCommands: SystemdProvisionCommandResult[] = [];
  for (const command of plan.commands) {
    const result = await transport.exec(command);
    ranCommands.push({ command, exitCode: result.exitCode, stderr: result.stderr });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        action: plan.action,
        ranCommands,
        failedAt: command,
        error: `command failed (exit ${result.exitCode}): ${result.stderr}`,
      };
    }
  }

  const installedContent = await readCurrentUnitContent(transport, plan.unitPath);
  if (installedContent !== plan.desiredContent) {
    return {
      ok: false,
      action: plan.action,
      ranCommands,
      error: `post-install verification failed: ${plan.unitPath} content does not match what was written`,
    };
  }

  return { ok: true, action: plan.action, ranCommands };
}
