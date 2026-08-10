import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import type { RunExitResult } from '../test-runner-process';
import {
  buildWindowsJobLaunchScript,
  buildWindowsPowerShellArgs,
  classifyWindowsExitCode,
  escapePowerShellSingleQuoted,
  startWindowsLocalRun,
  WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE,
  WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE,
} from './windows-job-runner';

/**
 * Stands in for a real `ChildProcess` — this suite runs on Linux, so
 * `powershell.exe` is never actually spawned; every test below either
 * exercises pure string/argv construction directly, or drives
 * `startWindowsLocalRun` against this fake to prove its `RunHandle`
 * contract (the seam `../test-runner-process.ts`'s `startLocalRun`
 * dispatches into on `win32`) without needing a real Windows process.
 */
class FakeWindowsChildProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly kill = vi.fn();
}

function collectRun(): {
  outputs: string[];
  exits: RunExitResult[];
  onOutput: (chunk: Uint8Array) => void;
  onExit: (result: RunExitResult) => void;
} {
  const outputs: string[] = [];
  const exits: RunExitResult[] = [];
  return {
    outputs,
    exits,
    onOutput: (chunk) => outputs.push(Buffer.from(chunk).toString('utf8')),
    onExit: (result) => exits.push(result),
  };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('escapePowerShellSingleQuoted', () => {
  it('wraps a plain value in single quotes', () => {
    expect(escapePowerShellSingleQuoted('pnpm test')).toBe("'pnpm test'");
  });

  it('doubles an embedded single quote — the only escape a PS single-quoted literal needs', () => {
    expect(escapePowerShellSingleQuoted("it's fine")).toBe("'it''s fine'");
  });

  it('leaves backslashes, dollar signs, and backticks untouched (none are special inside single quotes)', () => {
    expect(escapePowerShellSingleQuoted('C:\\repo && echo $HOME `date`')).toBe(
      "'C:\\repo && echo $HOME `date`'",
    );
  });

  it('quotes an empty string', () => {
    expect(escapePowerShellSingleQuoted('')).toBe("''");
  });
});

describe('buildWindowsJobLaunchScript (issue #940)', () => {
  const script = buildWindowsJobLaunchScript('pnpm test');

  it('creates a job object and sets JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, never a breakaway flag', () => {
    expect(script).toContain('CreateJobObjectW');
    expect(script).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000');
    expect(script).toContain('SetInformationJobObject');
    expect(script).not.toMatch(/BREAKAWAY/i);
  });

  it('assigns the running PowerShell host itself to the job, so forked children inherit membership', () => {
    expect(script).toContain('AssignProcessToJobObject');
    expect(script).toContain('[System.Diagnostics.Process]::GetCurrentProcess().Handle');
  });

  it('never uses taskkill — issue #940 explicitly rejects the /T PID-walk shortcut', () => {
    expect(script.toLowerCase()).not.toContain('taskkill');
  });

  it('runs the command through cmd.exe /d /c, merging stderr into stdout like the POSIX sh -c path', () => {
    expect(script).toContain("& cmd.exe /d /c '(pnpm test) 2>&1'");
  });

  it('propagates the real command exit code via $LASTEXITCODE', () => {
    expect(script.trimEnd().endsWith('exit $LASTEXITCODE')).toBe(true);
  });

  it('exits with the shared sentinel on each of the three job-setup failure points', () => {
    const setupFailureLines = script
      .split('\r\n')
      .filter((line) => line.includes(`exit ${WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE}`));
    expect(setupFailureLines).toHaveLength(3);
  });

  it('embeds a command containing a single quote correctly escaped, not a raw injection point', () => {
    const withQuote = buildWindowsJobLaunchScript("echo 'hi'");
    expect(withQuote).toContain("& cmd.exe /d /c '(echo ''hi'') 2>&1'");
  });

  it('is CRLF-terminated throughout, matching every other generated Windows text file in this codebase', () => {
    expect(script).not.toMatch(/(?<!\r)\n/);
  });
});

describe('buildWindowsPowerShellArgs (issue #940)', () => {
  it('runs non-interactively, without a user profile, bypassing execution policy for this invocation only', () => {
    const args = buildWindowsPowerShellArgs('pnpm test');
    expect(args.slice(0, 4)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
    ]);
    expect(args[4]).toBe('-EncodedCommand');
  });

  it("encodes exactly buildWindowsJobLaunchScript's own output as base64 UTF-16LE — the documented -EncodedCommand format", () => {
    const command = 'pnpm test && pnpm lint';
    const args = buildWindowsPowerShellArgs(command);
    const encoded = args[5] ?? '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toBe(buildWindowsJobLaunchScript(command));
  });
});

