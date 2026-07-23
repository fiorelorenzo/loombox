import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { buildResidentNodeEnvironment, type ResidentNodeConfig } from '../ssh/provision-target';

/**
 * Opt-in resident-node **launchd** installation for a Mac-resident **local**
 * node (issue #406, SPEC §7.22/§7.23's equivalent for a co-located node — no
 * SSH involved). Mirrors `../ssh/systemd-provisioning.ts`'s shape exactly
 * (`generate*` pure string generation; `plan*`/`execute*` split; `noop` /
 * `install` / `update` / `unsupported` action; a re-read-and-compare
 * post-install verification), reimplemented from scratch for launchd's own
 * vocabulary — `launchctl(1)`'s modern `bootstrap`/`enable`/`bootout`
 * subcommands (10.11+/"Big Sur" `gui/<uid>` domain form, not the deprecated
 * `load -w`), and a plist instead of a unit file.
 *
 * There is no remote transport here (`../ssh/remote-transport.ts`'s
 * `RemoteTransport`) because there is no remote host: this node runs on the
 * very machine `plan`/`execute` run on. What *is* injectable — deliberately,
 * since this whole module is developed and tested on a headless Linux devbox
 * with no real Mac, launchd, or `launchctl` binary — is every disk write and
 * every `launchctl` invocation, via {@link LaunchdIo}. Production wires
 * {@link LaunchdIo} to real `node:fs`/`node:child_process` calls (the
 * Electron app/desktop bridge's job, out of this package); every test here
 * uses an in-memory fake.
 */
export type LaunchdProvisionAction = 'noop' | 'install' | 'update' | 'unsupported';

/** Reverse-DNS label this package installs its LaunchAgent under — matches `loombox.dev`'s own domain, reversed, the same convention Apple's docs use for a real `com.example.foo`-style identifier. */
export const DEFAULT_LAUNCHD_LABEL = 'dev.loombox.node';

