import type { PtyLike, TerminalExitEvent } from '@loombox/supervisor';
import type { ShellChannel } from './shell-transport';

/**
 * Adapts a {@link ShellChannel} (an `ssh:` target's `Client.shell()` channel,
 * `./ssh2-transport.ts`) into `@loombox/supervisor`'s {@link PtyLike}
 * contract, so `NodeDaemon` can hand an `ssh:` terminal to
 * `TerminalSupervisor.openWithPty()` exactly like a `local` terminal's real
 * `node-pty` process (issue #172's "the same terminal works identically
 * whether the target is `local` or `ssh:`"). Deliberately the only place in
 * this codebase that imports both `@loombox/supervisor`'s terminal types and
 * this directory's SSH channel type — `TerminalSupervisor` itself never
 * learns anything about SSH.
 */
export function shellChannelToPty(channel: ShellChannel): PtyLike {
  return {
    onData(listener) {
      return channel.onData(listener);
    },
    onExit(listener) {
      return channel.onClose((event: { exitCode: number }) => {
        const exitEvent: TerminalExitEvent = { exitCode: event.exitCode };
        listener(exitEvent);
      });
    },
    write(data) {
      channel.write(data);
    },
    resize(cols, rows) {
      channel.resize(cols, rows);
    },
    kill() {
      channel.end();
    },
  };
}
