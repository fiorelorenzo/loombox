import type { TargetDescriptor } from '@loombox/protocol';

/**
 * Execution-target types this node exposes (SPEC §5.2, §6): `local` runs the
 * agent on the node's own machine in a git worktree (fully implemented,
 * `SessionManager`); `ssh:` runs it on a remote host reachable over SSH,
 * deployed and launched via `packages/node/src/ssh/` (issue #80/#81/#82/#84:
 * `RemoteTransport`/`Ssh2Transport`, `RemoteProcessRunner`'s deploy-and-detach
 * with a tmux/screen fallback, `SessionLeaseManager`, and
 * `verifyAndPersistSshTarget`). `NodeDaemon.createSession()` routes an
 * `ssh:` target's session through that machinery, wrapped in a
 * `RemoteAgentChildProcess` so it plugs into `AgentSupervisor.startWithChild`
 * exactly like a `local` session plugs into `AgentSupervisor.start`.
 *
 * Known, deliberate gap in this wave: unlike `local`'s per-session isolated
 * git worktree, an `ssh:` session runs directly in `projectPath` on the
 * remote host — remote worktree/branch management over SSH is a natural
 * follow-up (SPEC §5.2 mentions it as part of the target's general
 * capability set) but isn't asked for by issues #80/#81/#82/#84.
 */

/** A completed command's captured output and exit status — the same shape as `RemoteTransport`'s `RemoteExecResult` (see `./ssh/remote-transport.ts`), so `SshExecutionTarget` returns it unchanged. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  /** Working directory the command runs in. `LocalExecutionTarget` passes this straight to `child_process.spawn`; `SshExecutionTarget` prefixes the remote command with `cd <cwd> &&`. Omit to run in the target's own default (the node process's cwd for `local`; the remote login shell's default for `ssh:`). */
  cwd?: string;
  /** Bytes written to the command's stdin, then closed. Omit for no stdin (closed immediately, as with `RemoteTransport.exec`). */
  input?: string;
  /** Extra environment variables merged over the target's own default environment. Local only — `SshExecutionTarget` has no per-call env override in this wave (SPEC §9's login-shell PATH capture is a separate, already-solved concern; see `verify-and-persist.ts`). */
  env?: Record<string, string>;
}

/**
 * The shared contract `local` and `ssh:` targets both implement (SPEC §5.2,
 * §6; issue #69): the exec + basic filesystem operations the node needs to
 * drive a session on either kind of target through one interface, so
 * higher-level code (the supervisor's spawn, and a future editor/terminal)
 * never has to branch on which kind of target it's talking to.
 *
 * Deliberately narrow, mirroring `RemoteTransport`'s own "deliberately
 * narrow" seam (`./ssh/remote-transport.ts`): one-shot `exec` plus four
 * filesystem primitives, no persistent/streaming channel. `LocalExecutionTarget`
 * runs commands and touches the filesystem directly via `node:child_process`/
 * `node:fs`; `SshExecutionTarget` wraps an existing `RemoteTransport`
 * (reusing whichever pooled, reconnecting transport `NodeDaemon` already
 * holds for that `ssh:` target — see `NodeDaemon.getExecutionTarget()` —
 * rather than opening a second connection) and expresses every filesystem
 * operation as a shell command against it.
 */
export interface ExecutionTarget {
  readonly kind: 'local' | 'ssh';
  /** Runs `command` with `args` (never shell-interpolated by the caller — each implementation is responsible for quoting safely) and resolves with its captured output and exit code once it exits. Never rejects merely because the command exited non-zero (that's `ExecResult.exitCode`'s job, mirroring a shell's own semantics); rejects only when the command itself could not be started (e.g. not found) or the transport fails. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Reads a file's full contents as UTF-8 text. Throws if it doesn't exist or can't be read. */
  readFile(path: string): Promise<string>;
  /** Writes `content` to a file, creating or truncating it. */
  writeFile(path: string, content: string): Promise<void>;
  /** Creates a directory, including any missing parent directories (like `mkdir -p`). A no-op if it already exists. */
  mkdir(path: string): Promise<void>;
  /** Lists a directory's entry names (not full paths), excluding `.`/`..`. Throws if `path` doesn't exist or isn't a directory. */
  readdir(path: string): Promise<string[]>;
}

/** The single `local` target every node exposes by default. */
export const DEFAULT_LOCAL_TARGET: TargetDescriptor = {
  id: 'local',
  kind: 'local',
  label: 'Local',
};

/**
 * The connection recipe one `ssh:` target needs (`NodeDaemonOptions.sshTargets`,
 * keyed by matching the `TargetDescriptor.id` this node also announces).
 * Auth tries, in order (see `Ssh2Transport`): `privateKeyPath`, then
 * `ssh-agent` (autodetected via `$SSH_AUTH_SOCK` unless `agent` overrides or
 * disables it), then `password` as a last resort — matching SPEC §7.23's
 * autodetect ("picks up your keys and ssh-agent").
 */
export interface SshTargetConfig {
  id: string;
  label: string;
  host: string;
  user?: string;
  port?: number;
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  agent?: string | false;
}
