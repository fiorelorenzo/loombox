import type { Duplex } from 'node:stream';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { FakeTransport } from './fake-transport';
import type { PortForwardTransport } from './port-forward-transport';
import { ReconnectingTransport, defaultIsRetryableError } from './reconnecting-transport';
import type { RemoteTransport } from './remote-transport';

/** A `RemoteTransport` that also implements `PortForwardTransport`, for proving `ReconnectingTransport` delegates `openForwardChannel` to whichever inner transport is currently live. */
class FakePortForwardCapableTransport extends FakeTransport implements PortForwardTransport {
  readonly forwardCalls: Array<{
    srcHost: string;
    srcPort: number;
    dstHost: string;
    dstPort: number;
  }> = [];

  async openForwardChannel(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
  ): Promise<Duplex> {
    this.forwardCalls.push({ srcHost, srcPort, dstHost, dstPort });
    return new PassThrough();
  }
}

function connectionResetError(): NodeJS.ErrnoException {
  const error = new Error('read ECONNRESET') as NodeJS.ErrnoException;
  error.code = 'ECONNRESET';
  return error;
}

function authError(): Error {
  return Object.assign(new Error('All configured authentication methods failed'), {
    level: 'client-authentication',
  });
}

const noSleep = async (): Promise<void> => {};

describe('defaultIsRetryableError', () => {
  it('treats network-shaped errors as retryable', () => {
    expect(defaultIsRetryableError(connectionResetError())).toBe(true);
    expect(
      defaultIsRetryableError(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })),
    ).toBe(true);
    expect(defaultIsRetryableError(new Error('socket hang up'))).toBe(true);
  });

  it('treats an auth rejection as non-retryable', () => {
    expect(defaultIsRetryableError(authError())).toBe(false);
  });

  it('treats an unrelated error as non-retryable', () => {
    expect(defaultIsRetryableError(new Error('command not found'))).toBe(false);
  });
});

