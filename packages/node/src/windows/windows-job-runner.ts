import { spawn } from 'node:child_process';

import type { RunExitResult, RunHandle, StartRunOptions } from '../test-runner-process';

/**
 * The Windows counterpart of `../test-runner-process.ts`'s `startLocalRun`
 * (issue #940, filed out of #659's own Windows-local node work; epic #653).
 * Plugs into the exact same seam — `StartRunOptions` in, `RunHandle` out,
 * `RunExitResult` on exit — rather than becoming a parallel mechanism: see
 * `startWindowsLocalRun` below, which `startLocalRun` dispatches to on
 * `process.platform === 'win32'` and nowhere else.
 *
 * **Why this needs to exist at all.** `startLocalRun`'s POSIX path spawns
 * `sh -c` with `detached: true`, which makes the shell the leader of a new
 * process group, and `cancel()` signals the whole group with the
 * negative-pid convention (`process.kill(-pid, ...)`, issue #244/#642/#645).
 * Windows has no process groups in that sense — `detached: true` and a
 * negative pid are meaningless there. The documented Win32 equivalent is a
 * **Job Object**: put the launched process (and anything it forks, since
 * nothing here sets `CREATE_BREAKAWAY_FROM_JOB`) in a job created with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and the kernel kills every process
 * still in that job the moment the job's last open handle closes — no
 * `taskkill /PID <pid> /T /F` PID/parent-PID/creation-time walk (#940's own
 * framing of exactly why that shortcut is the wrong one: it can miss a
 * re-parented or already-exited-and-PID-reused child, the same class of
 * leak #642 fixed on POSIX).
 *
 * **How, with no native addon in this repo (#940's own constraint).**
 * `buildWindowsJobLaunchScript` renders a PowerShell script that P/Invokes
 * `kernel32.dll` directly (`Add-Type -TypeDefinition` compiling inline C#
 * at runtime — no separate native module to build or ship) to create the
 * job, set the kill-on-close limit, and assign **itself** (the PowerShell
 * host process, not the eventual command) to it, before ever launching the
 * real command via `cmd.exe /d /c`. Assigning the host rather than the
 * command matters: Windows automatically adds every new child process to
 * every job its creator already belongs to, so `cmd.exe` — and anything
 * *it* forks, at any depth — inherits job membership for free, without a
 * second `AssignProcessToJobObject` call once the actual command's pid is
 * known.
 *
 * The wrapper is invoked with `-EncodedCommand` (a base64, UTF-16LE
 * argument) rather than an inline `-Command` string, specifically so the
 * generated script — which itself embeds a C# heredoc *and* the caller's
 * shell command — never has to survive a second, lossy round trip through
 * `cmd.exe`'s or PowerShell's own command-line quoting.
 *
 * **The kill itself is then almost trivial.** `startWindowsLocalRun`'s
 * `cancel()` does not call into the job at all — it just terminates the
 * *wrapper* pid (`child.kill()`, which Node/libuv map unconditionally to
 * `TerminateProcess` on win32 regardless of the signal argument). Since
 * that pid holds the job's only open handle, terminating it closes that
 * handle, and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the kernel take
 * every remaining process in the job down with it — topology-independent,
 * exactly like the POSIX negative-pid group kill, without ever needing to
 * enumerate a single child pid from Node's side.
 *
 * **Explicitly unverified — there is no Windows machine anywhere this was
 * written.** The struct layouts and P/Invoke signatures below match the
 * documented Win32 SDK headers (`JOBOBJECT_BASIC_LIMIT_INFORMATION`,
 * `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`, `IO_COUNTERS`,
 * `JobObjectExtendedLimitInformation = 9`,
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000`) and the job-object-closes-
 * kills-everything behavior is Microsoft's own documented contract for that
 * flag, but neither `Add-Type`'s runtime C# compile, the P/Invoke marshaling,
 * nor the actual kill has ever executed once. Real-machine verification is
 * #939 (filed for #659, the same "no Windows box in this environment"
 * constraint, extended here rather than duplicated). Everything that *can*
 * be checked without Windows — the generated script's content, the
 * `-EncodedCommand` argument construction, and `startLocalRun`'s dispatch
 * and `RunHandle` contract with `spawn` mocked — is covered by this
 * module's own test file.
 */

/**
 * Sentinel exit code `buildWindowsJobLaunchScript`'s own generated script
 * returns when `CreateJobObjectW`/`SetInformationJobObject`/
 * `AssignProcessToJobObject` itself fails, before the caller's command ever
 * runs — distinct from any real exit code the *command* could produce, the
 * same role `classifyExitCode`'s hardcoded `127` plays for "sh itself
 * couldn't run the command" on POSIX. Chosen arbitrarily outside the
 * 0-255 range a normal console app's own `ExitProcess` call realistically
 * uses, and shared between the generator and the classifier below so the
 * two can never drift apart.
 */
export const WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE = 4290;

/** `cmd.exe`'s own real, documented exit code for "not recognized as an internal or external command" — the Windows analogue of POSIX's `127`, not a value this codebase invented. */
export const WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE = 9009;

