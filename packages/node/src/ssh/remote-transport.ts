/**
 * The seam every `ssh:` target mechanism in this directory is built against
 * (issue #80). A `RemoteTransport` is a connection to *some* host that can
 * run shell commands: production uses {@link Ssh2Transport} (real SSH via
 * `ssh2`); tests use {@link LocalProcessTransport} (a real child-process
 * "remote" running on this machine, so deploy/detach/reattach mechanics are
 * exercised for real without a live SSH server) or {@link FakeTransport} (a
 * scriptable stand-in for pure decision-logic tests). Nothing above this
 * interface — deploy, launch, tmux fallback, verify & persist — needs to know
 * which one it's talking to.
 *
 * Deliberately narrow: `connect`/`exec`/`close`. There is no `openChannel` or
 * persistent streaming primitive — every mechanism built on top (output
 * tailing, fifo-fed stdin) is expressed as repeated `exec` calls instead, so
 * a transport implementation stays this small. See `remote-process-runner.ts`
 * for why that's sufficient (short-lived execs against a detached remote
 * process's log/fifo, not a long-lived channel to the process itself).
 */
export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RemoteExecOptions {
  /** Bytes written to the command's stdin, then closed. Omit for no stdin (closed immediately). */
  input?: string;
}

export interface RemoteTransport {
  /** Establishes the connection. Rejects with a descriptive error on auth failure, unreachable host, etc. Idempotent while already connected. */
  connect(): Promise<void>;
  /** Runs one command via the remote shell (`sh -c <command>`) and resolves with its captured output once it exits. */
  exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult>;
  /** Tears down the connection. Never kills anything the remote side detached (setsid/tmux/screen) from this transport's own session. */
  close(): Promise<void>;
}

/** Quotes a single path/argument for safe interpolation into a POSIX `sh -c` command string (single-quote wrapping, escaping embedded `'`). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