describe('classifyWindowsExitCode (issue #940)', () => {
  it('classifies 0 as pass', () => {
    expect(classifyWindowsExitCode(0)).toEqual({ outcome: 'pass', exitCode: 0 });
  });

  it('classifies a real nonzero command exit code as fail', () => {
    expect(classifyWindowsExitCode(3)).toEqual({ outcome: 'fail', exitCode: 3 });
  });

  it("classifies cmd.exe's real 9009 as could_not_start / command not found, the Windows analogue of POSIX 127", () => {
    expect(classifyWindowsExitCode(WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE)).toEqual({
      outcome: 'could_not_start',
      exitCode: WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE,
      reason: 'command not found',
    });
  });

  it('classifies the job-setup-failure sentinel as could_not_start with a distinct reason, never confused with a real command exit code', () => {
    const result = classifyWindowsExitCode(WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE);
    expect(result.outcome).toBe('could_not_start');
    expect(result.reason).toMatch(/job object setup failed/);
  });
});

describe("startWindowsLocalRun (issue #940 — the seam's contract, spawn mocked since no Windows host exists here)", () => {
  it("spawns powershell.exe with exactly buildWindowsPowerShellArgs's own argv, streams inherited, real stderr ignored", () => {
    const fakeChild = new FakeWindowsChildProcess();
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    startWindowsLocalRun({ command: 'pnpm test', onOutput: run.onOutput, onExit: run.onExit });

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      buildWindowsPowerShellArgs('pnpm test'),
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
  });

  it('streams stdout chunks through onOutput as they arrive', () => {
    const fakeChild = new FakeWindowsChildProcess();
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    startWindowsLocalRun({ command: 'pnpm test', onOutput: run.onOutput, onExit: run.onExit });
    fakeChild.stdout.emit('data', Buffer.from('hello\n'));
    expect(run.outputs.join('')).toBe('hello\n');
  });

  it('settles onExit with the classified real exit code exactly once', () => {
    const fakeChild = new FakeWindowsChildProcess();
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    startWindowsLocalRun({ command: 'pnpm test', onOutput: run.onOutput, onExit: run.onExit });
    fakeChild.emit('exit', 0);
    fakeChild.emit('exit', 0); // a stray second emission must never double-settle
    expect(run.exits).toEqual([{ outcome: 'pass', exitCode: 0 }]);
  });

  it('surfaces the job-setup-failure sentinel through the same onExit contract, never as a silent pass', () => {
    const fakeChild = new FakeWindowsChildProcess();
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    startWindowsLocalRun({ command: 'pnpm test', onOutput: run.onOutput, onExit: run.onExit });
    fakeChild.emit('exit', WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE);
    expect(run.exits).toEqual([classifyWindowsExitCode(WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE)]);
  });

  it('reports could_not_start when powershell.exe itself never starts (e.g. ENOENT), same shape as the POSIX sh-missing case', () => {
    const fakeChild = new FakeWindowsChildProcess();
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    startWindowsLocalRun({ command: 'pnpm test', onOutput: run.onOutput, onExit: run.onExit });
    fakeChild.emit('error', new Error('spawn powershell.exe ENOENT'));
    expect(run.exits).toEqual([
      { outcome: 'could_not_start', exitCode: null, reason: 'spawn powershell.exe ENOENT' },
    ]);
  });

  it('cancel() terminates only the wrapper pid via child.kill() — never a negative pid, since Windows has no process group to signal', async () => {
    const fakeChild = new FakeWindowsChildProcess();
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    const handle = startWindowsLocalRun({
      command: 'pnpm test',
      onOutput: run.onOutput,
      onExit: run.onExit,
    });
    await handle.cancel();

    expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    expect(fakeChild.kill).toHaveBeenCalledWith();
  });

  it('cancel() marks the eventual exit as cancelled', async () => {
    const fakeChild = new FakeWindowsChildProcess();
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    const handle = startWindowsLocalRun({
      command: 'pnpm test',
      onOutput: run.onOutput,
      onExit: run.onExit,
    });
    await handle.cancel();
    fakeChild.emit('exit', null);
    expect(run.exits).toEqual([{ outcome: 'fail', exitCode: null, cancelled: true }]);
  });

  it('cancelling an already-exited run never throws, even if child.kill() itself would', async () => {
    const fakeChild = new FakeWindowsChildProcess();
    fakeChild.kill.mockImplementation(() => {
      throw new Error('process already exited');
    });
    spawnMock.mockReturnValue(fakeChild);
    const run = collectRun();

    const handle = startWindowsLocalRun({
      command: 'pnpm test',
      onOutput: run.onOutput,
      onExit: run.onExit,
    });
    await expect(handle.cancel()).resolves.toBeUndefined();
  });

  it('reports could_not_start, without throwing, if spawn() itself throws synchronously', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('EPERM');
    });
    const run = collectRun();

    const handle = startWindowsLocalRun({
      command: 'pnpm test',
      onOutput: run.onOutput,
      onExit: run.onExit,
    });
    expect(run.exits).toEqual([{ outcome: 'could_not_start', exitCode: null, reason: 'EPERM' }]);
    return expect(handle.cancel()).resolves.toBeUndefined();
  });
});
