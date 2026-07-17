import { shQuote, type RemoteTransport } from './remote-transport';

/**
 * How a launched remote process is kept alive after this transport
 * disconnects (issue #80's "detaches so it survives", issue #81's fallback):
 * `setsid` is the primary, zero-dependency POSIX mechanism (SPEC.md §16:
 * "POSIX setsid/nohup detach ... precedent: mosh / VS Code Remote-SSH
 * persistent server"); `tmux`/`screen` are the zero-install fallback for a
 * host where `setsid`+`mkfifo` aren't both available.
 */
export type DetachMode = 'setsid' | 'tmux' | 'screen';

export interface RemoteCapabilities {
  setsid: boolean;
  mkfifo: boolean;
  tmux: boolean;
  screen: boolean;
}

/** A launched (or reattached) remote run. Fully reconstructable from `runId` alone via {@link RemoteProcessRunner.attach} — nothing here is required to survive this process restarting. */
export interface RemoteRunHandle {
  runId: string;
  mode: DetachMode;
  runDir: string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `RemoteProcessRunner: runId must match ${RUN_ID_PATTERN} (got ${JSON.stringify(runId)})`,
    );
  }
}

function sessionNameFor(runId: string): string {
  return `loombox-${runId}`;
}

function paths(runDir: string): { pid: string; fifo: string; log: string; mode: string } {
  return {
    pid: `${runDir}/pid`,
    fifo: `${runDir}/in.fifo`,
    log: `${runDir}/output.log`,
    mode: `${runDir}/mode`,
  };
}

export interface ChooseDetachModeOptions {
  /**
   * Skip the native `setsid`+`mkfifo` mechanism even when available and go
   * straight to the tmux/screen fallback (issue #81's "explicitly disabled"
   * trigger, alongside the automatic one: native tooling missing).
   */
  forceFallback?: boolean;
}

/** Picks the best available `DetachMode` given a host's detected capabilities, preferring the native mechanism. Throws if the host can support none of them. */
export function chooseDetachMode(
  capabilities: RemoteCapabilities,
  options: ChooseDetachModeOptions = {},
): DetachMode {
  if (!options.forceFallback && capabilities.setsid && capabilities.mkfifo) return 'setsid';
  if (capabilities.tmux) return 'tmux';
  if (capabilities.screen) return 'screen';
  throw new Error(
    'RemoteProcessRunner: remote host has none of setsid+mkfifo, tmux, or screen — cannot detach a process',
  );
}

/**
 * Builds the shell script that creates `runDir`, the fifo + log + mode
 * marker inside it, and launches `command` detached under `mode`, all in one
 * `RemoteTransport.exec()` call. `command` must already be a fully
 * shell-quoted command line (e.g. `${shQuote(bin)} ${shQuote(arg)}`) — this
 * function only adds the redirects and detach wrapper around it.
 *
 * The launched process's stdin is the fifo opened read-write (`<>`), not
 * plain read (`<`): a plain read-open blocks until a writer connects, which
 * would stall the launch itself; `<>` lets the process (and thus the fifo)
 * start immediately, with `writeInput()` appending to it later without ever
 * triggering EOF on the read side (POSIX: a fifo's reader only sees EOF once
 * every write-open descriptor closes, and this one never does).
 */
export function buildLaunchScript(runDir: string, mode: DetachMode, command: string): string {
  const p = paths(runDir);
  const setup = [
    `mkdir -p ${shQuote(runDir)}`,
    `[ -p ${shQuote(p.fifo)} ] || mkfifo ${shQuote(p.fifo)}`,
    `: > ${shQuote(p.log)}`,
    `printf '%s' ${shQuote(mode)} > ${shQuote(p.mode)}`,
  ].join('\n');

  const redirected = `${command} <>${shQuote(p.fifo)} >>${shQuote(p.log)} 2>&1`;

  if (mode === 'setsid') {
    return [setup, `setsid ${redirected} &`, `echo $! > ${shQuote(p.pid)}`].join('\n');
  }

  const inner = shQuote(redirected);
  if (mode === 'tmux') {
    return [
      setup,
      `tmux new-session -d -s ${shQuote(sessionNameFor(runDirRunId(runDir)))} sh -c ${inner}`,
    ].join('\n');
  }
  // screen
  return [setup, `screen -dmS ${shQuote(sessionNameFor(runDirRunId(runDir)))} sh -c ${inner}`].join(
    '\n',
  );
}

