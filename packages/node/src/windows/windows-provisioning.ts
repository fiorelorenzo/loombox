import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

/**
 * Resident-node **Task Scheduler** provisioning for a Windows-local node
 * (issue #659, epic #653). Mirrors `../ssh/systemd-provisioning.ts`'s and
 * `../launchd/launchd-provisioning.ts`'s own shape (`generate*` pure string
 * generation; `plan*`/`execute*` split; `noop`/`install`/`update`/
 * `unsupported` action; a re-read-and-compare post-install verification),
 * reimplemented from scratch for Task Scheduler's own vocabulary — there is
 * no `systemd --user` or `launchctl` here, and the differences below are
 * not cosmetic.
 *
 * **Why Task Scheduler, not a Windows Service** (issue #659's own framing):
 * a Windows Service needs admin to install and, running as `LocalSystem` or
 * a service account, is the wrong place for this node's own DPAPI-backed
 * Credential Manager entries — those are scoped to the *interactive user*,
 * not to a service account, so a service running as `LocalSystem` could not
 * read them back without impersonation gymnastics this backend has no
 * business doing. A per-user scheduled task with a **logon trigger**, run
 * under `InteractiveToken` (the signed-in user's own real token) needs no
 * admin at all and is the direct Windows analogue of `../launchd/
 * launchd-provisioning.ts`'s `LaunchAgent` (itself only runs in a logged-in
 * GUI session) — issue #659 asks for exactly this "no admin, per-user"
 * default, the same choice `../local/systemd-local-supervisor-backend.ts`
 * already made for `systemd --user` over a system-wide unit.
 *
 * **What this platform genuinely does not have, handled explicitly:**
 *
 * - No `EnvironmentVariables` field on a Task Scheduler `<Exec>` action
 *   (unlike `../launchd/launchd-provisioning.ts`'s plist dict or
 *   `../ssh/systemd-provisioning.ts`'s `Environment=` lines). This module
 *   generates a small `.cmd` launcher script instead — `set "NAME=VALUE"`
 *   per env var, then the real command — and the task's own `<Command>` is
 *   always `cmd.exe`, `<Arguments>` always `/d /c "<launcher path>"`. See
 *   {@link generateWindowsLauncherScript}'s own doc comment for the
 *   escaping boundary this deliberately draws.
 * - A `LogonTrigger` only fires at the *next* logon, unlike `RunAtLoad`/
 *   `enable --now`, which start the service immediately. {@link
 *   executeWindowsTaskProvisioning} therefore always follows a successful
 *   `/Create` with an explicit `/Run` — the only way to satisfy `../
 *   supervisor-backend.ts`'s `install()` contract ("a successful install
 *   leaves the resident node already running") on this platform.
 * - `ExecutionTimeLimit` defaults to 72 hours (Microsoft's own docs: "by
 *   default, a task will be stopped 72 hours after it starts to run") —
 *   silently fatal for a process meant to run indefinitely. {@link
 *   generateWindowsTaskXml} always sets it to `PT0S` ("run indefinitely"),
 *   the same category of trap `../local/systemd-local-supervisor-
 *   backend.ts`'s own doc comment calls out for `loginctl enable-linger`:
 *   a survival mechanism that quietly doesn't survive is worse than none.
 * - `RestartOnFailure/Count` is a schema-capped `unsignedByte` (max 255) —
 *   there is no "restart forever" expressible here the way `Restart=
 *   always`/`KeepAlive` get it on the other two platforms. `RESTART_COUNT`
 *   below is a generously large but real, finite bound; a node that
 *   crash-loops past it stops getting relaunched until the next real
 *   logon. A real, permanent platform gap, stated here rather than implied
 *   away by picking a number and saying nothing.
 * - No POSIX shell. `../ssh/local-process-transport.ts` (`spawn('sh', ['-c',
 *   command])`) is not reusable here at all — a fresh Windows install has
 *   no `sh` — so every `WindowsTaskIo` method below is argv-based
 *   (`child_process.execFile`, never a shell string), the same convention
 *   `../launchd/launchd-provisioning.ts`'s `LaunchdIo.launchctl` already
 *   uses for the identical reason (that one so no argument ever needs
 *   POSIX quoting; this one because there is no shell to quote for at
 *   all). {@link winQuoteArg} is this module's own argument-quoting
 *   primitive, needed only for the two places a single command-line
 *   *string* is unavoidable — the task's own `<Arguments>` element and the
 *   launcher script's invocation line — never for `schtasks` itself.
 *
 * There is no remote transport here, same reasoning `../launchd/launchd-
 * provisioning.ts` gives for its own absence of one: this node runs on the
 * very machine `plan`/`execute` run on. Every disk write and every
 * `schtasks` invocation is injected via {@link WindowsTaskIo}, exactly
 * mirroring `LaunchdIo` — production wires it to real `node:fs`/
 * `node:child_process` calls ({@link createNodeWindowsTaskIo}, never
 * defaulted here since there is no Windows host to safely default to from
 * this devbox); every test in this package uses an in-memory fake.
 */
