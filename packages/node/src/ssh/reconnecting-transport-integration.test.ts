import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalProcessTransport } from './local-process-transport';
import { ReconnectingTransport } from './reconnecting-transport';
import { RemoteProcessRunner } from './remote-process-runner';
import {
  shQuote,
  type RemoteExecOptions,
  type RemoteExecResult,
  type RemoteTransport,
} from './remote-transport';

/**
 * Wraps a real `LocalProcessTransport` and can be told to simulate `n`
 * consecutive connection drops on its next `exec()` calls — a real detached
 * process stands in for "the remote supervisor/session" (same fixture
 * `RemoteProcessRunner`'s own tests use), only the *transport* between here
 * and it is flaky, exactly the shape of a real SSH link blip.
 */
class DroppableTransport implements RemoteTransport {
  private readonly delegate = new LocalProcessTransport();

  constructor(private readonly dropCounter: { remaining: number }) {}

  async connect(): Promise<void> {
    await this.delegate.connect();
  }

  async exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
    if (this.dropCounter.remaining > 0) {
      this.dropCounter.remaining -= 1;
      const error = new Error('read ECONNRESET') as NodeJS.ErrnoException;
      error.code = 'ECONNRESET';
      throw error;
    }
    return this.delegate.exec(command, options);
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }
}

describe('ReconnectingTransport + RemoteProcessRunner (a real detached process, a simulated mid-session drop)', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-reconnecting-transport-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('a simulated drop mid-session does not tear down the in-flight remote run; work resumes once reconnected', async () => {
    // Shared across every underlying `DroppableTransport` instance the
    // reconnect loop creates, so "drop the next N execs" survives a
    // reconnect (a fresh instance, same counter).
    const dropCounter = { remaining: 0 };
    let createCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      return new DroppableTransport(dropCounter);
    };

    const transport = new ReconnectingTransport(createTransport, {
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      sleep: async () => {},
    });
    await transport.connect();
    expect(createCount).toBe(1);

    const runner = new RemoteProcessRunner(transport, { baseDir });
    const command = `${shQuote(process.execPath)} -e ${shQuote(
      "let i=0; const t=setInterval(()=>{process.stdout.write('tick'+(i++)+'\\n');},20); setTimeout(()=>{clearInterval(t);},5000);",
    )}`;
    const { handle } = await runner.launchWithFallback('flaky-session', command);

    // Let the detached process actually start producing output before the
    // simulated drop, so this proves a genuinely in-flight run survives it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const firstRead = await runner.readOutput(handle, 0);
    expect(firstRead.data.length).toBeGreaterThan(0);

    // Simulate the SSH link dropping mid-session: the next couple of
    // `exec()` calls (whichever ones the poller happens to make) fail as a
    // dropped connection would.
    dropCounter.remaining = 2;

    // The caller (standing in for `RemoteProcessRunner`/`RemoteAgentChildProcess`
    // polling) never sees the drop: the wrapper reconnects underneath it.
    const stillAlive = await runner.isRunning(handle);
    expect(stillAlive).toBe(true);
    expect(createCount).toBeGreaterThan(1); // a reconnect actually happened

    // The remote run itself was never torn down by the drop — reading its
    // output continues from where it left off, proving the in-flight
    // process was re-attached rather than restarted.
    const secondRead = await runner.readOutput(handle, firstRead.offset);
    expect(secondRead.offset).toBeGreaterThanOrEqual(firstRead.offset);

    await runner.stop(handle);
    // kill is asynchronous; poll briefly for the process to actually exit
    // (same pattern `remote-process-runner.test.ts` uses for setsid mode).
    const deadline = Date.now() + 2000;
    let alive = true;
    while (Date.now() < deadline) {
      alive = await runner.isRunning(handle);
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive).toBe(false);
  });

  it('a permanent connection failure surfaces cleanly from the runner rather than hanging', async () => {
    const createTransport = (): RemoteTransport => ({
      connect: async () => {
        const error = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException;
        error.code = 'ECONNREFUSED';
        throw error;
      },
      exec: async () => {
        throw new Error('unreachable in this test');
      },
      close: async () => {},
    });

    const transport = new ReconnectingTransport(createTransport, {
      maxAttempts: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      sleep: async () => {},
    });

    await expect(transport.connect()).rejects.toThrow(/ECONNREFUSED/);

    const runner = new RemoteProcessRunner(transport, { baseDir });
    await expect(runner.detectCapabilities()).rejects.toThrow();
    expect(transport.getHealth().status).toBe('failed');
  });
});
