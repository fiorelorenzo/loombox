import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createLocalInstallLayoutDriver, type InstallLayoutDriver } from '../install-layout';
import { defaultBaseDirName, defaultLaunchdLabel, type NodeEnvironment } from '../node-environment';
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
import {
  executeLaunchdProvisioning,
  planLaunchdProvisioning,
  type LaunchdAgentConfig,
  type LaunchdIo,
} from './launchd-provisioning';

/**
 * The `../supervisor-backend.ts` implementation for a macOS-local node
 * (issue #654). Wraps `./launchd-provisioning.ts` unchanged for plist
 * generation and the plan/execute install cycle, and `../install-layout.ts`'s
 * `createLocalInstallLayoutDriver` for decision A1-2's versioned bundle
 * staging — the same install-layout primitive the ssh-side backend
 * (`../ssh/systemd-supervisor-backend.ts`) uses, just the local driver
 * instead of the remote one, since there is no transport to a macOS-local
 * node: it runs on the very machine this code runs on.
 *
 * `RunAtLoad`/`KeepAlive` (`./launchd-provisioning.ts`'s own defaults)
 * mean a successful `install`/`update` already leaves the resident node
 * running — matches `../supervisor-backend.ts`'s own `install()` contract.
 */
export interface LaunchdSupervisorBackendOptions {
  /**
   * Which environment this resident node targets (issue #867; default
   * `'production'`) — the input `label`/`baseDir`/`stateDir` defaults
   * derive from, via `../node-environment.ts`, whenever those aren't given
   * explicitly. A caller running a second, `'preview'`-targeted node on a
   * Mac that already has a `'production'` one MUST either set this or
   * supply every one of `label`/`baseDir`/`stateDir` itself — leaving both
   * unset for two backends on one machine is exactly the collision this
   * field exists to make the operator no longer need to remember.
   */
  environment?: NodeEnvironment;
  label?: string;
  /** Overrides `~/Library/LaunchAgents`; resolved from `io.homeDir()` otherwise. */
  agentsDir?: string;
  /** Overrides `../node-environment.ts`'s `defaultBaseDirName(environment)` under `io.homeDir()` (`../install-layout.ts`'s `baseDir` — the parent of `versions/` and `current`); resolved from `environment` otherwise. */
  baseDir?: string;
  /** Overrides `<baseDir>/node` (this node's own state dir — identity, session history; `uninstall()`'s "everything by default" target unless `keepData`); resolved from the (possibly defaulted) `baseDir` otherwise. */
  stateDir?: string;
  /** Injectable for tests; defaults to the real `node:fs`-backed local driver. */
  installLayoutDriver?: InstallLayoutDriver;
}

const RUN_AT_LOAD_TRUE_PATTERN = /<key>RunAtLoad<\/key>\s*<true\s*\/>/;
const PRINT_STATE_RUNNING_PATTERN = /state\s*=\s*running/;