export type WindowsTaskAction = 'noop' | 'install' | 'update' | 'unsupported';

/** A Task Scheduler folder path, this platform's nearest equivalent of a reverse-DNS launchd label or a systemd unit name. */
export const DEFAULT_WINDOWS_TASK_NAME = '\\loombox\\node';

/** Minimum restart backoff Task Scheduler's schema allows (`Interval (restartType) Element`: "The maximum time allowed is 31 days, and the minimum time allowed is 1 minute"). */
const RESTART_INTERVAL = 'PT1M';

/** A generously large, but real and finite, restart count — see this module's own top doc comment for why "restart forever" cannot be expressed here. `Count`'s schema type is `unsignedByte` (max 255). */
const RESTART_COUNT = 200;

/** `PT0S`: Task Scheduler's own encoding of "no execution time limit" — see this module's own top doc comment for the 72-hour default this overrides. */
const EXECUTION_TIME_LIMIT_UNLIMITED = 'PT0S';

export interface WindowsTaskConfig {
  /** Absolute path to the executable this task launches — typically the staged bundle's own `node.exe`. */
  execStart: string;
  /** Extra args appended after `execStart` — typically the packaged `@loombox/node` entry script's path. Joined into the launcher script's own invocation line via {@link winQuoteArg}, one token per element (never pre-joined by a caller). */
  execArgs?: string[];
  workingDirectory?: string;
  /** `LOOMBOX_*` (and `CLAUDE_CODE_OAUTH_TOKEN`) env vars the launched node reads. Rendered as `set "NAME=VALUE"` lines in the generated launcher script — see {@link generateWindowsLauncherScript}'s own doc comment for the values this can't safely express. */
  environment?: Record<string, string>;
  /** Defaults to {@link DEFAULT_WINDOWS_TASK_NAME}. */
  taskName?: string;
  description?: string;
  /**
   * The account this task's `LogonTrigger`/`Principal` are scoped to —
   * `DOMAIN\User` or a local `User`, from {@link WindowsTaskIo.userId}.
   * Required: an unscoped `LogonTrigger` (no `UserId`) fires at *any*
   * user's logon, exactly wrong on a shared machine, which is the
   * scenario issue #659 explicitly worries about for the admin-required
   * Windows Service alternative this backend deliberately avoids.
   */
  userId: string;
}

/**
 * Quotes `arg` for a Windows command line consumed by the standard C
 * runtime argv parser (`node.exe`'s own, and `cmd.exe /c`'s re-parsing of
 * its own trailing string) — the documented `CommandLineToArgvW`-
 * compatible algorithm: a run of backslashes is only doubled when it
 * immediately precedes a literal quote (or ends the argument, immediately
 * before the closing quote); a literal quote itself is always escaped.
 * The same algorithm Node's own `child_process` uses internally on win32,
 * and Python's `subprocess.list2cmdline` — reimplemented here (not
 * imported) since it must run identically on this POSIX devbox to be
 * testable at all. Always wraps in quotes, even when unnecessary, so a
 * generated `.cmd`/task-XML file stays visually unambiguous to a human
 * debugging this backend.
 */
