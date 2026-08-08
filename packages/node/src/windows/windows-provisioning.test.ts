import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WINDOWS_TASK_NAME,
  executeWindowsTaskProvisioning,
  generateWindowsLauncherScript,
  generateWindowsTaskXml,
  planWindowsTaskProvisioning,
  winQuoteArg,
  type SchtasksResult,
  type WindowsTaskConfig,
  type WindowsTaskIo,
} from './windows-provisioning';

function fakeIo(
  overrides: Partial<WindowsTaskIo> & { schtasksResponses?: Record<string, SchtasksResult> } = {},
): WindowsTaskIo & { files: Map<string, string>; schtasksCalls: string[][] } {
  const { schtasksResponses = {}, ...ioOverrides } = overrides;
  const files = new Map<string, string>();
  const schtasksCalls: string[][] = [];
  return {
    platform: 'win32',
    localAppData: () => 'C:\\Users\\lorenzo\\AppData\\Local',
    systemRoot: () => 'C:\\Windows',
    userId: () => 'DEVBOX\\lorenzo',
    readFile: (path) => files.get(path),
    writeFile: (path, content) => {
      files.set(path, content);
    },
    mkdir: () => {
      /* in-memory — no real directory to create */
    },
    removeFile: (path) => {
      files.delete(path);
    },
    schtasks: async (args) => {
      schtasksCalls.push(args);
      return schtasksResponses[args[0] ?? ''] ?? { stdout: '', stderr: '', exitCode: 0 };
    },
    files,
    schtasksCalls,
    ...ioOverrides,
  };
}

const BASE_TASK: WindowsTaskConfig = {
  execStart: 'C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\current\\node.exe',
  execArgs: ['C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\current\\node.mjs'],
  environment: { LOOMBOX_RELAY_URL: 'wss://relay.example', LOOMBOX_NODE_ID: 'win-1' },
  userId: 'DEVBOX\\lorenzo',
};

describe('winQuoteArg (CommandLineToArgvW-compatible quoting, issue #659)', () => {
  it('wraps a plain path in quotes even without special characters', () => {
    expect(winQuoteArg('C:\\Windows\\System32\\cmd.exe')).toBe('"C:\\Windows\\System32\\cmd.exe"');
  });

  it('wraps an argument containing a space', () => {
    expect(winQuoteArg('C:\\Program Files\\node\\node.exe')).toBe(
      '"C:\\Program Files\\node\\node.exe"',
    );
  });

  it('doubles a trailing run of backslashes immediately before the closing quote', () => {
    expect(winQuoteArg('C:\\dir\\')).toBe('"C:\\dir\\\\"');
  });

  it('escapes an embedded literal double quote, doubling any backslashes immediately before it', () => {
    expect(winQuoteArg('foo"bar')).toBe('"foo\\"bar"');
    expect(winQuoteArg('foo\\"bar')).toBe('"foo\\\\\\"bar"');
  });

  it('leaves a backslash not immediately followed by a quote unescaped', () => {
    expect(winQuoteArg('C:\\dir\\file.exe')).toBe('"C:\\dir\\file.exe"');
  });

  it('quotes an empty string', () => {
    expect(winQuoteArg('')).toBe('""');
  });
});

describe('generateWindowsLauncherScript (issue #659 — Task Scheduler has no env-vars field)', () => {
  it('renders a set line per env var, then the quoted command, CRLF-terminated', () => {
    const script = generateWindowsLauncherScript(BASE_TASK);
    expect(script).toContain('@echo off\r\n');
    expect(script).toContain('set "LOOMBOX_RELAY_URL=wss://relay.example"\r\n');
    expect(script).toContain('set "LOOMBOX_NODE_ID=win-1"\r\n');
    expect(script).toContain(
      '"C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\current\\node.exe" ' +
        '"C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\current\\node.mjs"\r\n',
    );
    // No stray LF-only line endings anywhere in a file meant to be a real .cmd.
    expect(script).not.toMatch(/(?<!\r)\n/);
  });

  it('doubles a literal % in an env value so cmd.exe never treats it as a %VAR% expansion', () => {
    const script = generateWindowsLauncherScript({
      ...BASE_TASK,
      environment: { LOOMBOX_TOKEN: '50%off' },
    });
    expect(script).toContain('set "LOOMBOX_TOKEN=50%%off"');
  });

  it('throws rather than silently mishandling an env value containing a double quote', () => {
    expect(() =>
      generateWindowsLauncherScript({ ...BASE_TASK, environment: { X: 'has"quote' } }),
    ).toThrow(/double quote/);
  });

  it('throws rather than silently mishandling an env value containing a newline', () => {
    expect(() =>
      generateWindowsLauncherScript({ ...BASE_TASK, environment: { X: 'line1\nline2' } }),
    ).toThrow(/newline/);
  });

  it('renders with no env vars at all when environment is empty', () => {
    const script = generateWindowsLauncherScript({ ...BASE_TASK, environment: {} });
    expect(script).not.toContain('set "');
    expect(script.startsWith('@echo off\r\n')).toBe(true);
  });
});

