import { homedir } from 'node:os';
import path from 'node:path';

import { createLocalInstallLayoutDriver, type InstallLayoutDriver } from '../install-layout';
import { defaultBaseDirName, defaultUnitName, type NodeEnvironment } from '../node-environment';
import { NODE_BUNDLE_ENTRY_FILE } from '../node-release';
import { LocalProcessTransport } from '../ssh/local-process-transport';
import { shQuote, type RemoteTransport } from '../ssh/remote-transport';
import {
  executeSystemdProvisioning,
  planSystemdProvisioning,
  resolveSystemdUnitDir,
  type SystemdProvisionPlan,
  type SystemdUnitConfig,
} from '../ssh/systemd-provisioning';
import type {
  SupervisorBackend,
  SupervisorBackendAction,
  SupervisorBackendActionResult,
  SupervisorBackendInstallConfig,
  SupervisorBackendInstallResult,
  SupervisorBackendStatus,
  SupervisorBackendUninstallOptions,
} from '../supervisor-backend';

/**
 * The `../supervisor-backend.ts` implementation for a Linux-local node
 * (issue #658, epic #653). Per that issue's own analysis: `../ssh/systemd-
 * provisioning.ts` already generates the right `systemd --user` unit and
 * already has the plan/execute split; `../ssh/local-process-transport.ts`
 * already runs shell commands against THIS machine through the exact same
 * {@link RemoteTransport} shape the ssh backend drives that generator
 * over. So this file adds nothing to unit generation — `generateSystemdUnit`
 * is reused byte-for-byte via `planSystemdProvisioning`/
 * `executeSystemdProvisioning`, unchanged, the same way `../ssh/systemd-
 * supervisor-backend.ts` (the ssh-target sibling this mirrors) does — only
 * the transport differs (that one drives a real `ssh:` host, this one
 * drives `localhost` through a real child process) and, per the paragraph
 * below, whether `loginctl enable-linger` is actually allowed to run.
 * Install-layout staging uses `../install-layout.ts`'s
 * `createLocalInstallLayoutDriver` (real `node:fs`, no shell round trip
 * needed — this machine IS the target, exactly like `../launchd/launchd-
 * supervisor-backend.ts`'s own choice for the same reason), not the
 * `RemoteTransport`-backed driver the ssh backend needs.
 *
 * **The trap this issue calls out by name**: a `systemd --user` unit dies
 * with the last login session and never comes back at boot unless
 * `loginctl enable-linger "$(id -un)"` has been run for this user — and
 * `planSystemdProvisioning` bakes that command unconditionally into every
 * `install`/`update` plan (correct for the ssh path, where the *whole*
 * command list is shown to a human for confirmation before anything runs).
 * A local install has no equivalent "here's what I'm about to run, ok?"
 * moment upstream of this backend, so `install()` never runs that one
 * command silently: {@link SystemdLocalSupervisorBackendOptions.enableLinger}
 * is a required field — a caller MUST have already asked the person sitting
 * at this machine and recorded a real yes/no — and a `false` here means
 * this backend runs every other command in the plan (the unit genuinely
 * gets installed, enabled, and started right now) while skipping only that
 * one, then says so in `install()`'s own message rather than a neutral
 * "installed" that would let a reader assume reboot survival. It never
 * calls `loginctl disable-linger` either way: that setting is per-user, not
 * per-unit, so turning it off on a declined/uninstall could silently break
 * survival for some other lingering unit (this machine's own resident node
 * among them) that this backend has no business touching.
 * {@link SupervisorBackend.survivesReboot} always re-reads the real
 * `is-enabled`/`Linger` state live, so it stays honest regardless of what
 * `install()` was told.
 */