export function winQuoteArg(arg: string): string {
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/**
 * Renders the `.cmd` launcher a Task Scheduler action invokes (via
 * `cmd.exe /d /c`) to work around Task Scheduler XML having no
 * `EnvironmentVariables` element at all — see this module's own top doc
 * comment. `set "NAME=VALUE"` per env var, then the real command, each
 * token individually quoted via {@link winQuoteArg}.
 *
 * The escaping boundary this draws, deliberately: every `%` in a value is
 * doubled (`%%`), the standard batch escape that stops `cmd.exe` from
 * treating it as the start of a `%VAR%` expansion. A value containing a
 * literal `"` or a newline throws instead of being silently mishandled —
 * safely nesting a double quote inside a `set "NAME=VALUE"` line is not a
 * one-line escape in `cmd.exe`, and every value this actually carries
 * today (relay URLs, node/device ids, tokens — `SupervisorBackendInstall
 * Config.environment`'s own doc comment) has no legitimate reason to
 * contain either. A caller that ever needs to pass one gets a clear error
 * at generation time, not a launcher script that silently runs the wrong
 * command.
 */
export function generateWindowsLauncherScript(config: WindowsTaskConfig): string {
  const lines: string[] = ['@echo off'];
  for (const [key, value] of Object.entries(config.environment ?? {})) {
    if (value.includes('"') || /[\r\n]/.test(value)) {
      throw new Error(
        `windows-provisioning: environment value for ${key} contains a double quote or newline, ` +
          `which a cmd.exe "NAME=VALUE" line cannot express safely: ${JSON.stringify(value)}`,
      );
    }
    lines.push(`set "${key}=${value.replace(/%/g, '%%')}"`);
  }
  const command = [config.execStart, ...(config.execArgs ?? [])].map(winQuoteArg).join(' ');
  lines.push(command);
  return lines.map((line) => `${line}\r\n`).join('');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Renders the Task Scheduler XML `schtasks /Create /XML` registers —
 * `LogonTrigger` + `Principal(InteractiveToken, LeastPrivilege)` for
 * "starts at this user's next logon, no admin" (this module's own top doc
 * comment), `ExecutionTimeLimit=PT0S` against the 72-hour default kill,
 * `RestartOnFailure` as the closest bounded equivalent of `Restart=
 * always`/`KeepAlive`, and `DisallowStartIfOnBatteries`/
 * `StopIfGoingOnBatteries` both `false` — a laptop's own resident node
 * must not stop the moment it's unplugged, a trap this platform's power
 * management defaults would otherwise fall into silently. `<Command>`/
 * `<Arguments>` always point at `cmd.exe /d /c "<launcher path>"` (`/d`
 * skips any configured AutoRun script; the launcher itself is what
 * actually runs `execStart`) — see this module's own top doc comment for
 * why the Action can never invoke `execStart` directly.
 */
export function generateWindowsTaskXml(options: {
  description?: string;
  userId: string;
  command: string;
  arguments: string;
  workingDirectory?: string;
}): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${escapeXml(options.description ?? 'loombox resident node')}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${escapeXml(options.userId)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(options.userId)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    `    <ExecutionTimeLimit>${EXECUTION_TIME_LIMIT_UNLIMITED}</ExecutionTimeLimit>`,
    '    <Priority>7</Priority>',
    '    <RestartOnFailure>',
    `      <Interval>${RESTART_INTERVAL}</Interval>`,
    `      <Count>${RESTART_COUNT}</Count>`,
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(options.command)}</Command>`,
    `      <Arguments>${escapeXml(options.arguments)}</Arguments>`,
  ];
  if (options.workingDirectory) {
    lines.push(`      <WorkingDirectory>${escapeXml(options.workingDirectory)}</WorkingDirectory>`);
  }
  lines.push('    </Exec>', '  </Actions>', '</Task>');
  return lines.map((line) => `${line}\r\n`).join('');
}

/** One completed `schtasks` invocation's result — argv-based (`child_process.execFile`-shaped), never a shell string, so no argument ever needs quoting. */
export interface SchtasksResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Every disk write and `schtasks` call this module needs, injected so
 * `plan`/`execute` are fully testable on a host with no real Windows
 * machine (this devbox) — mirrors `../launchd/launchd-provisioning.ts`'s
 * own `LaunchdIo` exactly, at the scope this module actually needs.
 */
export interface WindowsTaskIo {
  /** `process.platform`; only `'win32'` supports Task Scheduler. Injected (rather than read directly) so `plan` is testable as if it were running on Windows from this devbox. */
  platform: NodeJS.Platform;
  /** `%LOCALAPPDATA%` — user-scoped, machine-local (never roamed) app data; the Windows analogue of `~/Library` or `~/.config` for this node's own install root. */
  localAppData: () => string;
  /** `%SystemRoot%` (usually `C:\Windows`), resolved here rather than left to Task Scheduler's own `%SystemRoot%` expansion in the Action's `<Command>` — one fewer runtime behavior this module would otherwise have to trust unverified. */
  systemRoot: () => string;
  /** The account the generated task's `LogonTrigger`/`Principal` are scoped to — see {@link WindowsTaskConfig.userId}'s own doc comment for why this can never be left unset. */
  userId: () => string;
  /** Reads `path`'s current content, or `undefined` if it doesn't exist. */
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string) => void;
  /** Creates a directory, including any missing parents (like `mkdir -p`); a no-op if it already exists. */
  mkdir: (path: string) => void;
  /** Removes `path` if it exists; a no-op (never throws) if it doesn't. */
  removeFile: (path: string) => void;
  /** Runs `schtasks.exe` with `args` as argv (never shell-interpolated). */
  schtasks: (args: string[]) => Promise<SchtasksResult>;
}

export interface PlanWindowsProvisioningOptions {
  task: WindowsTaskConfig;
  /**
   * Where this backend keeps its own record of the last-registered task
   * XML (`task.xml`) and the generated env launcher (`run.cmd`), used to
   * decide `noop`/`install`/`update` without querying Task Scheduler's own
   * internal store. Defaults to `join(io.localAppData(), 'loombox')`.
   *
   * Task Scheduler *can* dump a live task's own definition back out
   * (`schtasks /Query /TN <name> /XML ONE`), but not the launcher script
   * beside it — this backend's own artifact, never registered with the OS
   * at all — so a single consistent source of truth this backend fully
   * controls is simpler and more honest than partially trusting the OS's
   * own copy for one half of the pair and a side file for the other.
   */
  scriptDir?: string;
}

export interface WindowsProvisionPlan {
  taskName: string;
  taskXmlPath: string;
  launcherPath: string;
  desiredTaskXml: string;
  desiredLauncherScript: string;
  currentTaskXml: string | undefined;
  currentLauncherScript: string | undefined;
  /** Whether `io.platform` is `'win32'` at all — `false` short-circuits to `action: 'unsupported'` before ever reading/comparing content, mirroring `../launchd/launchd-provisioning.ts`'s `platformSupported` short-circuit. */
  platformSupported: boolean;
  action: WindowsTaskAction;
  message: string;
}

/**
 * Detects whether this host can run a resident-node scheduled task and, if
 * so, whether install/update/nothing is needed to reach
 * `options.task`'s desired configuration — without writing anything. A
 * non-`'win32'` `io.platform` short-circuits to `'unsupported'`: declining
 * (or simply not being able to) leaves the local node fully usable, just
 * without autonomous restart-at-logon/restart-on-crash, exactly like
 * `../ssh/systemd-provisioning.ts`'s "declining leaves the target fully
 * usable" for a host with no `systemd --user`.
 */
export function planWindowsTaskProvisioning(
  io: WindowsTaskIo,
  options: PlanWindowsProvisioningOptions,
): WindowsProvisionPlan {
  const taskName = options.task.taskName ?? DEFAULT_WINDOWS_TASK_NAME;
  const scriptDir = options.scriptDir ?? win32.join(io.localAppData(), 'loombox');
  const taskXmlPath = win32.join(scriptDir, 'task.xml');
  const launcherPath = win32.join(scriptDir, 'run.cmd');
  const cmdExePath = win32.join(io.systemRoot(), 'System32', 'cmd.exe');
  const desiredLauncherScript = generateWindowsLauncherScript(options.task);
  const desiredTaskXml = generateWindowsTaskXml({
    description: options.task.description,
    userId: options.task.userId,
    command: cmdExePath,
    arguments: `/d /c ${winQuoteArg(launcherPath)}`,
    workingDirectory: options.task.workingDirectory,
  });

  if (io.platform !== 'win32') {
    return {
      taskName,
      taskXmlPath,
      launcherPath,
      desiredTaskXml,
      desiredLauncherScript,
      currentTaskXml: undefined,
      currentLauncherScript: undefined,
      platformSupported: false,
      action: 'unsupported',
      message:
        `loombox can't install a resident-node scheduled task on "${io.platform}" — Task ` +
        'Scheduler is Windows-only. Declining leaves the local node fully usable, just without ' +
        'autonomous restart-at-logon/restart-on-crash (the Windows equivalent of SPEC §7.22).',
    };
  }

  const currentTaskXml = io.readFile(taskXmlPath);
  const currentLauncherScript = io.readFile(launcherPath);
  if (currentTaskXml === desiredTaskXml && currentLauncherScript === desiredLauncherScript) {
    return {
      taskName,
      taskXmlPath,
      launcherPath,
      desiredTaskXml,
      desiredLauncherScript,
      currentTaskXml,
      currentLauncherScript,
      platformSupported: true,
      action: 'noop',
      message: `${taskName} is already registered and up to date at ${taskXmlPath}.`,
    };
  }

  const action: WindowsTaskAction = currentTaskXml === undefined ? 'install' : 'update';
  return {
    taskName,
    taskXmlPath,
    launcherPath,
    desiredTaskXml,
    desiredLauncherScript,
    currentTaskXml,
    currentLauncherScript,
    platformSupported: true,
    action,
    message:
      action === 'install'
        ? `installing resident-node scheduled task ${taskName} at ${taskXmlPath}, set to start ` +
          'at logon and restart on failure.'
        : `updating resident-node scheduled task ${taskName} at ${taskXmlPath} to the current ` +
          'configuration.',
  };
}