/** Extracts the trailing path segment (the `runId`) from a `runDir` built by {@link RemoteProcessRunner}'s own convention (`<baseDir>/<runId>`). Only used internally to derive tmux/screen session names from a `runDir`. */
function runDirRunId(runDir: string): string {
  const parts = runDir.split('/');
  return parts[parts.length - 1] ?? runDir;
}

export function buildIsRunningScript(runDir: string, mode: DetachMode): string {
  const p = paths(runDir);
  const runId = runDirRunId(runDir);
  if (mode === 'setsid') {
    return `[ -f ${shQuote(p.pid)} ] && kill -0 "$(cat ${shQuote(p.pid)})" 2>/dev/null && echo alive || echo dead`;
  }
  if (mode === 'tmux') {
    return `tmux has-session -t ${shQuote(sessionNameFor(runId))} 2>/dev/null && echo alive || echo dead`;
  }
  return `screen -list 2>/dev/null | grep -q "\\.${sessionNameFor(runId)}\\>" && echo alive || echo dead`;
}

export function buildStopScript(runDir: string, mode: DetachMode): string {
  const p = paths(runDir);
  const runId = runDirRunId(runDir);
  if (mode === 'setsid') {
    return `kill "$(cat ${shQuote(p.pid)})" 2>/dev/null || true`;
  }
  if (mode === 'tmux') {
    return `tmux kill-session -t ${shQuote(sessionNameFor(runId))} 2>/dev/null || true`;
  }
  return `screen -S ${shQuote(sessionNameFor(runId))} -X quit 2>/dev/null || true`;
}

export function buildCapabilitiesScript(): string {
  return [
    'for c in setsid mkfifo tmux screen; do',
    '  command -v "$c" >/dev/null 2>&1 && echo "$c=1" || echo "$c=0"',
    'done',
  ].join('\n');
}

function parseCapabilities(stdout: string): RemoteCapabilities {
  const flags: Record<string, boolean> = {};
  for (const line of stdout.split('\n')) {
    const [name, value] = line.split('=');
    if (name) flags[name.trim()] = value?.trim() === '1';
  }
  return {
    setsid: flags.setsid ?? false,
    mkfifo: flags.mkfifo ?? false,
    tmux: flags.tmux ?? false,
    screen: flags.screen ?? false,
  };
}

export interface RemoteProcessRunnerOptions {
  /** Absolute remote directory every run lives under (`<baseDir>/<runId>`). Defaults to `$HOME/.loombox/remote-sessions`, resolved lazily via the transport. */
  baseDir?: string;
}

/**
 * Deploys nothing by itself (there is no separate "supervisor binary" to
 * upload in this wave — see the module doc comment in `remote-agent-child.ts`
 * for why running the provider's own CLI directly, wrapped by this detach
 * mechanism, is this wave's honest scope) but owns the actual novel plumbing
 * issue #80/#81 are about: launching a command on a `RemoteTransport`'s host
 * such that it (a) starts immediately, (b) survives this transport
 * disconnecting, and (c) can be reattached to later by `runId` alone to keep
 * reading its output and keep feeding it input.
 */
export class RemoteProcessRunner {
  private baseDirCache: string | undefined;

  constructor(
    private readonly transport: RemoteTransport,
    private readonly options: RemoteProcessRunnerOptions = {},
  ) {}

  async detectCapabilities(): Promise<RemoteCapabilities> {
    const result = await this.transport.exec(buildCapabilitiesScript());
    return parseCapabilities(result.stdout);
  }