export interface LaunchdAgentConfig {
  /** Absolute path to the executable this agent launches — typically the co-located app's own bundled `node` binary. */
  execStart: string;
  /** Extra args appended after `execStart` — typically the packaged `@loombox/node` entry script's path plus any CLI flags. Each element becomes its own `<string>` in `ProgramArguments`, so (unlike `systemd-provisioning.ts`'s space-joined `ExecStart=`) no shell quoting is ever needed here. */
  execArgs?: string[];
  workingDirectory?: string;
  /** `LOOMBOX_*` (and `CLAUDE_CODE_OAUTH_TOKEN`) env vars the launched node reads — see {@link buildLocalNodeLaunchdAgent} for the usual way to build this. */
  environment?: Record<string, string>;
  /** Defaults to {@link DEFAULT_LAUNCHD_LABEL}. */
  label?: string;
  /** Launches immediately once loaded, and again at every login while the agent stays installed. Defaults to `true`. */
  runAtLoad?: boolean;
  /** launchd relaunches the process if it exits, for any reason — the closest launchd equivalent to `systemd-provisioning.ts`'s `Restart=always`. Defaults to `true`. */
  keepAlive?: boolean;
  /** Redirects the launched process's stdout to a file — a resident agent has no attached terminal to log to otherwise. */
  stdoutPath?: string;
  /** Redirects the launched process's stderr to a file. */
  stderrPath?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stringElement(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

/**
 * Renders a `~/Library/LaunchAgents/<label>.plist` for `config` — pure string
 * generation, no I/O, deterministic for the same `config` (mirrors
 * `../ssh/systemd-provisioning.ts`'s `generateSystemdUnit`, and for the same
 * reason: {@link planLaunchdProvisioning} decides `noop` vs `update` by a
 * plain string comparison against whatever is already staged on disk).
 */
export function generateLaunchdPlist(config: LaunchdAgentConfig): string {
  const label = config.label ?? DEFAULT_LAUNCHD_LABEL;
  const programArguments = [config.execStart, ...(config.execArgs ?? [])];
  const runAtLoad = config.runAtLoad ?? true;
  const keepAlive = config.keepAlive ?? true;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${stringElement(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((arg) => `    ${stringElement(arg)}`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    `  <${runAtLoad ? 'true' : 'false'}/>`,
    '  <key>KeepAlive</key>',
    `  <${keepAlive ? 'true' : 'false'}/>`,
  ];

  if (config.workingDirectory) {
    lines.push('  <key>WorkingDirectory</key>', `  ${stringElement(config.workingDirectory)}`);
  }

  const envEntries = Object.entries(config.environment ?? {});
  if (envEntries.length > 0) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [key, value] of envEntries) {
      lines.push(`    <key>${escapeXml(key)}</key>`, `    ${stringElement(value)}`);
    }
    lines.push('  </dict>');
  }

  if (config.stdoutPath) {
    lines.push('  <key>StandardOutPath</key>', `  ${stringElement(config.stdoutPath)}`);
  }
  if (config.stderrPath) {
    lines.push('  <key>StandardErrorPath</key>', `  ${stringElement(config.stderrPath)}`);
  }

  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

/**
 * Builds a {@link LaunchdAgentConfig} for a co-located local node, reusing
 * `../ssh/provision-target.ts`'s `buildResidentNodeEnvironment` for the
 * `LOOMBOX_*`/`CLAUDE_CODE_OAUTH_TOKEN` env mapping — the exact same
 * vocabulary `main.ts`'s `loadNodeConfig` reads, and the exact same mapper
 * the `ssh:` systemd-provisioning path already uses (issue #400/#406: one
 * `ResidentNodeConfig` -> env mapper for both transports, not a second copy
 * of it for launchd).
 */
export function buildLocalNodeLaunchdAgent(options: {
  execStart: string;
  execArgs?: string[];
  workingDirectory?: string;
  config: ResidentNodeConfig;
  label?: string;
  runAtLoad?: boolean;
  keepAlive?: boolean;
  stdoutPath?: string;
  stderrPath?: string;
}): LaunchdAgentConfig {
  return {
    execStart: options.execStart,
    execArgs: options.execArgs,
    workingDirectory: options.workingDirectory,
    environment: buildResidentNodeEnvironment(options.config),
    label: options.label,
    runAtLoad: options.runAtLoad,
    keepAlive: options.keepAlive,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
  };
}

/** One completed `launchctl` invocation's result — argv-based (`child_process.execFile`-shaped), never a shell string, so no argument ever needs quoting. */
export interface LaunchctlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Every disk write and `launchctl` call this module needs, injected so
 * `plan`/`execute` are fully testable on a host with no real Mac (this
 * devbox) — mirrors `../amk-handoff-file.ts`'s injectable `fs` slice and
 * `../ssh/remote-transport.ts`'s `RemoteTransport` seam, at the scope this
 * module actually needs.
 */
export interface LaunchdIo {
  /** `process.platform`; only `'darwin'` supports launchd. Injected (rather than read directly) so `plan` is testable as if it were running on macOS from this devbox. */
  platform: NodeJS.Platform;
  /** The current user's home directory, used to derive the default `~/Library/LaunchAgents`. */
  homeDir: () => string;
  /** The current user's numeric uid, used to build the `gui/<uid>` launchd domain target `bootstrap`/`enable`/`bootout` all take. */
  uid: () => number;
  /** Reads `path`'s current content, or `undefined` if it doesn't exist. */
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string) => void;
  /** Creates a directory, including any missing parents (like `mkdir -p`); a no-op if it already exists. */
  mkdir: (path: string) => void;
  /** Runs `launchctl` with `args` as argv (never shell-interpolated). */
  launchctl: (args: string[]) => Promise<LaunchctlResult>;
}

export interface PlanLaunchdProvisioningOptions {
  agent: LaunchdAgentConfig;
  /** Overrides `~/Library/LaunchAgents`; defaults to `join(io.homeDir(), 'Library', 'LaunchAgents')`. */
  agentsDir?: string;
}

export interface LaunchdProvisionPlan {
  label: string;
  plistPath: string;
  desiredContent: string;
  currentContent: string | undefined;
  /** Whether `io.platform` is `'darwin'` at all — `false` short-circuits to `action: 'unsupported'` before ever reading/comparing plist content, mirroring `systemd-provisioning.ts`'s `systemctlPresent` short-circuit. */
  platformSupported: boolean;
  action: LaunchdProvisionAction;
  message: string;
}

/**
 * Detects whether this host can run a resident-node LaunchAgent and, if so,
 * whether install/update/nothing is needed to reach `options.agent`'s
 * desired plist content — without writing anything. A non-`'darwin'`
 * `io.platform` short-circuits to `'unsupported'`: declining (or simply not
 * being able to) leaves the local node fully usable, just without
 * autonomous keep-alive/start-at-login, exactly like
 * `systemd-provisioning.ts`'s "declining leaves the target fully usable" for
 * a host with no `systemd --user`.
 */
export function planLaunchdProvisioning(
  io: LaunchdIo,
  options: PlanLaunchdProvisioningOptions,
): LaunchdProvisionPlan {
  const label = options.agent.label ?? DEFAULT_LAUNCHD_LABEL;
  const agentsDir = options.agentsDir ?? join(io.homeDir(), 'Library', 'LaunchAgents');
  const plistPath = join(agentsDir, `${label}.plist`);
  const desiredContent = generateLaunchdPlist(options.agent);

  if (io.platform !== 'darwin') {
    return {
      label,
      plistPath,
      desiredContent,
      currentContent: undefined,
      platformSupported: false,
      action: 'unsupported',
      message:
        `loombox can't install a resident-node LaunchAgent on "${io.platform}" — launchd is ` +
        'macOS-only. Declining leaves the local node fully usable, just without autonomous ' +
        'keep-alive/start-at-login (the Mac equivalent of SPEC §7.22).',
    };
  }

  const currentContent = io.readFile(plistPath);
  if (currentContent === desiredContent) {
    return {
      label,
      plistPath,
      desiredContent,
      currentContent,
      platformSupported: true,
      action: 'noop',
      message: `${label} is already installed and up to date at ${plistPath}.`,
    };
  }

  const action: LaunchdProvisionAction = currentContent === undefined ? 'install' : 'update';
  return {
    label,
    plistPath,
    desiredContent,
    currentContent,
    platformSupported: true,
    action,
    message:
      action === 'install'
        ? `installing resident-node LaunchAgent ${label} at ${plistPath}, set to run at login and restart on exit.`
        : `updating resident-node LaunchAgent ${label} at ${plistPath} to the current configuration.`,
  };
}

export interface LaunchdProvisionResult {
  ok: boolean;
  action: LaunchdProvisionAction;
  /** Every `launchctl` argv this call actually ran, in order — empty for `noop`/`unsupported`. */
  ranCommands: string[][];
  error?: string;
}

/**
 * Applies `plan` (from {@link planLaunchdProvisioning}). `noop` runs nothing
 * and reports success; `unsupported` runs nothing and reports failure — for
 * either, this function never touches disk or spawns `launchctl`, mirroring
 * `executeSystemdProvisioning`'s same contract.
 *
 * For `install`/`update`: writes the plist (creating
 * `~/Library/LaunchAgents` if needed), then `launchctl bootstrap
 * gui/<uid> <plistPath>` and `launchctl enable gui/<uid>/<label>` — the
 * modern (10.11+) launchctl form, not the deprecated `load -w`. An `update`
 * first runs `launchctl bootout gui/<uid>/<label>` to unload whatever copy
 * is already running before writing the new plist; its exit code is never
 * checked (booting out an agent that isn't currently loaded — e.g. it
 * crashed, or was never actually running despite a stale plist on disk —
 * exits non-zero too, and that's fine: the point is just "nothing of the old
 * copy is left loaded before the new one is bootstrapped in").
 *
 * Stops at the first failing `launchctl` call (`bootstrap` or `enable`)
 * rather than continuing past it. On success, re-reads the plist to confirm
 * the content genuinely landed before reporting `ok: true` (the same
 * install-then-verify recipe `executeSystemdProvisioning` uses).
 */
export async function executeLaunchdProvisioning(
  io: LaunchdIo,
  plan: LaunchdProvisionPlan,
): Promise<LaunchdProvisionResult> {
  if (plan.action === 'noop') {
    return { ok: true, action: 'noop', ranCommands: [] };
  }
  if (plan.action === 'unsupported') {
    return { ok: false, action: 'unsupported', ranCommands: [], error: plan.message };
  }

  const domainTarget = `gui/${io.uid()}`;
  const serviceTarget = `${domainTarget}/${plan.label}`;
  const ranCommands: string[][] = [];

  io.mkdir(dirname(plan.plistPath));
  io.writeFile(plan.plistPath, plan.desiredContent);

  if (plan.action === 'update') {
    const bootoutArgs = ['bootout', serviceTarget];
    await io.launchctl(bootoutArgs);
    ranCommands.push(bootoutArgs);
  }

  const bootstrapArgs = ['bootstrap', domainTarget, plan.plistPath];
  const bootstrap = await io.launchctl(bootstrapArgs);
  ranCommands.push(bootstrapArgs);
  if (bootstrap.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      ranCommands,
      error: `launchctl bootstrap failed (exit ${bootstrap.exitCode}): ${bootstrap.stderr}`,
    };
  }

  const enableArgs = ['enable', serviceTarget];
  const enable = await io.launchctl(enableArgs);
  ranCommands.push(enableArgs);
  if (enable.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      ranCommands,
      error: `launchctl enable failed (exit ${enable.exitCode}): ${enable.stderr}`,
    };
  }

