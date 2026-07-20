import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalSupervisor } from './terminal-supervisor';

/**
 * Real short-lived PTY round-trip (no fakes): a live `bash` child, real
 * stdin/stdout over a real pseudoterminal (SPEC §7.5; issues #172/#173).
 */

let workDir: string;

async function makeWorkDir(): Promise<string> {
  workDir = await mkdtemp(join(tmpdir(), 'loombox-terminal-supervisor-'));
  return workDir;
}

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

/** Polls `check` until it returns true or `timeoutMs` elapses, then throws. Avoids a flat sleep for output that arrives asynchronously off a real child process. */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error('waitFor: condition never became true within timeout');
}

describe('TerminalSupervisor (real PTY)', () => {
  it('spawns a real shell, streams typed input to it, and streams its output back', async () => {
    const cwd = await makeWorkDir();
    const supervisor = new TerminalSupervisor();
    const session = supervisor.open({
      terminalId: 'term-1',
      file: 'bash',
      args: ['--noprofile', '--norc'],
      cwd,
      cols: 80,
      rows: 24,
    });

    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });

    session.write('echo hello-from-pty\n');

    await waitFor(() => output.includes('hello-from-pty'));

    supervisor.close('term-1');
  });

  it('resize does not throw and is a no-op observable to the caller beyond that', async () => {
    const cwd = await makeWorkDir();
    const supervisor = new TerminalSupervisor();
    supervisor.open({ terminalId: 'term-1', file: 'bash', cwd, cols: 80, rows: 24 });

    expect(() => supervisor.resize('term-1', 120, 40)).not.toThrow();

    supervisor.close('term-1');
  });

  it('close kills the PTY and removes it from the supervisor', async () => {
    const cwd = await makeWorkDir();
    const supervisor = new TerminalSupervisor();
    const session = supervisor.open({
      terminalId: 'term-1',
      file: 'bash',
      cwd,
      cols: 80,
      rows: 24,
    });

    let exited = false;
    session.onExit(() => {
      exited = true;
    });

    supervisor.close('term-1');

    await waitFor(() => exited);
    expect(supervisor.get('term-1')).toBeUndefined();
  });

  it('a shell that exits on its own (typing `exit`) fires onExit and is removed from the supervisor', async () => {
    const cwd = await makeWorkDir();
    const supervisor = new TerminalSupervisor();
    const session = supervisor.open({
      terminalId: 'term-1',
      file: 'bash',
      args: ['--noprofile', '--norc'],
      cwd,
      cols: 80,
      rows: 24,
    });

    let exitEvent: { exitCode: number; signal?: number } | undefined;
    session.onExit((event) => {
      exitEvent = event;
    });

    session.write('exit 0\n');

    await waitFor(() => exitEvent !== undefined);
    expect(exitEvent?.exitCode).toBe(0);
    await waitFor(() => supervisor.get('term-1') === undefined);
  });

  it('supports multiple terminals for the same project, sharing one working directory (issue #173)', async () => {
    const cwd = await makeWorkDir();
    const supervisor = new TerminalSupervisor();

    const a = supervisor.open({
      terminalId: 'term-a',
      file: 'bash',
      args: ['--noprofile', '--norc'],
      cwd,
      cols: 80,
      rows: 24,
    });
    const b = supervisor.open({
      terminalId: 'term-b',
      file: 'bash',
      args: ['--noprofile', '--norc'],
      cwd,
      cols: 80,
      rows: 24,
    });

    let outputA = '';
    let outputB = '';
    a.onData((chunk) => {
      outputA += Buffer.from(chunk).toString('utf8');
    });
    b.onData((chunk) => {
      outputB += Buffer.from(chunk).toString('utf8');
    });

    a.write('pwd\n');
    b.write('pwd\n');

    await waitFor(() => outputA.includes(cwd) && outputB.includes(cwd));

    expect(
      supervisor
        .list()
        .map((session) => session.terminalId)
        .sort(),
    ).toEqual(['term-a', 'term-b']);

    // Closing one terminal must not affect the other (issue #173's acceptance).
    supervisor.close('term-a');
    await waitFor(() => supervisor.get('term-a') === undefined);
    expect(supervisor.get('term-b')).toBe(b);

    outputB = '';
    b.write('echo still-alive\n');
    await waitFor(() => outputB.includes('still-alive'));

    supervisor.close('term-b');
  });

  it('throws opening a terminalId that is already open', async () => {
    const cwd = await makeWorkDir();
    const supervisor = new TerminalSupervisor();
    supervisor.open({ terminalId: 'term-1', file: 'bash', cwd, cols: 80, rows: 24 });

    expect(() =>
      supervisor.open({ terminalId: 'term-1', file: 'bash', cwd, cols: 80, rows: 24 }),
    ).toThrow();

    supervisor.close('term-1');
  });

  it('write/resize/close against an unknown terminalId are silent no-ops, not throws', () => {
    const supervisor = new TerminalSupervisor();
    expect(() => supervisor.write('missing', 'x')).not.toThrow();
    expect(() => supervisor.resize('missing', 80, 24)).not.toThrow();
    expect(() => supervisor.close('missing')).not.toThrow();
  });

  it('openWithPty adopts an already-constructed PtyLike (the ssh: terminal backend seam)', async () => {
    const dataListeners = new Set<(chunk: Uint8Array) => void>();
    const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
    let written = '';
    let resized: { cols: number; rows: number } | undefined;
    let killed = false;

    const fakePty = {
      pid: 4242,
      onData: (listener: (chunk: Uint8Array) => void) => {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      write: (data: Uint8Array | string) => {
        written += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      },
      resize: (cols: number, rows: number) => {
        resized = { cols, rows };
      },
      kill: () => {
        killed = true;
        for (const listener of exitListeners) listener({ exitCode: 0 });
      },
    };

    const supervisor = new TerminalSupervisor();
    const session = supervisor.openWithPty('term-ssh', fakePty);

    let received = '';
    session.onData((chunk) => {
      received += Buffer.from(chunk).toString('utf8');
    });
    for (const listener of dataListeners) listener(new TextEncoder().encode('remote output'));
    expect(received).toBe('remote output');

    session.write('remote input');
    expect(written).toBe('remote input');

    supervisor.resize('term-ssh', 100, 30);
    expect(resized).toEqual({ cols: 100, rows: 30 });

    supervisor.close('term-ssh');
    expect(killed).toBe(true);
    expect(supervisor.get('term-ssh')).toBeUndefined();
  });
});
