import { rm, rmdir, unlink } from 'node:fs/promises';
import path, { win32 } from 'node:path';

import { createWindowsInstallLayoutDriver, type InstallLayoutDriver } from '../install-layout';
import {
  defaultBaseDirName,
  defaultWindowsTaskName,
  type NodeEnvironment,
} from '../node-environment';
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
  executeWindowsTaskProvisioning,
  planWindowsTaskProvisioning,
  type WindowsTaskConfig,
  type WindowsTaskIo,
} from './windows-provisioning';

/**
 * The `../supervisor-backend.ts` implementation for a Windows-local node
 * (issue #659, epic #653; the third and last local platform, filling in
 * the seam #654 introduced and #658 already proved a second time). Wraps
 * `./windows-provisioning.ts` unchanged for task-XML/launcher-script
 * generation and the plan/execute install cycle, and
 * `../install-layout.ts`'s `createWindowsInstallLayoutDriver` — not
 * `createLocalInstallLayoutDriver`, the one both #654 and #658 use — for
 * decision A1-2's versioned bundle staging: `activateVersion`'s directory
 * *junction* swap instead of a plain symlink, because a symlink needs
 * either admin or Developer Mode on Windows and issue #659 says a
 * zero-touch local install must not require either. See that driver's own
 * doc comment for the rest of what a junction changes.
 *
 * `LogonTrigger` + `RestartOnFailure` (`./windows-provisioning.ts`'s own
 * defaults) mean a successful `install`/`update` already leaves the
 * resident node running — matches `../supervisor-backend.ts`'s own
 * `install()` contract, the same way `../launchd/launchd-supervisor-
 * backend.ts`'s `RunAtLoad`/`KeepAlive` do, even though the *mechanism*
 * that gets there differs (an explicit `/Run` after `/Create`, since a
 * `LogonTrigger` alone only fires at the next logon — see `./windows-
 * provisioning.ts`'s own top doc comment).
 */
export interface WindowsSupervisorBackendOptions {
  /**
   * Which environment this resident node targets (issue #867; default
   * `'production'`) — the input `taskName`/`baseDir`/`stateDir` defaults
   * derive from, via `../node-environment.ts`, whenever those aren't given
   * explicitly. A caller running a second, `'preview'`-targeted node on a
   * Windows machine that already has a `'production'` one MUST either set
   * this or supply every one of `taskName`/`baseDir`/`stateDir` itself —
   * leaving both unset for two backends on one machine is exactly the
   * collision this field exists to make the operator no longer need to
   * remember.
   */
  environment?: NodeEnvironment;
  taskName?: string;
  /** Overrides `%LOCALAPPDATA%`; resolved from `io.localAppData()` otherwise. */
  localAppDataDir?: string;
  /** Overrides `../node-environment.ts`'s `defaultBaseDirName(environment)` under the resolved `%LOCALAPPDATA%` (`../install-layout.ts`'s `baseDir` — the parent of `versions/` and `current`, and also where this backend keeps its own `task.xml`/`run.cmd`); resolved from `environment` otherwise. */
  baseDir?: string;
  /** Overrides `<baseDir>\node` (this node's own state dir — identity, session history; `uninstall()`'s "everything by default" target unless `keepData`); resolved from the (possibly defaulted) `baseDir` otherwise. */
  stateDir?: string;
  description?: string;
  /** Injectable for tests; defaults to the real `node:fs`+`tar`-backed junction driver. */
  installLayoutDriver?: InstallLayoutDriver;
}

const STATUS_LINE_PATTERN = /^Status:\s*(.+)\s*$/im;
const TASK_STATE_DISABLED_PATTERN = /^Scheduled Task State:\s*Disabled\s*$/im;