describe('ReconnectingTransport', () => {
  it('connects lazily and reuses the same underlying transport across exec() calls (no drop)', async () => {
    let createCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      return new FakeTransport({ onExec: () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) });
    };

    const transport = new ReconnectingTransport(createTransport, { sleep: noSleep });
    await transport.connect();
    await transport.exec('one');
    await transport.exec('two');

    expect(createCount).toBe(1);
    expect(transport.getHealth()).toMatchObject({ status: 'connected', attempts: 0 });
  });

  it('detects a mid-session drop and transparently reconnects and resumes the failed exec() (immediate reconnect, no backoff needed)', async () => {
    let createCount = 0;
    let execCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      const instance = createCount;
      return new FakeTransport({
        onExec: () => {
          execCount += 1;
          if (instance === 1 && execCount === 2) throw connectionResetError();
          return { stdout: `ok-${instance}`, stderr: '', exitCode: 0 };
        },
      });
    };

    const sleeps: number[] = [];
    const transport = new ReconnectingTransport(createTransport, {
      initialBackoffMs: 10,
      maxBackoffMs: 40,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await transport.connect();
    await expect(transport.exec('one')).resolves.toMatchObject({ stdout: 'ok-1' });

    // This call hits the scripted drop on instance 1's second exec, then
    // transparently reconnects (instance 2) and resumes — the caller sees
    // a normal successful result, never the ECONNRESET. The fresh
    // connection succeeds on its first try, so there's nothing to back off
    // between (see the next test for the backoff-actually-elapses case).
    await expect(transport.exec('two')).resolves.toMatchObject({ stdout: 'ok-2' });

    expect(createCount).toBe(2);
    expect(sleeps).toEqual([]);
    expect(transport.getHealth()).toMatchObject({ status: 'connected', attempts: 0 });
  });

  it('backs off between reconnect attempts when the fresh connection itself fails before succeeding', async () => {
    let createCount = 0;
    let execCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      const instance = createCount;
      if (instance === 2) {
        // The first reconnect attempt itself fails once (e.g. the link is
        // still flaky right after the blip) before a later attempt
        // succeeds — this is what the backoff delay is between.
        return {
          connect: async () => {
            throw connectionResetError();
          },
          exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          close: async () => {},
        };
      }
      return new FakeTransport({
        onExec: () => {
          execCount += 1;
          if (instance === 1 && execCount === 2) throw connectionResetError();
          return { stdout: `ok-${instance}`, stderr: '', exitCode: 0 };
        },
      });
    };

    const sleeps: number[] = [];
    const transport = new ReconnectingTransport(createTransport, {
      initialBackoffMs: 10,
      maxBackoffMs: 40,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await transport.connect();
    await expect(transport.exec('one')).resolves.toMatchObject({ stdout: 'ok-1' });
    await expect(transport.exec('two')).resolves.toMatchObject({ stdout: 'ok-3' });

    // instance 1 (initial), instance 2 (a reconnect attempt that itself
    // failed), instance 3 (the reconnect attempt that finally succeeded).
    expect(createCount).toBe(3);
    expect(sleeps).toEqual([10]);
    expect(transport.getHealth()).toMatchObject({ status: 'connected', attempts: 0 });
  });

  it('reuses one reconnect attempt for two exec() calls racing the same drop (no duplicate connections)', async () => {
    let createCount = 0;
    let execCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      const instance = createCount;
      return new FakeTransport({
        onExec: () => {
          execCount += 1;
          if (instance === 1) throw connectionResetError();
          return { stdout: `ok-${instance}`, stderr: '', exitCode: 0 };
        },
      });
    };

    const transport = new ReconnectingTransport(createTransport, {
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      sleep: noSleep,
    });
    await transport.connect();

    const [a, b] = await Promise.all([transport.exec('a'), transport.exec('b')]);
    expect(a.stdout).toBe('ok-2');
    expect(b.stdout).toBe('ok-2');
    // One connect() + exactly one reconnect, never two competing reconnects.
    expect(createCount).toBe(2);
    // Both calls' initial attempts against instance 1, both retried against instance 2.
    expect(execCount).toBe(4);
  });

  it('a permanent failure (retries exhausted) surfaces cleanly instead of retrying forever', async () => {
    const createTransport = (): RemoteTransport =>
      new FakeTransport({ connectError: connectionResetError() });

    const transport = new ReconnectingTransport(createTransport, {
      maxAttempts: 3,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      sleep: noSleep,
    });

    await expect(transport.connect()).rejects.toThrow(/ECONNRESET/);
    expect(transport.getHealth().status).toBe('failed');
  });

  it('a non-retryable failure (auth rejection) propagates immediately without retrying', async () => {
    let createCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      return new FakeTransport({ connectError: authError() });
    };

    const transport = new ReconnectingTransport(createTransport, {
      maxAttempts: 5,
      initialBackoffMs: 1,
      sleep: noSleep,
    });

    await expect(transport.connect()).rejects.toThrow(/authentication/);
    expect(createCount).toBe(1);
    expect(transport.getHealth().status).toBe('failed');
  });

  it('exec() propagates a non-retryable error without attempting to reconnect', async () => {
    let createCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      return new FakeTransport({
        onExec: () => {
          throw new Error('command not found');
        },
      });
    };

    const transport = new ReconnectingTransport(createTransport, { sleep: noSleep });
    await transport.connect();
    await expect(transport.exec('bad-command')).rejects.toThrow(/command not found/);
    expect(createCount).toBe(1);
    expect(transport.getHealth().status).toBe('connected');
  });

  it('close() tears down the underlying connection and a later connect() opens a fresh one', async () => {
    let createCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      return new FakeTransport({ onExec: () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) });
    };

    const transport = new ReconnectingTransport(createTransport, { sleep: noSleep });
    await transport.connect();
    await transport.close();
    expect(transport.getHealth().status).toBe('disconnected');

    await transport.connect();
    expect(createCount).toBe(2);
    expect(transport.getHealth().status).toBe('connected');
  });

  it('discards a reconnect that resolves after close() instead of resurrecting the connection', async () => {
    let resolveConnect: (() => void) | undefined;
    let underlyingClosed = false;
    const createTransport = (): RemoteTransport => ({
      connect: () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      close: async () => {
        underlyingClosed = true;
      },
    });

    const transport = new ReconnectingTransport(createTransport, { sleep: noSleep });
    const connecting = transport.connect();
    // `close()` runs while the underlying connect() is still pending.
    await transport.close();
    resolveConnect?.();
    // The in-flight attempt eventually rejects (it discards its own
    // now-stale connection) rather than silently resurrecting it.
    await expect(connecting).rejects.toThrow();
    await vi.waitFor(() => expect(underlyingClosed).toBe(true));
    expect(transport.getHealth().status).not.toBe('connected');
  });

  describe('openForwardChannel (issue #92)', () => {
    it('delegates to the currently-connected inner transport when it supports port forwarding', async () => {
      const inner = new FakePortForwardCapableTransport();
      const transport = new ReconnectingTransport(() => inner, { sleep: noSleep });

      await transport.connect();
      const channel = await transport.openForwardChannel('127.0.0.1', 5000, 'localhost', 8080);

      expect(channel).toBeDefined();
      expect(inner.forwardCalls).toEqual([
        { srcHost: '127.0.0.1', srcPort: 5000, dstHost: 'localhost', dstPort: 8080 },
      ]);
    });

    it('reconnects first if not currently connected, then delegates', async () => {
      let createCount = 0;
      const createTransport = (): RemoteTransport => {
        createCount += 1;
        return new FakePortForwardCapableTransport();
      };
      const transport = new ReconnectingTransport(createTransport, { sleep: noSleep });

      // Never explicitly connect()ed — openForwardChannel() itself must
      // trigger the initial connection, exactly like exec() does.
      const channel = await transport.openForwardChannel('127.0.0.1', 1, '127.0.0.1', 2);
      expect(channel).toBeDefined();
      expect(createCount).toBe(1);
    });

    it('throws a clear error when the inner transport does not support port forwarding', async () => {
      const transport = new ReconnectingTransport(() => new FakeTransport(), { sleep: noSleep });
      await transport.connect();

      await expect(transport.openForwardChannel('127.0.0.1', 1, '127.0.0.1', 2)).rejects.toThrow(
        /does not support port forwarding/,
      );
    });
  });
});