  private async resolveBaseDir(): Promise<string> {
    if (this.options.baseDir) return this.options.baseDir;
    if (this.baseDirCache) return this.baseDirCache;
    const result = await this.transport.exec('printf %s "$HOME/.loombox/remote-sessions"');
    this.baseDirCache = result.stdout.trim();
    return this.baseDirCache;
  }

  private async runDirFor(runId: string): Promise<string> {
    assertSafeRunId(runId);
    const baseDir = await this.resolveBaseDir();
    return `${baseDir}/${runId}`;
  }

  /** Launches `command` (a fully shell-quoted command line) detached under `mode`, keyed by `runId` so a later `attach(runId)` finds the same run. */
  async launch(runId: string, command: string, mode: DetachMode): Promise<RemoteRunHandle> {
    const runDir = await this.runDirFor(runId);
    const script = buildLaunchScript(runDir, mode, command);
    const result = await this.transport.exec(script);
    if (result.exitCode !== 0) {
      throw new Error(
        `RemoteProcessRunner: launch of runId ${runId} (mode ${mode}) failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
    return { runId, mode, runDir };
  }

  /**
   * Detects this host's capabilities, picks a `DetachMode` via
   * {@link chooseDetachMode}, and launches under it — issue #81's "detect
   * availability and choose the mode; make the choice observable/testable":
   * the returned `usedFallback` is exactly that observation (`true` whenever
   * `mode !== 'setsid'`), so a caller can log/surface "this target is
   * running under the tmux fallback" rather than silently substituting it.
   */
  async launchWithFallback(
    runId: string,
    command: string,
    options: ChooseDetachModeOptions = {},
  ): Promise<{ handle: RemoteRunHandle; mode: DetachMode; usedFallback: boolean }> {
    const capabilities = await this.detectCapabilities();
    const mode = chooseDetachMode(capabilities, options);
    const handle = await this.launch(runId, command, mode);
    return { handle, mode, usedFallback: mode !== 'setsid' };
  }

  /** Reconstructs the handle for a previously-launched `runId` (reading back which mode it used) and reports whether it's still running. Returns `undefined` if this `runId` was never launched (no run directory / mode marker on the remote). */
  async attach(runId: string): Promise<{ handle: RemoteRunHandle; alive: boolean } | undefined> {
    const runDir = await this.runDirFor(runId);
    const modeResult = await this.transport.exec(`cat ${shQuote(paths(runDir).mode)} 2>/dev/null`);
    const mode = modeResult.stdout.trim();
    if (mode !== 'setsid' && mode !== 'tmux' && mode !== 'screen') return undefined;

    const handle: RemoteRunHandle = { runId, mode, runDir };
    const alive = await this.isRunning(handle);
    return { handle, alive };
  }

  async isRunning(handle: RemoteRunHandle): Promise<boolean> {
    const result = await this.transport.exec(buildIsRunningScript(handle.runDir, handle.mode));
    return result.stdout.trim() === 'alive';
  }

  /** Appends `data` to the run's stdin fifo. Safe to call at any point after `launch()`/`attach()` — see `buildLaunchScript`'s doc comment for why this never blocks or races the fifo's own EOF. */
  async writeInput(handle: RemoteRunHandle, data: string): Promise<void> {
    const p = paths(handle.runDir);
    await this.transport.exec(`cat >> ${shQuote(p.fifo)}`, { input: data });
  }

  /** Reads everything appended to the run's output log since `sinceOffset` bytes, returning the new data and the offset to pass next time. */
  async readOutput(
    handle: RemoteRunHandle,
    sinceOffset: number,
  ): Promise<{ data: string; offset: number }> {
    const p = paths(handle.runDir);
    const result = await this.transport.exec(`tail -c +${sinceOffset + 1} ${shQuote(p.log)}`);
    return { data: result.stdout, offset: sinceOffset + Buffer.byteLength(result.stdout, 'utf8') };
  }

  /** Best-effort termination; never throws (mirrors `kill ... || true` semantics remotely). */
  async stop(handle: RemoteRunHandle): Promise<void> {
    await this.transport.exec(buildStopScript(handle.runDir, handle.mode));
  }
}