export function createWindowsSupervisorBackend(
  io: WindowsTaskIo,
  options: WindowsSupervisorBackendOptions = {},
): SupervisorBackend {
  const environment = options.environment ?? 'production';
  const taskName = options.taskName ?? defaultWindowsTaskName(environment);
  const localAppDataDir = options.localAppDataDir ?? io.localAppData();
  const baseDir = options.baseDir ?? win32.join(localAppDataDir, defaultBaseDirName(environment));
  const stateDir = options.stateDir ?? win32.join(baseDir, 'node');
  const driver = options.installLayoutDriver ?? createWindowsInstallLayoutDriver();
  const taskXmlPath = win32.join(baseDir, 'task.xml');
  const launcherPath = win32.join(baseDir, 'run.cmd');

  const isInstalled = (): boolean => io.readFile(taskXmlPath) !== undefined;

  return {
    async install(config: SupervisorBackendInstallConfig): Promise<SupervisorBackendInstallResult> {
      const currentEntryPath = win32.join(baseDir, 'current', NODE_BUNDLE_ENTRY_FILE);
      const taskConfig: WindowsTaskConfig = {
        execStart: config.nodeExecutable,
        execArgs: [currentEntryPath, ...(config.args ?? [])],
        environment: config.environment,
        taskName,
        description: options.description ?? 'loombox resident node',
        userId: io.userId(),
      };
      const plan = planWindowsTaskProvisioning(io, { task: taskConfig, scriptDir: baseDir });
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
        const result = await executeWindowsTaskProvisioning(io, plan);
        if (!result.ok) {
          return { ok: false, action: plan.action, message: result.error ?? plan.message };
        }
      } else if (versionChanged) {
        // Task XML/launcher content is unchanged but `current` just moved
        // underneath it — mirrors `../launchd/launchd-supervisor-
        // backend.ts`'s own `kickstart -k` comment: nothing else tells
        // Task Scheduler to relaunch an already-running process just
        // because the junction target changed, so this backend forces it.
        const end = await io.schtasks(['/End', '/TN', taskName]);
        void end; // best-effort — ending an already-stopped task exits non-zero too
        const run = await io.schtasks(['/Run', '/TN', taskName]);
        if (run.exitCode !== 0) {
          return {
            ok: false,
            action: 'update',
            message: `restart after staging version ${config.version} failed (exit ${run.exitCode}): ${run.stderr}`,
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
            ? `${taskName} is already running version ${config.version}.`
            : `${taskName} is now running version ${config.version} (${plan.message})`,
      };
    },

    async start(): Promise<SupervisorBackendActionResult> {
      if (!isInstalled()) {
        return { ok: false, message: `${taskName} is not installed at ${taskXmlPath}` };
      }
      const result = await io.schtasks(['/Run', '/TN', taskName]);
      return result.exitCode === 0
        ? { ok: true, message: `${taskName} started` }
        : {
            ok: false,
            message: `schtasks /Run failed (exit ${result.exitCode}): ${result.stderr}`,
          };
    },

    async stop(): Promise<SupervisorBackendActionResult> {
      if (!isInstalled()) {
        return { ok: true, message: `${taskName} is not installed; nothing to stop` };
      }
      // Exit code never checked, same precedent `executeWindowsTaskProvisioning`'s
      // own `update` path uses for `/End`: ending a task that isn't currently
      // running exits non-zero too, and that's not a failure here.
      const result = await io.schtasks(['/End', '/TN', taskName]);
      return {
        ok: true,
        message: result.exitCode === 0 ? `${taskName} stopped` : `${taskName} was not running`,
      };
    },

    async status(): Promise<SupervisorBackendStatus> {
      if (!isInstalled()) {
        return { installed: false, state: 'stopped', message: `${taskName} is not installed` };
      }
      const version = await driver.currentVersion(baseDir);
      const query = await io.schtasks(['/Query', '/TN', taskName, '/FO', 'LIST']);
      if (query.exitCode !== 0) {
        return {
          installed: true,
          state: 'unknown',
          version,
          message: `schtasks /Query failed (exit ${query.exitCode}): ${query.stderr}`,
        };
      }
      // `/FO LIST`'s field names are English-locale text, not a stable,
      // documented machine format — a real limitation of `schtasks.exe`
      // (there is no locale-independent plain-text query mode). A status
      // line this doesn't recognize is `'unknown'`, never guessed at —
      // exactly what `SupervisorRunState`'s own doc comment names
      // `'unknown'` for: "this backend's platform tool can't distinguish
      // running from crashed-but-registered."
      const statusText = STATUS_LINE_PATTERN.exec(query.stdout)?.[1]?.trim();
      const state =
        statusText === 'Running' ? 'running' : statusText === 'Ready' ? 'stopped' : 'unknown';
      return {
        installed: true,
        state,
        version,
        message: statusText
          ? `${taskName} is ${statusText}`
          : `${taskName} status could not be determined from schtasks output`,
      };
    },

    async survivesReboot(): Promise<boolean> {
      if (!isInstalled()) return false;
      const desiredContent = io.readFile(taskXmlPath);
      if (desiredContent === undefined || !desiredContent.includes('<LogonTrigger>')) return false;
      const query = await io.schtasks(['/Query', '/TN', taskName, '/FO', 'LIST']);
      if (query.exitCode !== 0) return false;
      return !TASK_STATE_DISABLED_PATTERN.test(query.stdout);
    },

    async uninstall(
      uninstallOptions: SupervisorBackendUninstallOptions = {},
    ): Promise<SupervisorBackendActionResult> {
      // Best-effort, exit code never checked — same precedent `stop()`'s
      // own comment sets. `/Delete /F` also stops a still-running instance
      // first, but `/End` first keeps the same explicit-then-idempotent
      // shape `../launchd/launchd-supervisor-backend.ts`'s own `uninstall`
      // uses (`bootout` then remove the plist).
      await io.schtasks(['/End', '/TN', taskName]);
      await io.schtasks(['/Delete', '/TN', taskName, '/F']);
      io.removeFile(taskXmlPath);
      io.removeFile(launcherPath);

      // `current` is a directory *junction* (`../install-layout.ts`'s own
      // `createWindowsInstallLayoutDriver`), never a plain symlink —
      // `rm(..., { recursive: true })` is actively unsafe here: Node's
      // recursive removal walks a directory's *contents* via `readdir`,
      // which for a reparse point would recurse straight through into the
      // real files the junction points at and delete those, not just the
      // reparse point itself. `rmdir` is the correct, narrow removal —
      // exactly the same dance `../install-layout.ts`'s own
      // `activateVersion` already does, duplicated here rather than
      // shared, since `InstallLayoutDriver` deliberately has no "remove
      // everything" fifth verb (see that interface's own doc comment).
      //
      // `path.join` (ambient), not `win32.join`, for these two lines only
      // — matching exactly what `driver`'s own internals use to build the
      // same `current`/`versions` locations it staged (identical to
      // `win32.join` on a real Windows host, where ambient `node:path`
      // already IS `path.win32`; only a real, injected non-Windows driver
      // in a test could tell the two apart, and this backend must clean
      // up whatever `driver` actually wrote, not a second, independently
      // reconstructed guess at where that was).
      const currentLink = path.join(baseDir, 'current');
      try {
        await rmdir(currentLink);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (code === 'ENOTDIR') {
          await unlink(currentLink).catch((unlinkError: unknown) => {
            const unlinkCode =
              typeof unlinkError === 'object' && unlinkError !== null && 'code' in unlinkError
                ? unlinkError.code
                : undefined;
            if (unlinkCode !== 'ENOENT') throw unlinkError;
          });
        } else if (code !== 'ENOENT') {
          throw error;
        }
      }
      await rm(path.join(baseDir, 'versions'), { recursive: true, force: true });

      if (!uninstallOptions.keepData) {
        await rm(stateDir, { recursive: true, force: true });
      }
      return {
        ok: true,
        message: uninstallOptions.keepData
          ? `${taskName} uninstalled; state dir preserved (keepData)`
          : `${taskName} uninstalled; installed code and state dir removed`,
      };
    },
  };
}