export interface WindowsProvisionResult {
  ok: boolean;
  action: WindowsTaskAction;
  /** Every `schtasks` argv this call actually ran, in order — empty for `noop`/`unsupported`. */
  ranCommands: string[][];
  error?: string;
}

/**
 * Applies `plan` (from {@link planWindowsTaskProvisioning}). `noop` runs
 * nothing and reports success; `unsupported` runs nothing and reports
 * failure — for either, this function never touches disk or spawns
 * `schtasks`, mirroring `executeLaunchdProvisioning`'s same contract.
 *
 * For `install`/`update`: an `update` first best-effort `/End`s whatever
 * copy is currently registered (exit code never checked — ending a task
 * that isn't currently running exits non-zero too, and that's fine, same
 * precedent `executeLaunchdProvisioning`'s own `bootout`-before-`bootstrap`
 * sets). Both write the launcher script and the task XML, then `schtasks
 * /Create /XML <taskXmlPath> /TN <taskName> /F` (`/F` so a re-`Create`
 * over an existing registration is an overwrite, not a refusal) and —
 * unlike `launchctl`'s `RunAtLoad`/`enable --now` — an explicit `/Run`
 * right after, since a `LogonTrigger` alone would leave the node not
 * actually running until the next logon (this module's own top doc
 * comment). Stops at the first failing `schtasks` call rather than
 * continuing past it. On success, re-reads both generated files to confirm
 * their content genuinely landed before reporting `ok: true` (the same
 * install-then-verify recipe `executeLaunchdProvisioning` uses).
 */
