import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import {
  probeProviderAvailability,
  type ProviderAvailabilityCandidate,
} from './provider-availability';
import { SshExecutionTarget } from './ssh-execution-target';
import { FakeTransport } from './ssh/fake-transport';
import type { ExecutionTarget } from './target';

const NOT_IMPLEMENTED = () => Promise.reject(new Error('fakeExecutionTarget: not implemented'));

/** A minimal {@link ExecutionTarget} exercising only `exec`/`kind` — everything this probe actually touches. */
function fakeExecutionTarget(
  kind: 'local' | 'ssh',
  exec: ExecutionTarget['exec'],
): ExecutionTarget {
  return {
    kind,
    exec,
    readFile: NOT_IMPLEMENTED,
    writeFile: NOT_IMPLEMENTED,
    mkdir: NOT_IMPLEMENTED,
    readdir: NOT_IMPLEMENTED,
    readdirDetailed: NOT_IMPLEMENTED,
  };
}

const CANDIDATES: ProviderAvailabilityCandidate[] = [
  { id: 'claude', requiredCommand: 'claude' },
  { id: 'codex', requiredCommand: 'codex' },
  { id: 'ohmypi', requiredCommand: 'omp' },
];

describe('probeProviderAvailability', () => {
  it('issues exactly one exec call no matter how many candidates are probed', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
    await probeProviderAvailability(fakeExecutionTarget('local', exec), CANDIDATES);

    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args] = exec.mock.calls[0] as [string, string[]];
    expect(command).toBe('sh');
    expect(args[0]).toBe('-c');
    // The single script folds every candidate's own `command -v` check in.
    expect(args[1]).toContain('claude');
    expect(args[1]).toContain('codex');
    expect(args[1]).toContain('omp');
  });

  it('returns [] without calling exec at all when there are no candidates', async () => {
    const exec = vi.fn();
    const result = await probeProviderAvailability(fakeExecutionTarget('local', exec), []);

    expect(result).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('parses only the ids the stubbed exec actually printed, ignoring stray blank lines', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: '\nclaude\n\nohmypi\n', stderr: '', exitCode: 1 });
    const result = await probeProviderAvailability(fakeExecutionTarget('local', exec), CANDIDATES);

    expect(result).toEqual(['claude', 'ohmypi']);
  });

  it('never throws: a target whose exec rejects for any reason degrades to an empty providers list, and logs it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exec = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));

    await expect(
      probeProviderAvailability(fakeExecutionTarget('local', exec), CANDIDATES, 'broken-target'),
    ).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('broken-target'));
    warnSpy.mockRestore();
  });
});

describe('probeProviderAvailability against a real local shell (hermetic PATH)', () => {
  let binDir: string;
  let localTarget: LocalExecutionTarget;
  let hermeticTarget: ExecutionTarget;

  beforeEach(async () => {
    // Deterministic regardless of what's actually installed on the machine
    // running the suite: PATH is replaced (not extended) with a fresh temp
    // directory this test alone controls. `sh` itself must still resolve
    // for `LocalExecutionTarget` to spawn anything at all, so it's the one
    // thing symlinked in from the real filesystem — every candidate binary
    // is a stub this test writes itself.
    binDir = await mkdtemp(join(tmpdir(), 'loombox-provider-probe-bin-'));
    await symlink('/bin/sh', join(binDir, 'sh'));
    localTarget = new LocalExecutionTarget();
    hermeticTarget = {
      kind: 'local',
      exec: (command, args, options = {}) =>
        localTarget.exec(command, args, { ...options, env: { ...options.env, PATH: binDir } }),
      readFile: (p) => localTarget.readFile(p),
      writeFile: (p, content) => localTarget.writeFile(p, content),
      mkdir: (p) => localTarget.mkdir(p),
      readdir: (p) => localTarget.readdir(p),
      readdirDetailed: (p) => localTarget.readdirDetailed(p),
    };
  });

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  async function stubExecutable(name: string): Promise<void> {
    const file = join(binDir, name);
    await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(file, 0o755);
  }

  it('announces exactly the providers whose command resolves in the (stubbed) PATH — nothing more, nothing less', async () => {
    await stubExecutable('claude');
    await stubExecutable('omp');
    // Deliberately no "codex" stub: proves the negative case in the same
    // real-shell run, not just the positive one.

    const result = await probeProviderAvailability(hermeticTarget, CANDIDATES, 'local');

    expect(result.slice().sort()).toEqual(['claude', 'ohmypi']);
  });

  it('announces [] when none of the candidates resolve', async () => {
    const result = await probeProviderAvailability(hermeticTarget, CANDIDATES, 'local');
    expect(result).toEqual([]);
  });
});

describe("probeProviderAvailability against an ssh: target's pooled transport", () => {
  it("an ssh: target's providers come from its own remote exec, not the local PATH (the whole point of per-target probing)", async () => {
    // Local reality (hermetic, same technique as above): only "claude" resolves.
    const binDir = await mkdtemp(join(tmpdir(), 'loombox-provider-probe-local-'));
    try {
      await symlink('/bin/sh', join(binDir, 'sh'));
      const claudeStub = join(binDir, 'claude');
      await writeFile(claudeStub, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(claudeStub, 0o755);
      const localTarget = new LocalExecutionTarget();
      const hermeticLocal: ExecutionTarget = {
        kind: 'local',
        exec: (command, args, options = {}) =>
          localTarget.exec(command, args, { ...options, env: { ...options.env, PATH: binDir } }),
        readFile: NOT_IMPLEMENTED,
        writeFile: NOT_IMPLEMENTED,
        mkdir: NOT_IMPLEMENTED,
        readdir: NOT_IMPLEMENTED,
        readdirDetailed: NOT_IMPLEMENTED,
      };
      const localResult = await probeProviderAvailability(hermeticLocal, CANDIDATES, 'local');
      expect(localResult).toEqual(['claude']);

      // Remote reality: the opposite — the fake transport (standing in for
      // the already-pooled RemoteTransport a real ssh: target reuses)
      // reports only "codex" as resolvable, never consulted for "local"'s
      // answer above.
      const transport = new FakeTransport({
        onExec: (command) => {
          // Sanity: the probe really did reach the transport with a script
          // naming every candidate's requiredCommand, not a hardcoded guess.
          expect(command).toContain('claude');
          expect(command).toContain('codex');
          expect(command).toContain('omp');
          return { stdout: 'codex\n', stderr: '', exitCode: 0 };
        },
      });
      await transport.connect();
      const sshTarget = new SshExecutionTarget(transport);

      const remoteResult = await probeProviderAvailability(sshTarget, CANDIDATES, 'devbox');

      expect(remoteResult).toEqual(['codex']);
      expect(remoteResult).not.toEqual(localResult);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('never throws: an unreachable ssh: target degrades to an empty providers list, and logs it (SPEC: "reachable but nothing to run" only applies to a genuinely-empty result, not a failure — but the wire shape is the same)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Never connected -> FakeTransport.exec() itself throws, simulating an
    // unreachable host/dead transport.
    const transport = new FakeTransport();
    const sshTarget = new SshExecutionTarget(transport);

    await expect(
      probeProviderAvailability(sshTarget, CANDIDATES, 'unreachable-devbox'),
    ).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unreachable-devbox'));
    warnSpy.mockRestore();
  });
});
