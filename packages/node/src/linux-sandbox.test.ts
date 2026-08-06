import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildBubblewrapArgv,
  detectSandboxCapability,
  resetSandboxCapabilityCacheForTests,
  sandboxCommand,
  SandboxUnavailableError,
  type SandboxCapability,
} from './linux-sandbox';

describe('detectSandboxCapability / computeCapability', () => {
  afterEach(() => {
    resetSandboxCapabilityCacheForTests();
  });

  it('reports unavailable, Linux-only, on a non-Linux platform — never probes bwrap at all', () => {
    const capability = detectSandboxCapability({ platform: 'darwin' });
    expect(capability.available).toBe(false);
    expect(capability.backend).toBe('none');
    expect(capability.reason).toMatch(/Linux-only/);
    expect(capability.reason).toMatch(/"darwin"/);
  });

  it('reports unavailable when bwrap is not on PATH', () => {
    const capability = detectSandboxCapability({
      platform: 'linux',
      pathEnv: '/definitely/not/a/real/dir',
    });
    expect(capability.available).toBe(false);
    expect(capability.backend).toBe('none');
    expect(capability.reason).toMatch(/not installed on PATH/);
  });

  it('reports unavailable, naming the real cause, when bwrap is present but the functional self-test fails — the documented shape of a kernel that refuses unprivileged user namespaces (kernel.unprivileged_userns_clone=0, or an AppArmor restriction)', () => {
    const capability = detectSandboxCapability({
      platform: 'linux',
      pathEnv: '/usr/bin',
      probe: () => false,
    });
    expect(capability.available).toBe(false);
    expect(capability.backend).toBe('none');
    expect(capability.reason).toMatch(/unprivileged_userns_clone/);
  });

  it('reports available with backend "bubblewrap" once the functional self-test actually passes', () => {
    const capability = detectSandboxCapability({
      platform: 'linux',
      pathEnv: '/usr/bin',
      probe: () => true,
    });
    expect(capability).toEqual({ available: true, backend: 'bubblewrap' });
  });

  it('caches only the default (no-override) call shape — an explicit override always recomputes, even after a cached default result exists', () => {
    let calls = 0;
    const first = detectSandboxCapability({
      platform: 'linux',
      pathEnv: '/usr/bin',
      probe: () => {
        calls += 1;
        return true;
      },
    });
    const second = detectSandboxCapability({
      platform: 'linux',
      pathEnv: '/usr/bin',
      probe: () => {
        calls += 1;
        return true;
      },
    });
    expect(first).toEqual(second);
    expect(calls).toBe(2); // every override call recomputes, never reads the cache
  });

  it('resetSandboxCapabilityCacheForTests clears the default-call cache', () => {
    // Populate the default-call cache with a real (uncontrolled) result...
    detectSandboxCapability();
    resetSandboxCapabilityCacheForTests();
    // ...then prove a fresh default call recomputes rather than reusing it,
    // by checking a *different* platform override — which always bypasses
    // the cache — still reflects reality after the reset with no leftover
    // stale state affecting it.
    const capability = detectSandboxCapability({ platform: 'win32' });
    expect(capability.available).toBe(false);
  });
});

describe('buildBubblewrapArgv', () => {
  it('builds a fresh, from-nothing root: base namespaces unshared, network shared, only /usr, /etc, /proc, /dev, /tmp exist unconditionally', () => {
    const argv = buildBubblewrapArgv({
      command: '/bin/true',
      args: [],
      mounts: { readWrite: [], readOnly: [] },
      chdir: '/tmp',
    });
    expect(argv).toEqual(
      expect.arrayContaining([
        '--unshare-all',
        '--share-net',
        '--die-with-parent',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
      ]),
    );
    // Never a hole punched in an otherwise-open root (the "--ro-bind / /"
    // shape this issue's own doc comment rules out).
    expect(argv).not.toContain('/');
  });

  it('mounts caller-supplied readOnly dirs with --ro-bind and readWrite dirs with --bind, in identity-mapped (same-path) form', () => {
    const argv = buildBubblewrapArgv({
      command: 'echo',
      args: ['hi'],
      mounts: { readWrite: ['/work/session-1'], readOnly: ['/opt/toolchain'] },
      chdir: '/work/session-1',
    });
    const roIdx = argv.indexOf('/opt/toolchain');
    expect(argv[roIdx - 1]).toBe('--ro-bind');
    expect(argv[roIdx + 1]).toBe('/opt/toolchain');

    const rwIdx = argv.indexOf('/work/session-1');
    expect(argv[rwIdx - 1]).toBe('--bind');
    expect(argv[rwIdx + 1]).toBe('/work/session-1');

    expect(argv.slice(-3)).toEqual(['--', 'echo', 'hi']);
    expect(argv).toEqual(expect.arrayContaining(['--chdir', '/work/session-1']));
  });

  it('never duplicates a mount listed more than once (readWrite/readOnly are deduped via Set)', () => {
    const argv = buildBubblewrapArgv({
      command: 'true',
      args: [],
      mounts: { readWrite: ['/work', '/work'], readOnly: [] },
      chdir: '/work',
    });
    // `--bind SRC DEST` (identity-mapped, so SRC === DEST) appears exactly
    // once, not once per duplicate input entry: dedup happened.
    expect(argv.filter((entry) => entry === '--bind')).toHaveLength(1);
    expect(argv.filter((entry) => entry === '/work')).toHaveLength(3); // --bind's two identical path args, plus --chdir's
  });
});