  const installedContent = io.readFile(plan.plistPath);
  if (installedContent !== plan.desiredContent) {
    return {
      ok: false,
      action: plan.action,
      ranCommands,
      error: `post-install verification failed: ${plan.plistPath} content does not match what was written`,
    };
  }

  return { ok: true, action: plan.action, ranCommands };
}

const execFileAsync = promisify(execFile);

/**
 * The real {@link LaunchdIo}: genuine `node:fs` reads/writes and a genuine
 * `launchctl` child process. Not wired into any default in this module —
 * every caller (the desktop app/Electron bridge, out of this package's
 * scope) constructs it explicitly, on the actual Mac it runs on, exactly
 * because there is no Mac to safely default to here.
 */
export function createNodeLaunchdIo(): LaunchdIo {
  return {
    platform: process.platform,
    homeDir: () => homedir(),
    uid: () => process.getuid?.() ?? 0,
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
    launchctl: async (args) => {
      try {
        const { stdout, stderr } = await execFileAsync('launchctl', args);
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        // `execFileAsync` rejects both for a non-zero exit AND for the
        // binary itself failing to spawn (e.g. `launchctl` not on PATH,
        // ENOENT off-Mac). Only the former has a numeric `.code` (the exit
        // status); re-throw the latter rather than pretending it's some
        // exit code — there genuinely is no exit code to report, mirroring
        // `LocalExecutionTarget.exec`'s own `child.on('error', reject)`.
        const execError = error as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
        };
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