export interface SystemdLocalSupervisorBackendOptions {
  /**
   * Which environment this resident node targets (issue #867; default
   * `'production'`) — the input `unitName`/`baseDir`/`stateDir` defaults
   * derive from, via `../node-environment.ts`, whenever those aren't given
   * explicitly. A caller running a second, `'preview'`-targeted node on a
   * machine that already has a `'production'` one MUST either set this or
   * supply every one of `unitName`/`baseDir`/`stateDir` itself — leaving
   * both unset for two backends on one machine is exactly the collision
   * this field exists to make the operator no longer need to remember.
   */
  environment?: NodeEnvironment;
  unitName?: string;
  /** Overrides `~/.config/systemd/user`; resolved from the real home dir otherwise. */
  unitDir?: string;
  /** Overrides `../node-environment.ts`'s `defaultBaseDirName(environment)` under the real home dir (`../install-layout.ts`'s `baseDir` — the parent of `versions/` and `current`); resolved from `environment` otherwise. */
  baseDir?: string;
  /** Overrides `<baseDir>/node` (this node's own state dir — identity, session history; `uninstall()`'s "everything by default" target unless `keepData`); resolved from the (possibly defaulted) `baseDir` otherwise. */
  stateDir?: string;
  description?: string;
  /** Injectable for tests; defaults to the real `node:fs`+`tar`-backed local driver. */
  installLayoutDriver?: InstallLayoutDriver;
  /**
   * Whether `install()` may run `loginctl enable-linger "$(id -un)"` for
   * this user. No default — see this module's own doc comment for why a
   * caller must resolve this to a real, asked-for yes/no before
   * constructing this backend, never assume one.
   */
  enableLinger: boolean;
}

const LINGER_COMMAND_PREFIX = 'loginctl enable-linger';

/** `plan` with any `loginctl enable-linger` step dropped — every other command (write the unit, `daemon-reload`, `enable --now`) still runs; see this module's own doc comment for why linger alone is gated. */
function withoutLingerStep(plan: SystemdProvisionPlan): SystemdProvisionPlan {
  return { ...plan, commands: plan.commands.filter((c) => !c.startsWith(LINGER_COMMAND_PREFIX)) };
}

async function unitFileExists(transport: RemoteTransport, unitPath: string): Promise<boolean> {
  const result = await transport.exec(`test -f ${shQuote(unitPath)} && echo yes || echo no`);
  return result.stdout.trim() === 'yes';
}

