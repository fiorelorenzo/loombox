import path from 'node:path';

import { createRemoteInstallLayoutDriver } from '../install-layout';
import { NODE_BUNDLE_ENTRY_FILE } from '../node-release';
import type {
  SupervisorBackend,
  SupervisorBackendAction,
  SupervisorBackendActionResult,
  SupervisorBackendInstallConfig,
  SupervisorBackendInstallResult,
  SupervisorBackendStatus,
  SupervisorBackendUninstallOptions,
} from '../supervisor-backend';
import { shQuote, type RemoteTransport } from './remote-transport';
import {
  DEFAULT_UNIT_NAME,
  executeSystemdProvisioning,
  planSystemdProvisioning,
  resolveSystemdUnitDir,
  type SystemdUnitConfig,
} from './systemd-provisioning';

/**
 * The `./supervisor-backend.ts` implementation for an `ssh:` target
 * (issue #654). Wraps `./systemd-provisioning.ts` unchanged — this file
 * adds nothing to unit generation itself, only the install-layout staging
 * (decision A1-2, `../install-layout.ts`'s `createRemoteInstallLayoutDriver`)
 * and the start/stop/status/uninstall/survivesReboot vocabulary that
 * module doesn't own. Not wired into `./provision-target.ts`'s own
 * `provision()` (that keeps calling `planSystemdProvisioning`/
 * `executeSystemdProvisioning` directly, exactly as it does today — see
 * this issue's own "existing ssh provisioning behaviour is unchanged"
 * acceptance criterion), and deliberately does not need to be: this class
 * is the seam's ssh-side proof, exercised by its own tests below and ready
 * for a future caller (e.g. `./decommission.ts`'s eventual A1-2 migration,
 * out of this issue's scope) to adopt without inventing a second seam.
 */
export interface SystemdSshSupervisorBackendOptions {
  unitName?: string;
  /** Overrides `$HOME/.config/systemd/user`; resolved on the remote otherwise. */
  unitDir?: string;
  /** Overrides `$HOME/.loombox` (`../install-layout.ts`'s `baseDir` — the parent of `versions/` and `current`); resolved on the remote otherwise. */
  baseDir?: string;
  /** Overrides `$HOME/.loombox/node` (this node's own state dir — identity, session history; `uninstall()`'s "everything by default" target unless `keepData`); resolved on the remote otherwise. */
  stateDir?: string;
  description?: string;
}

async function resolveHomeSubdir(transport: RemoteTransport, subpath: string): Promise<string> {
  const result = await transport.exec(`printf %s "$HOME/${subpath}"`);
  return result.stdout.trim();
}

async function unitFileExists(transport: RemoteTransport, unitPath: string): Promise<boolean> {
  const result = await transport.exec(`test -f ${shQuote(unitPath)} && echo yes || echo no`);
  return result.stdout.trim() === 'yes';
}

export function createSystemdSshSupervisorBackend(
  transport: RemoteTransport,
  options: SystemdSshSupervisorBackendOptions = {},
): SupervisorBackend {
  const unitName = options.unitName ?? DEFAULT_UNIT_NAME;

  const resolveUnitPath = async (): Promise<string> => {
    const unitDir = await resolveSystemdUnitDir(transport, options.unitDir);
    return `${unitDir}/${unitName}`;
  };
  const resolveBaseDir = async (): Promise<string> =>
    options.baseDir ?? resolveHomeSubdir(transport, '.loombox');
  const resolveStateDir = async (): Promise<string> =>
    options.stateDir ?? resolveHomeSubdir(transport, '.loombox/node');

  return {
    async install(config: SupervisorBackendInstallConfig): Promise<SupervisorBackendInstallResult> {
      const baseDir = await resolveBaseDir();
      const currentEntryPath = path.posix.join(baseDir, 'current', NODE_BUNDLE_ENTRY_FILE);
      const unitConfig: SystemdUnitConfig = {
        execStart: config.nodeExecutable,
        execArgs: [currentEntryPath, ...(config.args ?? [])],
        environment: config.environment,
        description: options.description ?? 'loombox resident node',
      };
      const unitPlan = await planSystemdProvisioning(transport, {
        unit: unitConfig,
        unitName,
        unitDir: options.unitDir,
      });
      if (unitPlan.action === 'unsupported') {
        return { ok: true, action: 'unsupported', message: unitPlan.message };
      }

      const driver = createRemoteInstallLayoutDriver(transport);
      const currentVersion = await driver.currentVersion(baseDir);
      const versionChanged = currentVersion !== config.version;
      if (versionChanged) {
        const archive = await config.fetchArchive(config.version);
        await driver.stageVersion(baseDir, config.version, archive);
        await driver.activateVersion(baseDir, config.version);
      }

      if (unitPlan.action !== 'noop') {
        const unitResult = await executeSystemdProvisioning(transport, unitPlan);
        if (!unitResult.ok) {
          return {
            ok: false,
            action: unitPlan.action,
            message: unitResult.error ?? unitPlan.message,
          };
        }
      } else if (versionChanged) {
        // The service registration is unchanged, but the code under
        // `current/` just moved — `systemctl enable --now` only starts a
        // unit that wasn't already running, so an unchanged-but-running
        // unit needs an explicit restart to pick up the new symlink target.
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
        !versionChanged && unitPlan.action === 'noop'
          ? 'noop'
          : currentVersion === undefined
            ? 'install'
            : 'update';
      return {
        ok: true,
        action,
        message:
          action === 'noop'
            ? `${unitName} is already running version ${config.version}.`
            : `${unitName} is now running version ${config.version} (${unitPlan.message})`,
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
      const baseDir = await resolveBaseDir();
      const driver = createRemoteInstallLayoutDriver(transport);
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
      const baseDir = await resolveBaseDir();
      // Best-effort, exit code never checked — disabling/stopping a unit
      // that isn't currently loaded (or was never installed) exits
      // non-zero too, and that's fine (mirrors `./launchd-provisioning.ts`'s
      // own "the point is just nothing of the old copy is left" comment).
      await transport.exec(`systemctl --user disable --now ${shQuote(unitName)} 2>/dev/null`);
      await transport.exec(`rm -f ${shQuote(unitPath)}`);
      await transport.exec(
        `rm -f ${shQuote(path.posix.join(baseDir, 'current'))} && rm -rf ${shQuote(path.posix.join(baseDir, 'versions'))}`,
      );
      if (!uninstallOptions.keepData) {
        const stateDir = await resolveStateDir();
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
