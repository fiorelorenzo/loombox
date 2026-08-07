import { describe, expect, it, vi } from 'vitest';

import { wrapForLoginShell } from './login-shell';
import { Ssh2Transport } from './ssh2-transport';

describe('Ssh2Transport', () => {
  it('refuses exec() before connect() rather than hanging or crashing on a null client', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await expect(transport.exec('true')).rejects.toThrow(/not connected/);
  });

  it('close() before connect() is a harmless no-op', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

/**
 * A minimal fake of `ssh2`'s `Client`, standing in for the real network
 * client so `exec()`'s login-shell wrapping (issue #73) is provable without a
 * live sshd: records exactly the command string it was asked to run and
 * replies with a trivial closed stream. Declared inside `vi.hoisted` since
 * `vi.mock`'s factory is itself hoisted above normal module-level code.
 */
const { FakeSsh2Client } = vi.hoisted(() => {
  // A tiny hand-rolled single-event emitter (no `node:events` import here:
  // `vi.hoisted`'s factory runs before this file's own imports are live, so
  // referencing an imported binding from inside it would throw).
  class MiniEmitter {
    private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    on(event: string, listener: (...args: unknown[]) => void): this {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }
    off(event: string, listener: (...args: unknown[]) => void): this {
      const existing = this.listeners.get(event);
      if (existing)
        this.listeners.set(
          event,
          existing.filter((l) => l !== listener),
        );
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class FakeSshStream extends MiniEmitter {
    stderr = new MiniEmitter();
    writeCalls: string[] = [];
    setWindowCalls: Array<[number, number, number, number]> = [];
    end(): this {
      queueMicrotask(() => this.emit('close', 0));
      return this;
    }
    write(data: Buffer | string): boolean {
      this.writeCalls.push(typeof data === 'string' ? data : data.toString('utf8'));
      return true;
    }
    setWindow(rows: number, cols: number, height: number, width: number): void {
      this.setWindowCalls.push([rows, cols, height, width]);
    }
  }

  class FakeSsh2Client extends MiniEmitter {
    execCalls: string[] = [];
    /** `exec()` calls made WITH a `pty` option (issue #704's `openShellChannel` mechanism) — `execCalls` above still gets the plain command string too, so the login-shell-wrapping tests need no change. */
    execPtyCalls: Array<{ command: string; pty: { term?: string; cols?: number; rows?: number } }> =
      [];
    execError: Error | undefined;
    forwardOutCalls: Array<[string, number, string, number]> = [];
    forwardOutError: Error | undefined;
    shellCalls: Array<{ term?: string; cols?: number; rows?: number }> = [];
    shellError: Error | undefined;
    lastShellStream: FakeSshStream | undefined;
    connect(): void {
      queueMicrotask(() => this.emit('ready'));
    }
    exec(
      command: string,
      optionsOrCallback:
        | { pty?: { term?: string; cols?: number; rows?: number } }
        | ((err: Error | undefined, stream: FakeSshStream) => void),
      callback?: (err: Error | undefined, stream: FakeSshStream) => void,
    ): void {
      this.execCalls.push(command);
      const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;
      const pty = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback.pty;
      if (pty) this.execPtyCalls.push({ command, pty });
      if (this.execError) {
        cb(this.execError, undefined as unknown as FakeSshStream);
        return;
      }
      const stream = new FakeSshStream();
      if (pty) this.lastShellStream = stream;
      cb(undefined, stream);
    }
    forwardOut(
      srcHost: string,
      srcPort: number,
      dstHost: string,
      dstPort: number,
      callback: (err: Error | undefined, stream: FakeSshStream) => void,
    ): void {
      this.forwardOutCalls.push([srcHost, srcPort, dstHost, dstPort]);
      if (this.forwardOutError) {
        callback(this.forwardOutError, undefined as unknown as FakeSshStream);
        return;
      }
      callback(undefined, new FakeSshStream());
    }
    shell(
      window: { term?: string; cols?: number; rows?: number },
      callback: (err: Error | undefined, stream: FakeSshStream) => void,
    ): void {
      this.shellCalls.push(window);
      if (this.shellError) {
        callback(this.shellError, undefined as unknown as FakeSshStream);
        return;
      }
      const stream = new FakeSshStream();
      this.lastShellStream = stream;
      callback(undefined, stream);
    }
    end(): void {}
  }

  return { FakeSsh2Client };
});

vi.mock('ssh2', () => ({ Client: FakeSsh2Client }));

describe('Ssh2Transport (login-shell wrapping, issue #73 — against a fake ssh2 Client)', () => {
  it('sends every exec() command wrapped through wrapForLoginShell by default', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();
    await transport.exec('node --version');

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    expect(client.execCalls).toEqual([wrapForLoginShell('node --version')]);
  });

  it('sends the command unwrapped when loginShell: false is set', async () => {
    const transport = new Ssh2Transport({
      host: 'example.invalid',
      username: 'nobody',
      loginShell: false,
    });
    await transport.connect();
    await transport.exec('node --version');

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    expect(client.execCalls).toEqual(['node --version']);
  });
});

describe('Ssh2Transport.openForwardChannel (issue #92 — against a fake ssh2 Client)', () => {
  it('rejects before connect() rather than hanging or crashing', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await expect(transport.openForwardChannel('127.0.0.1', 1, '127.0.0.1', 2)).rejects.toThrow(
      /not connected/,
    );
  });

  it('delegates to the underlying client.forwardOut with the exact given addresses', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const stream = await transport.openForwardChannel('127.0.0.1', 5000, 'localhost', 8080);
    expect(stream).toBeDefined();

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    expect(client.forwardOutCalls).toEqual([['127.0.0.1', 5000, 'localhost', 8080]]);
  });

  it('rejects when the underlying forwardOut fails (e.g. AllowTcpForwarding disabled remotely)', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    client.forwardOutError = new Error('open failed');

    await expect(transport.openForwardChannel('127.0.0.1', 1, '127.0.0.1', 2)).rejects.toThrow(
      /open failed/,
    );
  });
});

