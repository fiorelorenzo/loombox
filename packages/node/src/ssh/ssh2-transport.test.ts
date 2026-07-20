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
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class FakeSshStream extends MiniEmitter {
    stderr = new MiniEmitter();
    end(): this {
      queueMicrotask(() => this.emit('close', 0));
      return this;
    }
  }

  class FakeSsh2Client extends MiniEmitter {
    execCalls: string[] = [];
    connect(): void {
      queueMicrotask(() => this.emit('ready'));
    }
    exec(command: string, callback: (err: Error | undefined, stream: FakeSshStream) => void): void {
      this.execCalls.push(command);
      callback(undefined, new FakeSshStream());
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
