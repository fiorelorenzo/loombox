import { describe, expect, it } from 'vitest';

import { FakeTransport, type FakeExecHandler } from './fake-transport';
import {
  detectRemoteOsArch,
  executeRuntimeBootstrap,
  planRuntimeBootstrap,
} from './remote-runtime';

async function fakeConnected(onExec: FakeExecHandler) {
  const transport = new FakeTransport({ onExec });
  await transport.connect();
  return transport;
}

describe('detectRemoteOsArch', () => {
  it('runs a single "uname -s -m" and normalizes linux/x64', async () => {
    const transport = await fakeConnected(() => ({
      stdout: 'Linux x86_64\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await detectRemoteOsArch(transport);
    expect(result).toEqual({ os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' });
    expect(transport.calls).toEqual(['uname -s -m']);
  });

  it('normalizes linux/arm64 (aarch64)', async () => {
    const transport = await fakeConnected(() => ({
      stdout: 'Linux aarch64\n',
      stderr: '',
      exitCode: 0,
    }));
    expect(await detectRemoteOsArch(transport)).toEqual({
      os: 'linux',
      arch: 'arm64',
      rawOs: 'Linux',
      rawArch: 'aarch64',
    });
  });

  it('normalizes darwin/arm64', async () => {
    const transport = await fakeConnected(() => ({
      stdout: 'Darwin arm64\n',
      stderr: '',
      exitCode: 0,
    }));
    expect(await detectRemoteOsArch(transport)).toEqual({
      os: 'darwin',
      arch: 'arm64',
      rawOs: 'Darwin',
      rawArch: 'arm64',
    });
  });

  it('surfaces an unrecognized os/arch as "unknown" rather than throwing', async () => {
    const transport = await fakeConnected(() => ({
      stdout: 'SunOS sun4u\n',
      stderr: '',
      exitCode: 0,
    }));
    expect(await detectRemoteOsArch(transport)).toEqual({
      os: 'unknown',
      arch: 'unknown',
      rawOs: 'SunOS',
      rawArch: 'sun4u',
    });
  });
});

describe('planRuntimeBootstrap', () => {
  it('reports os/arch and action "noop" when node is already on PATH', async () => {
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('node')) return { stdout: 'present', stderr: '', exitCode: 0 };
      return { stdout: 'missing', stderr: '', exitCode: 0 };
    });

    const plan = await planRuntimeBootstrap(transport);
    expect(plan.osArch).toEqual({ os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' });
    expect(plan.nodePresent).toBe(true);
    expect(plan.action).toBe('noop');
    expect(plan.commands).toEqual([]);
  });

  it('plans a mise+node install, shown but not run, when node is missing on a supported host', async () => {
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux aarch64', stderr: '', exitCode: 0 };
      return { stdout: 'missing', stderr: '', exitCode: 0 };
    });

    const plan = await planRuntimeBootstrap(transport, { nodeVersion: '22' });
    expect(plan.nodePresent).toBe(false);
    expect(plan.misePresent).toBe(false);
    expect(plan.supported).toBe(true);
    expect(plan.action).toBe('install_mise_and_node');
    expect(plan.commands.length).toBeGreaterThan(0);
    expect(plan.commands.join('\n')).toContain('mise.run');
    expect(plan.commands.join('\n')).toContain('node@22');
    // Planning must never itself run anything on the remote beyond detection.
    expect(transport.calls).toEqual([
      'uname -s -m',
      expect.stringContaining('node'),
      expect.stringContaining('mise'),
    ]);
  });

  it('marks an unrecognized os/arch unsupported and never plans commands for it', async () => {
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'SunOS sun4u', stderr: '', exitCode: 0 };
      return { stdout: 'missing', stderr: '', exitCode: 0 };
    });

    const plan = await planRuntimeBootstrap(transport);
    expect(plan.supported).toBe(false);
    expect(plan.action).toBe('unsupported');
    expect(plan.commands).toEqual([]);
    expect(plan.message).toMatch(/manual/i);
  });
});

describe('executeRuntimeBootstrap', () => {
  it('runs each planned command in order and reports success', async () => {
    const ran: string[] = [];
    const transport = await fakeConnected((command) => {
      ran.push(command);
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = {
      osArch: { os: 'linux' as const, arch: 'x64' as const, rawOs: 'Linux', rawArch: 'x86_64' },
      nodePresent: false,
      misePresent: false,
      supported: true,
      action: 'install_mise_and_node' as const,
      commands: ['echo step-one', 'echo step-two'],
      message: 'installing',
    };

    const result = await executeRuntimeBootstrap(transport, plan);
    expect(result).toEqual({
      ok: true,
      ranCommands: [
        { command: 'echo step-one', exitCode: 0, stderr: '' },
        { command: 'echo step-two', exitCode: 0, stderr: '' },
      ],
    });
    expect(ran).toEqual(['echo step-one', 'echo step-two']);
  });

  it('stops at the first failing command and reports where it failed', async () => {
    const transport = await fakeConnected((command) => {
      if (command === 'will-fail') return { stdout: '', stderr: 'boom', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = {
      osArch: { os: 'linux' as const, arch: 'x64' as const, rawOs: 'Linux', rawArch: 'x86_64' },
      nodePresent: false,
      misePresent: false,
      supported: true,
      action: 'install_mise_and_node' as const,
      commands: ['will-fail', 'never-runs'],
      message: 'installing',
    };

    const result = await executeRuntimeBootstrap(transport, plan);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('will-fail');
    expect(result.ranCommands).toEqual([{ command: 'will-fail', exitCode: 1, stderr: 'boom' }]);
  });

  it('is a no-op for a "noop" plan and never touches the transport', async () => {
    const transport = await fakeConnected(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const plan = {
      osArch: { os: 'linux' as const, arch: 'x64' as const, rawOs: 'Linux', rawArch: 'x86_64' },
      nodePresent: true,
      misePresent: true,
      supported: true,
      action: 'noop' as const,
      commands: [],
      message: 'already present',
    };
    const result = await executeRuntimeBootstrap(transport, plan);
    expect(result).toEqual({ ok: true, ranCommands: [] });
    expect(transport.calls).toEqual([]);
  });

  it('refuses to run an "unsupported" plan rather than attempting anything', async () => {
    const transport = await fakeConnected(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const plan = {
      osArch: {
        os: 'unknown' as const,
        arch: 'unknown' as const,
        rawOs: 'SunOS',
        rawArch: 'sun4u',
      },
      nodePresent: false,
      misePresent: false,
      supported: false,
      action: 'unsupported' as const,
      commands: [],
      message: 'needs manual install',
    };
    const result = await executeRuntimeBootstrap(transport, plan);
    expect(result).toEqual({ ok: false, ranCommands: [] });
    expect(transport.calls).toEqual([]);
  });
});