describe('Ssh2Transport.openShellChannel (issue #172 — against a fake ssh2 Client; issue #704 — exec-into-cwd, not a typed cd)', () => {
  it('rejects before connect() rather than hanging or crashing', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await expect(transport.openShellChannel({ cols: 80, rows: 24, cwd: '/work' })).rejects.toThrow(
      /not connected/,
    );
  });

  it('execs `cd <cwd> && exec "$SHELL" -l` with a pty of the given cols/rows/term — never client.shell(), and never a typed cd (issue #704)', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    await transport.openShellChannel({ cols: 100, rows: 30, cwd: '/home/dev/project' });

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    expect(client.shellCalls).toEqual([]);
    expect(client.execPtyCalls).toEqual([
      {
        command: 'cd \'/home/dev/project\' && exec "$SHELL" -l',
        pty: { term: 'xterm-256color', cols: 100, rows: 30 },
      },
    ]);
  });

  it('shell-quotes a cwd with spaces or shell metacharacters rather than splicing it in raw', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    await transport.openShellChannel({ cols: 80, rows: 24, cwd: '/home/dev/my project (2)' });

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    expect(client.execPtyCalls[0]?.command).toBe(
      'cd \'/home/dev/my project (2)\' && exec "$SHELL" -l',
    );
  });

  it('rejects when the underlying exec() fails', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    client.execError = new Error('no pty available');

    await expect(transport.openShellChannel({ cols: 80, rows: 24, cwd: '/work' })).rejects.toThrow(
      /no pty available/,
    );
  });

  it('write() forwards to the underlying stream', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const channel = await transport.openShellChannel({ cols: 80, rows: 24, cwd: '/work' });
    channel.write('echo hi\n');

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    expect(client.lastShellStream?.writeCalls).toEqual(['echo hi\n']);
  });

  it('resize() forwards to the underlying stream.setWindow(rows, cols, ...)', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const channel = await transport.openShellChannel({ cols: 80, rows: 24, cwd: '/work' });
    channel.resize(120, 40);

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    expect(client.lastShellStream?.setWindowCalls).toEqual([[40, 120, 0, 0]]);
  });

  it('onData receives both the stream and its stderr sub-stream', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const channel = await transport.openShellChannel({ cols: 80, rows: 24, cwd: '/work' });
    const received: string[] = [];
    channel.onData((chunk) => received.push(Buffer.from(chunk).toString('utf8')));

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    client.lastShellStream?.emit('data', Buffer.from('stdout chunk'));
    client.lastShellStream?.stderr.emit('data', Buffer.from('stderr chunk'));

    expect(received).toEqual(['stdout chunk', 'stderr chunk']);
  });

  it('onClose fires with the exit code once the channel closes', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const channel = await transport.openShellChannel({ cols: 80, rows: 24, cwd: '/work' });
    let exitEvent: { exitCode: number } | undefined;
    channel.onClose((event) => {
      exitEvent = event;
    });

    const client = (transport as unknown as { client: InstanceType<typeof FakeSsh2Client> }).client;
    client.lastShellStream?.emit('exit', 3);
    client.lastShellStream?.emit('close');

    expect(exitEvent).toEqual({ exitCode: 3 });
  });

  it('end() ends the underlying stream', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await transport.connect();

    const channel = await transport.openShellChannel({ cols: 80, rows: 24, cwd: '/work' });
    let closed = false;
    channel.onClose(() => {
      closed = true;
    });
    channel.end();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(true);
  });
});

// Real-network smoke test, skipped by default (no live SSH host in this
// hermetic test environment). Set LOOMBOX_TEST_SSH_HOST (+ optionally
// LOOMBOX_TEST_SSH_PORT/_USER/_KEY_PATH) to run it against a real sshd, e.g.
// the Dockerized SSH fixture issues #80/#84 call for in a CI environment
// that has Docker available.
const sshHost = process.env.LOOMBOX_TEST_SSH_HOST;
describe.skipIf(!sshHost)('Ssh2Transport (real SSH — LOOMBOX_TEST_SSH_HOST)', () => {
  it('connects, execs a command, and closes cleanly against a real sshd', async () => {
    const transport = new Ssh2Transport({
      host: sshHost!,
      port: process.env.LOOMBOX_TEST_SSH_PORT ? Number(process.env.LOOMBOX_TEST_SSH_PORT) : 22,
      username: process.env.LOOMBOX_TEST_SSH_USER ?? 'root',
      privateKeyPath: process.env.LOOMBOX_TEST_SSH_KEY_PATH,
    });

    await transport.connect();
    const result = await transport.exec('echo hello-from-remote');
    expect(result.stdout.trim()).toBe('hello-from-remote');
    expect(result.exitCode).toBe(0);
    await transport.close();
  });
});