export async function executeWindowsTaskProvisioning(
  io: WindowsTaskIo,
  plan: WindowsProvisionPlan,
): Promise<WindowsProvisionResult> {
  if (plan.action === 'noop') {
    return { ok: true, action: 'noop', ranCommands: [] };
  }
  if (plan.action === 'unsupported') {
    return { ok: false, action: 'unsupported', ranCommands: [], error: plan.message };
  }

  const ranCommands: string[][] = [];

  if (plan.action === 'update') {
    const endArgs = ['/End', '/TN', plan.taskName];
    await io.schtasks(endArgs);
    ranCommands.push(endArgs);
  }

  io.mkdir(win32.dirname(plan.taskXmlPath));
  io.writeFile(plan.launcherPath, plan.desiredLauncherScript);
  io.writeFile(plan.taskXmlPath, plan.desiredTaskXml);

  const createArgs = ['/Create', '/XML', plan.taskXmlPath, '/TN', plan.taskName, '/F'];
  const create = await io.schtasks(createArgs);
  ranCommands.push(createArgs);
  if (create.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      ranCommands,
      error: `schtasks /Create failed (exit ${create.exitCode}): ${create.stderr}`,
    };
  }

  const runArgs = ['/Run', '/TN', plan.taskName];
  const run = await io.schtasks(runArgs);
  ranCommands.push(runArgs);
  if (run.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      ranCommands,
      error: `schtasks /Run failed (exit ${run.exitCode}): ${run.stderr}`,
    };
  }

  const installedTaskXml = io.readFile(plan.taskXmlPath);
  const installedLauncherScript = io.readFile(plan.launcherPath);
  if (
    installedTaskXml !== plan.desiredTaskXml ||
    installedLauncherScript !== plan.desiredLauncherScript
  ) {
    return {
      ok: false,
      action: plan.action,
      ranCommands,
      error:
        `post-install verification failed: ${plan.taskXmlPath}/${plan.launcherPath} content ` +
        'does not match what was written',
    };
  }

  return { ok: true, action: plan.action, ranCommands };
}