describe('generateWindowsTaskXml (issue #659)', () => {
  const xml = generateWindowsTaskXml({
    userId: 'DEVBOX\\lorenzo',
    command: 'C:\\Windows\\System32\\cmd.exe',
    arguments: '/d /c "C:\\Users\\lorenzo\\AppData\\Local\\loombox\\run.cmd"',
    description: 'loombox resident node',
  });

  it('scopes the LogonTrigger and Principal to the given user, never an unscoped (any-user) trigger', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>DEVBOX\\lorenzo</UserId>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('sets ExecutionTimeLimit to unlimited (PT0S), overriding the 72-hour default kill', () => {
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  it('never disallows or stops on battery power, so a laptop node does not die on unplug', () => {
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  });

  it('sets a bounded RestartOnFailure, since Windows has no "restart forever" primitive', () => {
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<Count>200</Count>');
  });

  it('points the action at cmd.exe /d /c with the launcher path, never execStart directly', () => {
    expect(xml).toContain('<Command>C:\\Windows\\System32\\cmd.exe</Command>');
    expect(xml).toContain(
      '<Arguments>/d /c &quot;C:\\Users\\lorenzo\\AppData\\Local\\loombox\\run.cmd&quot;</Arguments>',
    );
  });

  it('omits WorkingDirectory when not given, and includes it when given', () => {
    expect(xml).not.toContain('<WorkingDirectory>');
    const withWorkDir = generateWindowsTaskXml({
      userId: 'DEVBOX\\lorenzo',
      command: 'C:\\Windows\\System32\\cmd.exe',
      arguments: '/d /c "run.cmd"',
      workingDirectory: 'C:\\Users\\lorenzo\\AppData\\Local\\.loombox',
    });
    expect(withWorkDir).toContain(
      '<WorkingDirectory>C:\\Users\\lorenzo\\AppData\\Local\\.loombox</WorkingDirectory>',
    );
  });

  it('is well-formed: every opened element closes, CRLF-terminated throughout', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n')).toBe(true);
    expect(xml.trimEnd().endsWith('</Task>')).toBe(true);
    expect(xml).not.toMatch(/(?<!\r)\n/);
    const opens = xml.match(/<([A-Za-z]+)(?:\s[^>]*)?>/g) ?? [];
    const closes = xml.match(/<\/([A-Za-z]+)>/g) ?? [];
    expect(opens.length).toBe(closes.length);
  });

  it('XML-escapes an unsafe description', () => {
    const escaped = generateWindowsTaskXml({
      userId: 'DEVBOX\\lorenzo',
      command: 'C:\\Windows\\System32\\cmd.exe',
      arguments: '/d /c "run.cmd"',
      description: 'AT&T <node> "quoted"',
    });
    expect(escaped).toContain(
      '<Description>AT&amp;T &lt;node&gt; &quot;quoted&quot;</Description>',
    );
  });
});

describe('planWindowsTaskProvisioning (issue #659)', () => {
  it('reports unsupported (platformSupported: false) off-Windows and never reads any file', () => {
    const io = fakeIo({ platform: 'linux' });
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    expect(plan.platformSupported).toBe(false);
    expect(plan.action).toBe('unsupported');
    expect(plan.message).toMatch(/Windows-only/);
  });

  it('reports install with no prior file on disk', () => {
    const io = fakeIo();
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    expect(plan.action).toBe('install');
    expect(plan.taskName).toBe(DEFAULT_WINDOWS_TASK_NAME);
    expect(plan.taskXmlPath).toBe('C:\\Users\\lorenzo\\AppData\\Local\\loombox\\task.xml');
    expect(plan.launcherPath).toBe('C:\\Users\\lorenzo\\AppData\\Local\\loombox\\run.cmd');
  });

  it('reports noop when the exact desired XML and launcher script are already on disk', () => {
    const io = fakeIo();
    const first = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    io.files.set(first.taskXmlPath, first.desiredTaskXml);
    io.files.set(first.launcherPath, first.desiredLauncherScript);

    const second = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    expect(second.action).toBe('noop');
  });

  it('reports update when the task XML exists but differs (e.g. a changed env var)', () => {
    const io = fakeIo();
    const first = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    io.files.set(first.taskXmlPath, first.desiredTaskXml);
    io.files.set(first.launcherPath, first.desiredLauncherScript);

    const changed: WindowsTaskConfig = {
      ...BASE_TASK,
      environment: { ...BASE_TASK.environment, LOOMBOX_NODE_ID: 'win-2' },
    };
    const second = planWindowsTaskProvisioning(io, { task: changed });
    expect(second.action).toBe('update');
  });

  it('reports update when only the launcher script differs (task XML content unaffected)', () => {
    const io = fakeIo();
    const first = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    io.files.set(first.taskXmlPath, first.desiredTaskXml);
    io.files.set(first.launcherPath, 'stale launcher content');

    const second = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    expect(second.action).toBe('update');
  });

  it('respects an explicit taskName and scriptDir override', () => {
    const io = fakeIo();
    const plan = planWindowsTaskProvisioning(io, {
      task: { ...BASE_TASK, taskName: '\\loombox\\node-preview' },
      scriptDir: 'C:\\Users\\lorenzo\\AppData\\Local\\.loombox-preview',
    });
    expect(plan.taskName).toBe('\\loombox\\node-preview');
    expect(plan.taskXmlPath).toBe('C:\\Users\\lorenzo\\AppData\\Local\\.loombox-preview\\task.xml');
  });
});

describe('executeWindowsTaskProvisioning (issue #659)', () => {
  it('runs nothing for a noop plan', async () => {
    const io = fakeIo();
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    io.files.set(plan.taskXmlPath, plan.desiredTaskXml);
    io.files.set(plan.launcherPath, plan.desiredLauncherScript);
    const noopPlan = planWindowsTaskProvisioning(io, { task: BASE_TASK });

    const result = await executeWindowsTaskProvisioning(io, noopPlan);
    expect(result).toEqual({ ok: true, action: 'noop', ranCommands: [] });
    expect(io.schtasksCalls).toEqual([]);
  });

  it('runs nothing and fails for an unsupported plan', async () => {
    const io = fakeIo({ platform: 'darwin' });
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });

    const result = await executeWindowsTaskProvisioning(io, plan);
    expect(result.ok).toBe(false);
    expect(result.action).toBe('unsupported');
    expect(io.schtasksCalls).toEqual([]);
  });

  it('a fresh install writes both files, creates via /Create /XML, and kicks it with /Run — never /End first', async () => {
    const io = fakeIo();
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });

    const result = await executeWindowsTaskProvisioning(io, plan);
    expect(result).toEqual({
      ok: true,
      action: 'install',
      ranCommands: [
        ['/Create', '/XML', plan.taskXmlPath, '/TN', DEFAULT_WINDOWS_TASK_NAME, '/F'],
        ['/Run', '/TN', DEFAULT_WINDOWS_TASK_NAME],
      ],
    });
    expect(io.files.get(plan.taskXmlPath)).toBe(plan.desiredTaskXml);
    expect(io.files.get(plan.launcherPath)).toBe(plan.desiredLauncherScript);
  });

  it('an update first /Ends the previous registration, best-effort, before /Create + /Run', async () => {
    const io = fakeIo();
    const first = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    io.files.set(first.taskXmlPath, 'stale-xml');
    io.files.set(first.launcherPath, 'stale-script');
    const updatePlan = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    expect(updatePlan.action).toBe('update');

    const result = await executeWindowsTaskProvisioning(io, updatePlan);
    expect(result.ok).toBe(true);
    expect(result.action).toBe('update');
    expect(io.schtasksCalls).toEqual([
      ['/End', '/TN', DEFAULT_WINDOWS_TASK_NAME],
      ['/Create', '/XML', updatePlan.taskXmlPath, '/TN', DEFAULT_WINDOWS_TASK_NAME, '/F'],
      ['/Run', '/TN', DEFAULT_WINDOWS_TASK_NAME],
    ]);
  });

  it('stops at a failing /Create and never runs /Run', async () => {
    const io = fakeIo({
      schtasksResponses: { '/Create': { stdout: '', stderr: 'access is denied', exitCode: 1 } },
    });
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });

    const result = await executeWindowsTaskProvisioning(io, plan);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schtasks \/Create failed/);
    expect(io.schtasksCalls.map((c) => c[0])).toEqual(['/Create']);
  });

  it('reports failure when /Run fails after a successful /Create — LogonTrigger alone would leave it not running', async () => {
    const io = fakeIo({
      schtasksResponses: { '/Run': { stdout: '', stderr: 'the task is disabled', exitCode: 1 } },
    });
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });

    const result = await executeWindowsTaskProvisioning(io, plan);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schtasks \/Run failed/);
  });

  it('fails post-install verification if the write silently did not land', async () => {
    const io = fakeIo();
    const plan = planWindowsTaskProvisioning(io, { task: BASE_TASK });
    const realWriteFile = io.writeFile;
    io.writeFile = (path, content) => {
      if (path === plan.taskXmlPath) return; // simulate a write that silently no-ops
      realWriteFile(path, content);
    };

    const result = await executeWindowsTaskProvisioning(io, plan);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/post-install verification failed/);
  });
});
