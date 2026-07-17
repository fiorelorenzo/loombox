import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalProcessTransport } from './local-process-transport';
import { FakeTransport } from './fake-transport';
import { shQuote } from './remote-transport';
import {
  chooseDetachMode,
  RemoteProcessRunner,
  type RemoteCapabilities,
} from './remote-process-runner';

describe('chooseDetachMode', () => {
  it('prefers setsid+mkfifo when both are available', () => {
    const caps: RemoteCapabilities = { setsid: true, mkfifo: true, tmux: true, screen: true };
    expect(chooseDetachMode(caps)).toBe('setsid');
  });

  it('falls back to tmux when setsid or mkfifo is missing', () => {
    expect(chooseDetachMode({ setsid: false, mkfifo: true, tmux: true, screen: true })).toBe(
      'tmux',
    );
    expect(chooseDetachMode({ setsid: true, mkfifo: false, tmux: true, screen: false })).toBe(
      'tmux',
    );
  });

  it('falls back to screen when neither setsid/mkfifo nor tmux are available', () => {
    expect(chooseDetachMode({ setsid: false, mkfifo: false, tmux: false, screen: true })).toBe(
      'screen',
    );
  });

  it('throws when the host can support none of them', () => {
    expect(() =>
      chooseDetachMode({ setsid: false, mkfifo: false, tmux: false, screen: false }),
    ).toThrow(/none of/);
  });
});

describe('RemoteProcessRunner (against LocalProcessTransport — a real local process standing in for the remote)', () => {
  let baseDir: string;
  let transport: LocalProcessTransport;
  let runner: RemoteProcessRunner;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-remote-runner-'));
    transport = new LocalProcessTransport();
    await transport.connect();
    runner = new RemoteProcessRunner(transport, { baseDir });
  });

  afterEach(async () => {
    await transport.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('detects real capabilities of this host', async () => {
    const caps = await runner.detectCapabilities();
    expect(caps.setsid).toBe(true);
    expect(caps.mkfifo).toBe(true);
    expect(caps.tmux).toBe(true);
  });

  it('launches a process under setsid that survives this transport closing (deploy-and-detach)', async () => {
    const runId = randomUUID();
    const command = `${shQuote(process.execPath)} -e ${shQuote('process.stdin.resume()')}`;
    const handle = await runner.launch(runId, command, 'setsid');

    expect(await runner.isRunning(handle)).toBe(true);

    // Closing "the SSH session" must not kill a setsid-detached child.
    await transport.close();
    const transport2 = new LocalProcessTransport();
    await transport2.connect();
    const runner2 = new RemoteProcessRunner(transport2, { baseDir });

    const attached = await runner2.attach(runId);
    expect(attached).toBeDefined();
    expect(attached?.alive).toBe(true);
    expect(attached?.handle.mode).toBe('setsid');

    await runner2.stop(attached!.handle);
    // kill is asynchronous; poll briefly for the process to actually exit.
    const deadline = Date.now() + 2000;
    let alive = true;
    while (Date.now() < deadline) {
      alive = await runner2.isRunning(attached!.handle);
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive).toBe(false);
    await transport2.close();
  });

  it('round-trips input written to the fifo and output tailed from the log', async () => {
    const runId = randomUUID();
    // A tiny real "agent": uppercases each line it reads from stdin and
    // writes it back out, exactly the shape a real ACP agent's stdio loop
    // has (read a line, react, write a line).
    const script =
      'const rl=require("readline").createInterface({input:process.stdin});' +
      'rl.on("line",l=>process.stdout.write(l.toUpperCase()+"\\n"));';
    const command = `${shQuote(process.execPath)} -e ${shQuote(script)}`;
    const handle = await runner.launch(runId, command, 'setsid');

    await runner.writeInput(handle, 'hello\n');
    // Poll readOutput until the reaction shows up (the fifo write and the
    // agent's reaction are both async w.r.t. this test).
    let seen = '';
    let offset = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.includes('HELLO')) {
      const read = await runner.readOutput(handle, offset);
      seen += read.data;
      offset = read.offset;
      if (!seen.includes('HELLO')) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(seen).toContain('HELLO');

    await runner.writeInput(handle, 'again\n');
    while (Date.now() < deadline && !seen.includes('AGAIN')) {
      const read = await runner.readOutput(handle, offset);
      seen += read.data;
      offset = read.offset;
      if (!seen.includes('AGAIN')) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(seen).toContain('AGAIN');

    await runner.stop(handle);
  });

  it('launches under tmux and reattaches to the same session by runId', async () => {
    const runId = randomUUID();
    const command = `${shQuote(process.execPath)} -e ${shQuote('process.stdin.resume()')}`;
    const handle = await runner.launch(runId, command, 'tmux');
    expect(handle.mode).toBe('tmux');
    expect(await runner.isRunning(handle)).toBe(true);

    const attached = await runner.attach(runId);
    expect(attached?.handle.mode).toBe('tmux');
    expect(attached?.alive).toBe(true);

    await runner.stop(handle);
    expect(await runner.isRunning(handle)).toBe(false);
  });

  it('launchWithFallback picks the native mode by default and surfaces that choice', async () => {
    const runId = randomUUID();
    const command = `${shQuote(process.execPath)} -e ${shQuote('process.stdin.resume()')}`;
    const { handle, mode, usedFallback } = await runner.launchWithFallback(runId, command);
    expect(mode).toBe('setsid');
    expect(usedFallback).toBe(false);
    await runner.stop(handle);
  });

  it('launchWithFallback falls back to tmux when native is explicitly disabled, and a reconnect can read its buffered output', async () => {
    const runId = randomUUID();
    const script =
      'process.stdout.write("hello from fallback\\n");' +
      'require("readline").createInterface({input:process.stdin});';
    const command = `${shQuote(process.execPath)} -e ${shQuote(script)}`;
    const { handle, mode, usedFallback } = await runner.launchWithFallback(runId, command, {
      forceFallback: true,
    });
    expect(mode).toBe('tmux');
    expect(usedFallback).toBe(true);

    // Reconnect: a fresh runner instance re-attaches and can still read the
    // output the process buffered while nobody was watching.
    const runner2 = new RemoteProcessRunner(transport, { baseDir });
    const attached = await runner2.attach(runId);
    expect(attached?.alive).toBe(true);
    expect(attached?.handle.mode).toBe('tmux');

    let seen = '';
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !seen.includes('hello from fallback')) {
      const read = await runner2.readOutput(attached!.handle, 0);
      seen = read.data;
      if (!seen.includes('hello from fallback'))
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(seen).toContain('hello from fallback');

    await runner.stop(handle);
  });

  it('attach() returns undefined for a runId that was never launched', async () => {
    const attached = await runner.attach(randomUUID());
    expect(attached).toBeUndefined();
  });

  it('rejects an unsafe runId rather than interpolating it into a shell command', async () => {
    await expect(runner.launch('../evil; rm -rf /', 'true', 'setsid')).rejects.toThrow(/runId/);
  });
});

describe('RemoteProcessRunner (against FakeTransport — decision logic only)', () => {
  it('surfaces a non-zero launch exit code as a rejected promise rather than a silent no-op', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        if (command.includes('$HOME')) return { stdout: '/home/remote', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'setsid: command not found', exitCode: 127 };
      },
    });
    await transport.connect();
    const runner = new RemoteProcessRunner(transport);

    await expect(runner.launch('run-1', 'true', 'setsid')).rejects.toThrow(/exit 127/);
  });
});