export function createLaunchdSupervisorBackend(
  io: LaunchdIo,
  options: LaunchdSupervisorBackendOptions = {},
): SupervisorBackend {
  const environment = options.environment ?? 'production';
  const label = options.label ?? defaultLaunchdLabel(environment);
  const agentsDir = options.agentsDir ?? join(io.homeDir(), 'Library', 'LaunchAgents');
  const plistPath = join(agentsDir, `${label}.plist`);
  const baseDir = options.baseDir ?? join(io.homeDir(), defaultBaseDirName(environment));
  const stateDir = options.stateDir ?? join(baseDir, 'node');
  const driver = options.installLayoutDriver ?? createLocalInstallLayoutDriver();
  const domainTarget = `gui/${io.uid()}`;
  const serviceTarget = `${domainTarget}/${label}`;

  return {
    async install(config: SupervisorBackendInstallConfig): Promise<SupervisorBackendInstallResult> {
      const currentEntryPath = join(baseDir, 'current', NODE_BUNDLE_ENTRY_FILE);
      const agentConfig: LaunchdAgentConfig = {
        execStart: config.nodeExecutable,
        execArgs: [currentEntryPath, ...(config.args ?? [])],
        environment: config.environment,
        label,
      };
      const plan = planLaunchdProvisioning(io, { agent: agentConfig, agentsDir });
      if (plan.action === 'unsupported') {
        return { ok: true, action: 'unsupported', message: plan.message };
      }

      const currentVersion = await driver.currentVersion(baseDir);
      const versionChanged = currentVersion !== config.version;
      if (versionChanged) {
        const archive = await config.fetchArchive(config.version);
        await driver.stageVersion(baseDir, config.version, archive);
        await driver.activateVersion(baseDir, config.version);
      }

      if (plan.action !== 'noop') {
        const result = await executeLaunchdProvisioning(io, plan);
        if (!result.ok) {
          return { ok: false, action: plan.action, message: result.error ?? plan.message };
        }
      } else if (versionChanged) {
        // `KeepAlive` relaunches on exit, but the plist content itself
        // hasn't changed, so nothing tells launchd to restart the
        // already-running process just because `current` moved underneath
        // it — `kickstart -k` forces exactly that restart.
        const restart = await io.launchctl(['kickstart', '-k', serviceTarget]);
        if (restart.exitCode !== 0) {
          return {
            ok: false,
            action: 'update',
            message: `launchctl kickstart failed after staging version ${config.version} (exit ${restart.exitCode}): ${restart.stderr}`,
          };
        }
      }

      const action: SupervisorBackendAction =
        !versionChanged && plan.action === 'noop'
          ? 'noop'
          : currentVersion === undefined
            ? 'install'
            : 'update';
      return {
        ok: true,
        action,
        message:
          action === 'noop'
            ? `${label} is already running version ${config.version}.`
            : `${label} is now running version ${config.version} (${plan.message})`,
      };
    },

    async start(): Promise<SupervisorBackendActionResult> {
      if (io.readFile(plistPath) === undefined) {
        return { ok: false, message: `${label} is not installed at ${plistPath}` };
      }
      const kickstart = await io.launchctl(['kickstart', '-k', serviceTarget]);
      if (kickstart.exitCode === 0) {
        return { ok: true, message: `${label} started` };
      }
      // `kickstart` can't start a job that isn't currently bootstrapped in
      // (e.g. after `stop()`'s `bootout`) — fall back to the same
      // bootstrap+enable pair `install()`'s own install/update path uses.
      const bootstrap = await io.launchctl(['bootstrap', domainTarget, plistPath]);
      if (bootstrap.exitCode !== 0) {
        return {
          ok: false,
          message: `launchctl bootstrap failed (exit ${bootstrap.exitCode}): ${bootstrap.stderr}`,
        };
      }
      const enable = await io.launchctl(['enable', serviceTarget]);
      return enable.exitCode === 0
        ? { ok: true, message: `${label} started` }
        : {
            ok: false,
            message: `launchctl enable failed (exit ${enable.exitCode}): ${enable.stderr}`,
          };
    },

    async stop(): Promise<SupervisorBackendActionResult> {
      if (io.readFile(plistPath) === undefined) {
        return { ok: true, message: `${label} is not installed; nothing to stop` };
      }
      // Exit code never checked, same precedent `executeLaunchdProvisioning`'s
      // own `update` path uses for `bootout`: unloading a job that isn't
      // currently loaded exits non-zero too, and that's not a failure here.
      const result = await io.launchctl(['bootout', serviceTarget]);
      return {
        ok: true,
        message: result.exitCode === 0 ? `${label} stopped` : `${label} was not running`,
      };
    },

    async status(): Promise<SupervisorBackendStatus> {
      if (io.readFile(plistPath) === undefined) {
        return { installed: false, state: 'stopped', message: `${label} is not installed` };
      }
      const version = await driver.currentVersion(baseDir);
      const print = await io.launchctl(['print', serviceTarget]);
      if (print.exitCode !== 0) {
        return { installed: true, state: 'stopped', version, message: `${label} is not loaded` };
      }
      const state = PRINT_STATE_RUNNING_PATTERN.test(print.stdout) ? 'running' : 'stopped';
      return {
        installed: true,
        state,
        version,
        message: state === 'running' ? `${label} is running` : `${label} is loaded but not running`,
      };
    },

    async survivesReboot(): Promise<boolean> {
      const content = io.readFile(plistPath);
      if (content === undefined || !RUN_AT_LOAD_TRUE_PATTERN.test(content)) return false;
      const print = await io.launchctl(['print', serviceTarget]);
      return print.exitCode === 0;
    },

    async uninstall(
      uninstallOptions: SupervisorBackendUninstallOptions = {},
    ): Promise<SupervisorBackendActionResult> {
      // Best-effort, exit code never checked — see `stop()`'s own comment.
      await io.launchctl(['bootout', serviceTarget]);
      io.removeFile(plistPath);
      await rm(join(baseDir, 'current'), { force: true });
      await rm(join(baseDir, 'versions'), { recursive: true, force: true });
      if (!uninstallOptions.keepData) {
        await rm(stateDir, { recursive: true, force: true });
      }
      return {
        ok: true,
        message: uninstallOptions.keepData
          ? `${label} uninstalled; state dir preserved (keepData)`
          : `${label} uninstalled; installed code and state dir removed`,
      };
    },
  };
}
