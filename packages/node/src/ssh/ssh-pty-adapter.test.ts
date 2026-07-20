import { describe, expect, it } from 'vitest';
import type { ShellChannel } from './shell-transport';
import { shellChannelToPty } from './ssh-pty-adapter';

/** A scriptable fake `ShellChannel` — the same role `FakeTransport` plays for `RemoteTransport` elsewhere in this directory. */
function fakeShellChannel(): ShellChannel & {
  emitData(chunk: Uint8Array): void;
  emitClose(exitCode: number): void;
  written: string[];
  resized: Array<{ cols: number; rows: number }>;
  ended: boolean;
} {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<(event: { exitCode: number }) => void>();
  const written: string[] = [];
  const resized: Array<{ cols: number; rows: number }> = [];
  let ended = false;

  return {
    written,
    resized,
    get ended() {
      return ended;
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    write(data) {
      written.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    resize(cols, rows) {
      resized.push({ cols, rows });
    },
    end() {
      ended = true;
      for (const listener of closeListeners) listener({ exitCode: 0 });
    },
    emitData(chunk) {
      for (const listener of dataListeners) listener(chunk);
    },
    emitClose(exitCode) {
      for (const listener of closeListeners) listener({ exitCode });
    },
  };
}

describe('shellChannelToPty (the ssh: terminal backend seam, issue #172)', () => {
  it('forwards onData chunks through unchanged', () => {
    const channel = fakeShellChannel();
    const pty = shellChannelToPty(channel);

    let received: Uint8Array | undefined;
    pty.onData((chunk) => {
      received = chunk;
    });
    channel.emitData(new TextEncoder().encode('remote output'));

    expect(received && Buffer.from(received).toString('utf8')).toBe('remote output');
  });

  it('forwards write() to the channel', () => {
    const channel = fakeShellChannel();
    const pty = shellChannelToPty(channel);

    pty.write('typed input');
    expect(channel.written).toEqual(['typed input']);
  });

  it('forwards resize() to the channel', () => {
    const channel = fakeShellChannel();
    const pty = shellChannelToPty(channel);

    pty.resize(120, 40);
    expect(channel.resized).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('kill() ends the channel', () => {
    const channel = fakeShellChannel();
    const pty = shellChannelToPty(channel);

    pty.kill();
    expect(channel.ended).toBe(true);
  });

  it('translates onClose into onExit with the exit code', () => {
    const channel = fakeShellChannel();
    const pty = shellChannelToPty(channel);

    let exitEvent: { exitCode: number; signal?: number } | undefined;
    pty.onExit((event) => {
      exitEvent = event;
    });
    channel.emitClose(7);

    expect(exitEvent).toEqual({ exitCode: 7 });
  });
});