/**
 * Quotes `value` as a PowerShell single-quoted string literal — the only
 * escape a single-quoted literal ever needs is doubling an embedded literal
 * quote (`'` → `''`); unlike a double-quoted PS string or a Windows
 * `CommandLineToArgvW` argument (`../windows-provisioning.ts`'s own
 * `winQuoteArg`), backslashes, `$`, and backticks are never special inside
 * one, so there is nothing else here to get wrong.
 */
export function escapePowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Renders the PowerShell script `startWindowsLocalRun` runs via
 * `-EncodedCommand`. See this module's own top doc comment for the full
 * mechanism; in short: create a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_
 * CLOSE`, assign the running PowerShell host itself to it (so every process
 * it goes on to fork inherits membership automatically), then run `command`
 * through `cmd.exe /d /c` — `/d` disables AutoRun the same way `../windows-
 * provisioning.ts`'s own launcher invocation does — wrapped in `(...)
 * 2>&1`, the same "merge stderr into stdout, one uniform stream" shape
 * `startLocalRun`'s own `sh -c '(command) 2>&1'` uses, so callers see one
 * combined stream on either platform. Ends by propagating `cmd.exe`'s own
 * `$LASTEXITCODE` as this script's exit code, so the caller's `classify
 * WindowsExitCode` sees the real command outcome, not PowerShell's own.
 *
 * `cmd.exe`'s `/c` command-line re-parsing has real, documented quirks
 * around embedded quotes (unlike POSIX `sh -c`, which this repo's other
 * shell-command callers already lean on) — this function does not attempt
 * to work around all of them; it draws the same kind of explicit boundary
 * `generateWindowsLauncherScript` draws for env values, rather than
 * silently mishandling an edge case. A `command` built from this repo's own
 * project-configured test/lint/build strings (`pnpm test`-shaped, no
 * embedded double quotes) is squarely inside that boundary.
 */
export function buildWindowsJobLaunchScript(command: string): string {
  const quotedCommand = escapePowerShellSingleQuoted(`(${command}) 2>&1`);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    '',
    'public static class LoomboxJobObject',
    '{',
    '    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;',
    '    public const int JobObjectExtendedLimitInformation = 9;',
    '',
    '    [StructLayout(LayoutKind.Sequential)]',
    '    public struct IO_COUNTERS',
    '    {',
    '        public ulong ReadOperationCount;',
    '        public ulong WriteOperationCount;',
    '        public ulong OtherOperationCount;',
    '        public ulong ReadTransferCount;',
    '        public ulong WriteTransferCount;',
    '        public ulong OtherTransferCount;',
    '    }',
    '',
    '    [StructLayout(LayoutKind.Sequential)]',
    '    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION',
    '    {',
    '        public long PerProcessUserTimeLimit;',
    '        public long PerJobUserTimeLimit;',
    '        public uint LimitFlags;',
    '        public UIntPtr MinimumWorkingSetSize;',
    '        public UIntPtr MaximumWorkingSetSize;',
    '        public uint ActiveProcessLimit;',
    '        public UIntPtr Affinity;',
    '        public uint PriorityClass;',
    '        public uint SchedulingClass;',
    '    }',
    '',
    '    [StructLayout(LayoutKind.Sequential)]',
    '    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION',
    '    {',
    '        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;',
    '        public IO_COUNTERS IoInfo;',
    '        public UIntPtr ProcessMemoryLimit;',
    '        public UIntPtr JobMemoryLimit;',
    '        public UIntPtr PeakProcessMemoryUsed;',
    '        public UIntPtr PeakJobMemoryUsed;',
    '    }',
    '',
    '    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);',
    '',
    '    [DllImport("kernel32.dll", SetLastError = true)]',
    '    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);',
    '',
    '    [DllImport("kernel32.dll", SetLastError = true)]',
    '    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);',
    '}',
    "'@",
    '',
    '$job = [LoomboxJobObject]::CreateJobObjectW([IntPtr]::Zero, $null)',
    `if ($job -eq [IntPtr]::Zero) { exit ${WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE} }`,
    '',
    '$limits = New-Object LoomboxJobObject+JOBOBJECT_EXTENDED_LIMIT_INFORMATION',
    '$limits.BasicLimitInformation.LimitFlags = [LoomboxJobObject]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
    '$limitsSize = [System.Runtime.InteropServices.Marshal]::SizeOf($limits)',
    `if (-not [LoomboxJobObject]::SetInformationJobObject($job, [LoomboxJobObject]::JobObjectExtendedLimitInformation, [ref]$limits, $limitsSize)) { exit ${WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE} }`,
    '',
    '$self = [System.Diagnostics.Process]::GetCurrentProcess().Handle',
    `if (-not [LoomboxJobObject]::AssignProcessToJobObject($job, $self)) { exit ${WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE} }`,
    '',
    `& cmd.exe /d /c ${quotedCommand}`,
    'exit $LASTEXITCODE',
  ];
  return lines.map((line) => `${line}\r\n`).join('');
}

/**
 * Full `powershell.exe` argv (excluding the executable name itself) for
 * running `command` inside a kill-on-close Job Object. `-EncodedCommand`
 * over `-Command`: the generated script embeds an inline C# heredoc and the
 * caller's own shell command, and `-EncodedCommand`'s base64 round trip
 * sidesteps `cmd.exe`/PowerShell command-line requoting entirely rather
 * than needing to survive it. The encoding step itself (base64 of the
 * UTF-16LE bytes — never UTF-8, never a BOM) is `-EncodedCommand`'s own
 * documented, non-negotiable input format, not a choice made here.
 * `-NoProfile`/`-NonInteractive` keep a per-user PowerShell profile script
 * from running or prompting; `-ExecutionPolicy Bypass` is scoped to this
 * one invocation only (a process argument, never a machine-wide policy
 * change) so a default `Restricted`/`AllSigned` policy on a fresh Windows
 * install can't silently block the wrapper — the resident node's own
 * launcher already runs unsigned code un-remarked-on (`node.exe` itself),
 * so this changes nothing about the actual trust boundary.
 */
export function buildWindowsPowerShellArgs(command: string): string[] {
  const encodedCommand = Buffer.from(buildWindowsJobLaunchScript(command), 'utf16le').toString(
    'base64',
  );
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ];
}

/** Classifies a real, observed exit code from `buildWindowsJobLaunchScript`'s own generated wrapper — the Windows counterpart of `../test-runner-process.ts`'s `classifyExitCode`, with one extra case that generator can produce and the POSIX one never does. */
export function classifyWindowsExitCode(exitCode: number): RunExitResult {
  if (exitCode === WINDOWS_JOB_SETUP_FAILURE_EXIT_CODE) {
    return {
      outcome: 'could_not_start',
      exitCode,
      reason:
        'windows job object setup failed (CreateJobObjectW/SetInformationJobObject/AssignProcessToJobObject)',
    };
  }
  if (exitCode === WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE) {
    return { outcome: 'could_not_start', exitCode, reason: 'command not found' };
  }
  return exitCode === 0 ? { outcome: 'pass', exitCode } : { outcome: 'fail', exitCode };
}

/**
 * The Windows counterpart of `../test-runner-process.ts`'s `startLocalRun` —
 * see this module's own top doc comment for the full mechanism. Same
 * `StartRunOptions` in, same `RunHandle` out, same "settle `onExit` exactly
 * once" discipline; only the spawn target (`powershell.exe`, never `sh`) and
 * the kill mechanism (terminate the job-holding wrapper pid directly, never
 * a negative pid — Windows has no process-group signal to send) differ.
 */
export function startWindowsLocalRun(options: StartRunOptions): RunHandle {
  const { command, onOutput, onExit } = options;
  let cancelled = false;
  let settled = false;

  const settle = (result: RunExitResult): void => {
    if (settled) return;
    settled = true;
    onExit(result);
  };

  let child;
  try {
    child = spawn('powershell.exe', buildWindowsPowerShellArgs(command), {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (error) {
    settle({
      outcome: 'could_not_start',
      exitCode: null,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { cancel: () => Promise.resolve() };
  }

  child.stdout?.on('data', (chunk: Buffer) => onOutput(new Uint8Array(chunk)));
  child.on('error', (error) => {
    // `powershell.exe` itself never started (missing from PATH — every
    // supported Windows version ships it, but never assumed unconditionally
    // here, same discipline `startLocalRun`'s own `sh`-missing branch uses).
    settle({ outcome: 'could_not_start', exitCode: null, reason: error.message });
  });
  child.on('exit', (code) => {
    if (cancelled) {
      settle({ outcome: 'fail', exitCode: code, cancelled: true });
      return;
    }
    settle(code === null ? { outcome: 'fail', exitCode: null } : classifyWindowsExitCode(code));
  });

  return {
    cancel() {
      cancelled = true;
      if (child.pid !== undefined) {
        try {
          // Job Objects, not `taskkill /T` (issue #940's own explicit
          // rejection of that shortcut): `buildWindowsJobLaunchScript` put
          // THIS wrapper process — not the launched command — in a job with
          // `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. `cmd.exe` and everything
          // it goes on to fork, at any depth, automatically inherited job
          // membership from this process when they were created (Windows
          // adds every new child to every job its creator already belongs
          // to, unless the child explicitly asks to break away, which
          // nothing here does). `child.kill()` unconditionally maps to
          // `TerminateProcess` on win32 (Node's own documented behavior —
          // the signal argument is ignored on this platform); terminating
          // just this one pid closes its only open handle to the job, and
          // the kernel then tears down every process still in it as a
          // documented side effect of that handle closing — topology-
          // independent, never a parent-PID/creation-time walk that a
          // re-parented or PID-reused child could slip past.
          child.kill();
        } catch {
          // Already exited.
        }
      }
      return Promise.resolve();
    },
  };
}