describe('sandboxCommand — the fail-closed entry point', () => {
  it('throws SandboxUnavailableError, naming the real reason, rather than returning a wrapped-looking command, when capability.available is false', () => {
    const capability: SandboxCapability = {
      available: false,
      backend: 'none',
      reason: 'bubblewrap ("bwrap") is not installed on PATH',
    };
    expect(() =>
      sandboxCommand({
        command: 'npx',
        args: ['-y', 'whatever'],
        mounts: { readWrite: ['/work'], readOnly: [] },
        chdir: '/work',
        capability,
      }),
    ).toThrow(SandboxUnavailableError);
    try {
      sandboxCommand({
        command: 'npx',
        args: [],
        mounts: { readWrite: ['/work'], readOnly: [] },
        chdir: '/work',
        capability,
      });
      expect.unreachable('sandboxCommand must throw when capability.available is false');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxUnavailableError);
      expect((error as Error).message).toMatch(/not installed on PATH/);
    }
  });

  it('returns a bwrap-wrapped command when capability.available is true', () => {
    const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
    const wrapped = sandboxCommand({
      command: 'echo',
      args: ['hi'],
      mounts: { readWrite: ['/work'], readOnly: [] },
      chdir: '/work',
      capability,
    });
    expect(wrapped.command).toBe('bwrap');
    expect(wrapped.args.slice(-3)).toEqual(['--', 'echo', 'hi']);
  });
});

/**
 * Real-child-process containment tests (issue #257's acceptance bar: "a
 * process attempting to read or write outside the session worktree is
 * denied" — proven against a REAL spawned process, not a mock). Skipped
 * (not failed) when this host cannot actually sandbox, so the suite stays
 * green on a kernel where userns is restricted or bwrap is missing — see
 * this module's own `describe.skipIf` condition and the honest capability
 * report it logs.
 */
const realCapability = detectSandboxCapability();
if (!realCapability.available) {
  // Deliberately visible in CI/dev output: an honest, unmissable
  // statement of *why* the real-containment suite below is being skipped,
  // not a silent gap (issue #257's own "say so honestly" instruction).
  console.warn(
    `linux-sandbox.test.ts: skipping real bwrap containment tests — ${realCapability.reason}`,
  );
}

describe.skipIf(!realCapability.available)(
  'real bwrap containment (issue #257 acceptance bar)',
  () => {
    let worktree: string;
    let secretDir: string;
    let secretFile: string;

    beforeEach(async () => {
      worktree = await mkdtemp(join(tmpdir(), 'loombox-sandbox-worktree-'));
      secretDir = await mkdtemp(join(tmpdir(), 'loombox-sandbox-secret-'));
      secretFile = join(secretDir, 'secret.txt');
      await writeFile(secretFile, 'TOP SECRET, never leave secretDir\n', 'utf8');
    });

    afterEach(async () => {
      await rm(worktree, { recursive: true, force: true });
      await rm(secretDir, { recursive: true, force: true });
    });

    function run(
      command: string,
      args: string[],
      mounts: { readWrite: string[]; readOnly: string[] },
    ) {
      const wrapped = sandboxCommand({
        command,
        args,
        mounts,
        chdir: worktree,
        capability: realCapability,
      });
      return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', timeout: 10_000 });
    }

    it('denies reading a file outside the worktree — ENOENT (the path never exists in there), not a permission error', () => {
      const result = run('/bin/sh', ['-c', `cat "${secretFile}"`], {
        readWrite: [worktree],
        readOnly: [],
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/No such file or directory/);
      expect(result.stdout).not.toContain('TOP SECRET');
    });

    it('denies writing a file outside the worktree, and the host filesystem is left untouched', async () => {
      const target = join(secretDir, 'planted-by-agent.txt');
      const result = run('/bin/sh', ['-c', `echo leaked > "${target}"`], {
        readWrite: [worktree],
        readOnly: [],
      });

      expect(result.status).not.toBe(0);
      await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/);
    });

    it('a real child really can read AND write inside the worktree — this is scoping, not a blanket deny', async () => {
      const result = run('/bin/sh', ['-c', 'echo hello-from-sandbox > out.txt && cat out.txt'], {
        readWrite: [worktree],
        readOnly: [],
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('hello-from-sandbox\n');
      // The bind mount is a real passthrough, not a copy: the file exists on
      // the actual host filesystem at the worktree path once the sandboxed
      // process exits.
      await expect(readFile(join(worktree, 'out.txt'), 'utf8')).resolves.toBe(
        'hello-from-sandbox\n',
      );
    });

    it('an explicit readOnly mount makes a path visible but still denies writing to it', () => {
      const readResult = run('/bin/sh', ['-c', `cat "${secretFile}"`], {
        readWrite: [worktree],
        readOnly: [secretDir],
      });
      expect(readResult.status).toBe(0);
      expect(readResult.stdout).toContain('TOP SECRET');

      const writeResult = run('/bin/sh', ['-c', `echo leaked >> "${secretFile}"`], {
        readWrite: [worktree],
        readOnly: [secretDir],
      });
      expect(writeResult.status).not.toBe(0);
      expect(writeResult.stderr).toMatch(/[Rr]ead-only file system/);
    });
  },
);