export function createSystemdLocalSupervisorBackend(
  options: SystemdLocalSupervisorBackendOptions,
  transport: RemoteTransport = new LocalProcessTransport(),
): SupervisorBackend {
  const environment = options.environment ?? 'production';
  const unitName = options.unitName ?? defaultUnitName(environment);
  const baseDir = options.baseDir ?? path.join(homedir(), defaultBaseDirName(environment));
  const stateDir = options.stateDir ?? path.join(baseDir, 'node');
  const driver = options.installLayoutDriver ?? createLocalInstallLayoutDriver();

  const resolveUnitPath = async (): Promise<string> => {
    const unitDir = await resolveSystemdUnitDir(transport, options.unitDir);
    return path.join(unitDir, unitName);
  };

  return {
    async install(config: SupervisorBackendInstallConfig): Promise<SupervisorBackendInstallResult> {
      const currentEntryPath = path.join(baseDir, 'current', NODE_BUNDLE_ENTRY_FILE);
      const unitConfig: SystemdUnitConfig = {
        execStart: config.nodeExecutable,
        execArgs: [currentEntryPath, ...(config.args ?? [])],
        environment: config.environment,
        description: options.description ?? 'loombox resident node',
      };
      const rawPlan = await planSystemdProvisioning(transport, {
        unit: unitConfig,
        unitName,
        unitDir: options.unitDir,
      });
      if (rawPlan.action === 'unsupported') {
        return { ok: true, action: 'unsupported', message: rawPlan.message };
      }
      // `rawPlan.action` is 'install' or 'update' here — `planSystemdProvisioning`
      // always includes the linger step for both, never for 'noop'.
      const lingerRequestedByPlan = rawPlan.action !== 'noop';
      const plan = options.enableLinger ? rawPlan : withoutLingerStep(rawPlan);

      const currentVersion = await driver.currentVersion(baseDir);
      const versionChanged = currentVersion !== config.version;
      if (versionChanged) {
        const archive = await config.fetchArchive(config.version);
        await driver.stageVersion(baseDir, config.version, archive);
        await driver.activateVersion(baseDir, config.version);
      }

      if (plan.action !== 'noop') {
        const result = await executeSystemdProvisioning(transport, plan);
        if (!result.ok) {
          return { ok: false, action: plan.action, message: result.error ?? plan.message };
        }
      } else if (versionChanged) {
        // Mirrors `../ssh/systemd-supervisor-backend.ts`'s own comment: the
        // unit content is unchanged but `current/` just moved, and
        // `enable --now` only starts a unit that wasn't already running.
        const restart = await transport.exec(`systemctl --user restart ${shQuote(unitName)}`);
        if (restart.exitCode !== 0) {
          return {
            ok: false,
            action: 'update',
            message: `restart after staging version ${config.version} failed (exit ${restart.exitCode}): ${restart.stderr.trim()}`,
          };
        }
      }

      const action: SupervisorBackendAction =
        !versionChanged && plan.action === 'noop'
          ? 'noop'
          : currentVersion === undefined
            ? 'install'
            : 'update';
      const lingerNote =
        action === 'noop' || !lingerRequestedByPlan
          ? ''
          : options.enableLinger
            ? ' Linger is enabled: this node will survive a reboot.'
            : ' Linger was NOT enabled (declined): this node will NOT survive a reboot — it only restarts after a crash while a login session for this user is open.';
      return {
        ok: true,
        action,
        message:
          (action === 'noop'
            ? `${unitName} is already running version ${config.version}.`
            : `${unitName} is now running version ${config.version} (${plan.message})`) +
          lingerNote,
      };
    },

    async start(): Promise<SupervisorBackendActionResult> {
      const unitPath = await resolveUnitPath();
      if (!(await unitFileExists(transport, unitPath))) {
        return { ok: false, message: `${unitName} is not installed at ${unitPath}` };
      }
      const result = await transport.exec(`systemctl --user start ${shQuote(unitName)}`);
      return result.exitCode === 0
        ? { ok: true, message: `${unitName} started` }
        : {
            ok: false,
            message: `systemctl --user start failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
          };
    },

    async stop(): Promise<SupervisorBackendActionResult> {
      const unitPath = await resolveUnitPath();
      if (!(await unitFileExists(transport, unitPath))) {
        return { ok: true, message: `${unitName} is not installed; nothing to stop` };
      }
      const result = await transport.exec(`systemctl --user stop ${shQuote(unitName)}`);
      return result.exitCode === 0
        ? { ok: true, message: `${unitName} stopped` }
        : {
            ok: false,
            message: `systemctl --user stop failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
          };
    },

    async status(): Promise<SupervisorBackendStatus> {
      const unitPath = await resolveUnitPath();
      if (!(await unitFileExists(transport, unitPath))) {
        return { installed: false, state: 'stopped', message: `${unitName} is not installed` };
      }
      const version = await driver.currentVersion(baseDir);
      const active = await transport.exec(
        `systemctl --user is-active ${shQuote(unitName)} 2>/dev/null`,
      );
      const activeState = active.stdout.trim();
      const state =
        activeState === 'active' ? 'running' : activeState === '' ? 'unknown' : 'stopped';
      return {
        installed: true,
        state,
        version,
        message: `${unitName} is ${activeState || 'unknown'}`,
      };
    },

    async survivesReboot(): Promise<boolean> {
      const unitPath = await resolveUnitPath();
      if (!(await unitFileExists(transport, unitPath))) return false;
      const enabled = await transport.exec(
        `systemctl --user is-enabled ${shQuote(unitName)} 2>/dev/null`,
      );
      if (enabled.stdout.trim() !== 'enabled') return false;
      const linger = await transport.exec('loginctl show-user "$(id -un)" -p Linger 2>/dev/null');
      return linger.stdout.trim() === 'Linger=yes';
    },

    async uninstall(
      uninstallOptions: SupervisorBackendUninstallOptions = {},
    ): Promise<SupervisorBackendActionResult> {
      const unitPath = await resolveUnitPath();
      // Best-effort, exit code never checked — disabling/stopping a unit
      // that isn't currently loaded (or was never installed) exits
      // non-zero too, and that's fine (mirrors `../ssh/systemd-supervisor-
      // backend.ts`'s own uninstall). Linger itself is deliberately left
      // alone — see this module's own doc comment for why.
      await transport.exec(`systemctl --user disable --now ${shQuote(unitName)} 2>/dev/null`);
      await transport.exec(`rm -f ${shQuote(unitPath)}`);
      await transport.exec(
        `rm -f ${shQuote(path.join(baseDir, 'current'))} && rm -rf ${shQuote(path.join(baseDir, 'versions'))}`,
      );
      if (!uninstallOptions.keepData) {
        await transport.exec(`rm -rf ${shQuote(stateDir)}`);
      }
      return {
        ok: true,
        message: uninstallOptions.keepData
          ? `${unitName} uninstalled; state dir preserved (keepData)`
          : `${unitName} uninstalled; installed code and state dir removed`,
      };
    },
  };
}
