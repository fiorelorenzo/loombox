/**
 * The narrow capability an `ssh:` target's interactive terminal needs (SPEC
 * §7.5; issues #172/#173) beyond `RemoteTransport`'s `connect`/`exec`/
 * `close`: a persistent, full-duplex channel with a remote PTY allocated on
 * it — `ssh2`'s `Client.shell()`, the same wire mechanism an interactive
 * `ssh host` (no command) uses (SPEC §16 grounding: "ssh2 drain/backpressure
 * per emdash's ssh2-pty.ts"). A separate interface rather than folding this
 * into `RemoteTransport` itself, exactly like `PortForwardTransport`
 * (`./port-forward-transport.ts`) — not every `RemoteTransport` needs it,
 * and `RemoteTransport` stays "deliberately narrow".
 *
 * Implemented by {@link Ssh2Transport} (via `ssh2`'s `Client.shell()`) and by
 * `ReconnectingTransport` (delegating to whichever concrete transport is
 * currently connected) — so a terminal opened against the pooled transport
 * `SshTransportPool` hands out rides on that same reconnecting connection,
 * exactly like a port-forward tunnel does.
 *
 * `ShellChannel` is intentionally its own small interface (not the raw
 * `ssh2` stream type, and not a bare `node:stream` `Duplex`): a resize needs
 * `ssh2`'s own `setWindow`, which isn't part of `Duplex`, and shaping this as
 * `@loombox/supervisor`'s own `PtyLike` contract (`onData`/`onExit`/`write`/
 * `resize`/`kill`) is what lets `NodeDaemon` adopt an `ssh:` terminal into a
 * `TerminalSupervisor` via `openWithPty()` without that package ever
 * depending on `ssh2` (see `./ssh-pty-adapter.ts`).
 */

export interface ShellChannelOptions {
  cols: number;
  rows: number;
}

export interface ShellChannel {
  /** Registers a listener for output chunks (both the channel's stdout and stderr streams, exactly like a real terminal — a PTY has no separate stderr); returns an unsubscribe function. */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** Registers a listener for the channel closing, whether via {@link end} or the remote shell exiting on its own; returns an unsubscribe function. `signal` is never populated over SSH2 (the wire protocol reports an exit-status or exit-signal message, never both — this adapter only ever surfaces the exit-status case, which is what every remote shell actually sends on a normal exit). */
  onClose(listener: (event: { exitCode: number }) => void): () => void;
  write(data: Uint8Array | string): void;
  /** Renegotiates the remote PTY's window size (`ssh2`'s `setWindow`). */
  resize(cols: number, rows: number): void;
  /** Ends the channel. Does not close the underlying SSH connection — other channels (execs, other terminals, tunnels) keep working. */
  end(): void;
}

export interface ShellTransport {
  openShellChannel(options: ShellChannelOptions): Promise<ShellChannel>;
}

/** Runtime check for whether `transport` also implements {@link ShellTransport} — used where a plain `RemoteTransport` is held but a shell channel is optionally needed (e.g. `ReconnectingTransport`, delegating to its current inner transport). */
export function supportsShellChannel(transport: unknown): transport is ShellTransport {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as Partial<ShellTransport>).openShellChannel === 'function'
  );
}