const execFileAsync = promisify(execFile);

/**
 * The real {@link WindowsTaskIo}: genuine `node:fs` reads/writes and a
 * genuine `schtasks.exe` child process. Not wired into any default in this
 * module — every caller (the desktop app/Electron bridge, out of this
 * package's scope) constructs it explicitly, on the actual Windows machine
 * it runs on, exactly because there is no Windows machine to safely
 * default to here.
 */
export function createNodeWindowsTaskIo(): WindowsTaskIo {
  return {
    platform: process.platform,
    localAppData: () => process.env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData', 'Local'),
    systemRoot: () => process.env.SystemRoot ?? 'C:\\Windows',
    userId: () => {
      const domain = process.env.USERDOMAIN;
      const user = process.env.USERNAME ?? 'unknown';
      return domain ? `${domain}\\${user}` : user;
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: (path, content) => {
      writeFileSync(path, content, 'utf8');
    },
    mkdir: (path) => {
      mkdirSync(path, { recursive: true });
    },
    removeFile: (path) => {
      rmSync(path, { force: true });
    },
    schtasks: async (args) => {
      try {
        const { stdout, stderr } = await execFileAsync('schtasks.exe', args);
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        // `execFileAsync` rejects both for a non-zero exit AND for the
        // binary itself failing to spawn (e.g. off-Windows). Only the
        // former has a numeric `.code` (the exit status); re-throw the
        // latter rather than pretending it's some exit code — same
        // precedent `../launchd/launchd-provisioning.ts`'s own
        // `createNodeLaunchdIo` sets for `launchctl`.
        const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (typeof execError.code !== 'number') {
          throw error;
        }
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
          exitCode: execError.code,
        };
      }
    },
  };
}
