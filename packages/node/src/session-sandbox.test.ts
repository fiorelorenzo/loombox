import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SandboxUnavailableError, type SandboxCapability } from './linux-sandbox';
import { resolveSessionSandbox } from './session-sandbox';

describe('resolveSessionSandbox', () => {
  describe('platform split', () => {
    it('a non-Linux host is not required to sandbox — returns required: false, no wrapSpawnConfig, and never even looks at capability', () => {
      const resolution = resolveSessionSandbox({
        workspacePath: '/whatever',
        platform: 'darwin',
        // If this were ever consulted on a non-Linux platform, this
        // capability would make it throw — proving it genuinely isn't.
        capability: { available: false, backend: 'none', reason: 'should never be read' },
      });
      expect(resolution.required).toBe(false);
      expect(resolution.wrapSpawnConfig).toBeUndefined();
      expect(resolution.capability.available).toBe(false);
      expect(resolution.capability.reason).toMatch(/Linux-only/);
    });

    it('a Linux host IS required to sandbox — an available capability yields a real wrapSpawnConfig hook', () => {
      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const resolution = resolveSessionSandbox({
        workspacePath: '/work/session-1',
        platform: 'linux',
        capability,
        pathEnv: '/usr/bin',
      });
      expect(resolution.required).toBe(true);
      expect(resolution.capability).toEqual(capability);
      expect(resolution.wrapSpawnConfig).toBeTypeOf('function');
    });
  });

  describe('fail-closed (issue #257 non-negotiable constraint)', () => {
    it('throws SandboxUnavailableError — never returns a resolution — when Linux capability is unavailable', () => {
      const capability: SandboxCapability = {
        available: false,
        backend: 'none',
        reason: 'bubblewrap is installed but could not create an unprivileged user+mount namespace',
      };
      expect(() =>
        resolveSessionSandbox({ workspacePath: '/work/session-1', platform: 'linux', capability }),
      ).toThrow(SandboxUnavailableError);
    });

    it('the thrown error carries the real, operator-facing reason forward unchanged — this is what the client ultimately sees via sendSessionStatus', () => {
      const capability: SandboxCapability = {
        available: false,
        backend: 'none',
        reason: 'bubblewrap ("bwrap") is not installed on PATH',
      };
      try {
        resolveSessionSandbox({ workspacePath: '/work/session-1', platform: 'linux', capability });
        expect.unreachable('must throw when capability is unavailable on Linux');
      } catch (error) {
        expect(error).toBeInstanceOf(SandboxUnavailableError);
        expect((error as Error).message).toContain('bubblewrap ("bwrap") is not installed on PATH');
      }
    });
  });

  describe('wrapSpawnConfig — the built hook', () => {
    it('rewrites command/args into a bwrap invocation and marks the result sandboxed', () => {
      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const { wrapSpawnConfig } = resolveSessionSandbox({
        workspacePath: '/work/session-1',
        platform: 'linux',
        capability,
        pathEnv: '/usr/bin',
      });

      const wrapped = wrapSpawnConfig!({
        command: 'npx',
        args: ['-y', 'thing'],
        cwd: '/work/session-1',
      });
      expect(wrapped.command).toBe('bwrap');
      expect(wrapped.args.slice(-4)).toEqual(['--', 'npx', '-y', 'thing']);
      expect(wrapped.args).toEqual(expect.arrayContaining(['--bind', '/work/session-1']));
      expect(wrapped.args).toEqual(expect.arrayContaining(['--chdir', '/work/session-1']));
      // `env`/`cwd` pass through untouched — only command/args are rewritten.
      expect(wrapped.cwd).toBe('/work/session-1');
    });

    it('the hook is pure/deterministic — calling it twice with the same input produces the same bwrap argv, never a stateful surprise', () => {
      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const { wrapSpawnConfig } = resolveSessionSandbox({
        workspacePath: '/work',
        platform: 'linux',
        capability,
        pathEnv: '/usr/bin',
      });
      const config = { command: 'omp', args: ['acp'] };
      expect(wrapSpawnConfig!(config)).toEqual(wrapSpawnConfig!(config));
    });

    it('folds extraReadOnlyMounts/extraReadWriteMounts into the bwrap argv alongside the workspace', () => {
      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const { wrapSpawnConfig } = resolveSessionSandbox({
        workspacePath: '/work/session-1',
        platform: 'linux',
        capability,
        pathEnv: '/usr/bin',
        extraReadOnlyMounts: ['/opt/mcp-server'],
        extraReadWriteMounts: ['/home/dev/.npm'],
      });

      const wrapped = wrapSpawnConfig!({ command: 'echo', args: [] });
      expect(wrapped.args).toEqual(expect.arrayContaining(['--ro-bind', '/opt/mcp-server']));
      expect(wrapped.args).toEqual(expect.arrayContaining(['--bind', '/home/dev/.npm']));
    });
  });

  describe('toolchain root auto-discovery (a version-manager-installed CLI must still exec inside the sandbox)', () => {
    let toolRoot: string;
    let pathDir: string;

    beforeEach(async () => {
      // Mimics this exact repo's own dev box: a node install at
      // <root>/bin/<exe>, resolved via PATH, entirely outside /usr.
      toolRoot = await mkdtemp(join(tmpdir(), 'loombox-toolchain-'));
      await mkdir(join(toolRoot, 'bin'), { recursive: true });
      await writeFile(join(toolRoot, 'bin', 'fake-npx'), '#!/bin/sh\necho fake-npx\n', {
        mode: 0o755,
      });
      pathDir = join(toolRoot, 'bin');
    });

    afterEach(async () => {
      await rm(toolRoot, { recursive: true, force: true });
    });

    it('mounts the toolchain ROOT (parent of bin/), not just the bin/ directory, for a <root>/bin/<exe>-shaped install', () => {
      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const { wrapSpawnConfig } = resolveSessionSandbox({
        workspacePath: '/work/session-1',
        platform: 'linux',
        capability,
        pathEnv: pathDir,
      });

      const wrapped = wrapSpawnConfig!({ command: 'fake-npx', args: [] });
      expect(wrapped.args).toEqual(expect.arrayContaining(['--ro-bind', toolRoot]));
      expect(wrapped.args).not.toEqual(expect.arrayContaining([pathDir]));
    });

    it('follows a version-manager shim symlink to the real install before deciding the mount root, and mounts BOTH the shim location and the real one', async () => {
      const realRoot = await mkdtemp(join(tmpdir(), 'loombox-toolchain-real-'));
      await mkdir(join(realRoot, 'bin'), { recursive: true });
      await writeFile(join(realRoot, 'bin', 'fake-omp'), '#!/bin/sh\necho real\n', { mode: 0o755 });
      const shimDir = await mkdtemp(join(tmpdir(), 'loombox-toolchain-shim-'));
      await symlink(join(realRoot, 'bin', 'fake-omp'), join(shimDir, 'fake-omp'));

      try {
        const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
        const { wrapSpawnConfig } = resolveSessionSandbox({
          workspacePath: '/work/session-1',
          platform: 'linux',
          capability,
          pathEnv: shimDir,
        });
        const wrapped = wrapSpawnConfig!({ command: 'fake-omp', args: [] });
        expect(wrapped.args).toEqual(expect.arrayContaining(['--ro-bind', realRoot]));
        // The shim's OWN location must also be mounted — real omp on this
        // project's own dev box is exactly this shape (a mise "latest"
        // symlink pointing at a separate versioned install directory),
        // and bwrap's execvpe re-does the PATH search fresh inside the
        // sandbox: if the shim's own directory isn't visible, execvpe
        // never even gets far enough to follow the symlink to realRoot.
        expect(wrapped.args).toEqual(expect.arrayContaining(['--ro-bind', shimDir]));
      } finally {
        await rm(realRoot, { recursive: true, force: true });
        await rm(shimDir, { recursive: true, force: true });
      }
    });

    it("a RELATIVE symlink inside the same toolchain root (npm's own bin/npx -> ../lib/node_modules/npm/bin/npx-cli.js shape) needs only ONE mount, and a real bwrap child can actually execute through it", async () => {
      // Reproduces, with fakes, the exact real bug found testing this
      // against this project's own real `npx`: an EARLIER version of this
      // resolver mounted only the symlink's resolved TARGET directory,
      // leaving the toolchain root's `bin/` itself (where PATH search —
      // and so bwrap's own execvpe — actually looks first) absent from
      // the sandbox: `bwrap: execvp npx: No such file or directory`, even
      // though the eventual target was perfectly visible.
      await mkdir(join(toolRoot, 'lib', 'pkg', 'bin'), { recursive: true });
      await writeFile(
        join(toolRoot, 'lib', 'pkg', 'bin', 'real-tool'),
        '#!/bin/sh\necho it-really-ran\n',
        { mode: 0o755 },
      );
      await symlink(
        join('..', 'lib', 'pkg', 'bin', 'real-tool'),
        join(toolRoot, 'bin', 'shimmed-tool'),
      );

      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const { wrapSpawnConfig } = resolveSessionSandbox({
        workspacePath: toolRoot,
        platform: 'linux',
        capability,
        pathEnv: pathDir,
      });
      const wrapped = wrapSpawnConfig!({ command: 'shimmed-tool', args: [] });

      const roBindTargets = wrapped.args.filter((_, i) => wrapped.args[i - 1] === '--ro-bind');
      expect(roBindTargets.filter((p) => p !== '/usr' && p !== '/etc')).toEqual([toolRoot]);

      // `pathEnv` above only steers THIS resolver's own mount planning;
      // the actual sandboxed exec below re-does its own real PATH search
      // using whatever env the caller spawns it with — in production
      // that's the SAME `process.env.PATH` by default (see
      // `resolveSessionSandbox`'s own `pathEnv` fallback), so this test
      // matches that by spawning with an env whose PATH agrees with what
      // `pathEnv` told the resolver to plan around.
      const result = spawnSync(wrapped.command, wrapped.args, {
        encoding: 'utf8',
        timeout: 10_000,
        // Prepended (not a full override) so `bwrap` itself — resolved
        // from the REAL, unrestricted PATH — is still found by this
        // outer spawnSync call.
        env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}` },
      });
      expect(result.stdout).toBe('it-really-ran\n');
      expect(result.status).toBe(0);
    });

    it('never elevates a mount root to the filesystem root itself — a command resolving through /bin or /sbin stays covered by the unconditional /usr mount, never a bare "/"', () => {
      // Regression for a real near-miss found in the same investigation:
      // `toolchainRootFor` walking `/bin/sh` up through its `bin/`
      // parent computed `/` itself as the "toolchain root" — which would
      // have `--ro-bind`ed the ENTIRE host filesystem read-only, defeating
      // containment outright. Caught before merge by testing against a
      // real spawned child (`session-sandbox.test.ts`'s own real
      // end-to-end containment test below started failing the moment this
      // bug was introduced), not by inspection.
      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const { wrapSpawnConfig } = resolveSessionSandbox({
        workspacePath: '/work/session-1',
        platform: 'linux',
        capability,
        pathEnv: '/bin',
      });
      const wrapped = wrapSpawnConfig!({ command: 'sh', args: [] });
      expect(wrapped.args).not.toContain('/');
      const roBindTargets = wrapped.args.filter((_, i) => wrapped.args[i - 1] === '--ro-bind');
      expect(roBindTargets).toEqual(['/usr', '/etc']);
    });

    it('does not add a redundant mount for a command already resolving under /usr (git, sh, ...)', () => {
      const capability: SandboxCapability = { available: true, backend: 'bubblewrap' };
      const { wrapSpawnConfig } = resolveSessionSandbox({
        workspacePath: '/work/session-1',
        platform: 'linux',
        capability,
        pathEnv: '/usr/bin',
      });
      const wrapped = wrapSpawnConfig!({ command: 'true', args: [] });
      // Only the base /usr bind (added unconditionally by
      // buildBubblewrapArgv) appears — no second, redundant --ro-bind for
      // a path already under /usr.
      const roBindTargets = wrapped.args.filter((_, i) => wrapped.args[i - 1] === '--ro-bind');
      expect(roBindTargets.filter((p) => p === '/usr')).toHaveLength(1);
      expect(roBindTargets.some((p) => p !== '/usr' && p !== '/etc')).toBe(false);
    });
  });
});

/**
 * One real, end-to-end proof tying `resolveSessionSandbox` to an actual
 * spawned process (complementing `linux-sandbox.test.ts`'s lower-level
 * containment suite, which already proves `sandboxCommand`/
 * `buildBubblewrapArgv` themselves): the exact `wrapSpawnConfig` hook
 * `launchLocalSession` builds and hands to `AgentSupervisor.start()`
 * really does confine a real child on THIS host, when this host can
 * sandbox at all.
 */
describe('resolveSessionSandbox — real end-to-end containment', () => {
  it.skipIf(
    !(() => {
      // Mirrors detectSandboxCapability's own real self-test cheaply: if
      // bwrap can't even run --version, there's no point attempting this.
      const probe = spawnSync('bwrap', ['--version']);
      return probe.status === 0;
    })(),
  )(
    'a real agent-shaped process, wrapped via the hook node-daemon actually wires up, cannot read outside the session worktree',
    async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'loombox-session-sandbox-e2e-'));
      const secretDir = await mkdtemp(join(tmpdir(), 'loombox-session-sandbox-e2e-secret-'));
      try {
        await writeFile(join(secretDir, 'secret.txt'), 'do not leak\n', 'utf8');

        const { required, wrapSpawnConfig, capability } = resolveSessionSandbox({
          workspacePath: worktree,
        });
        // Honest, not asserted: only proceed with the real-spawn assertion if
        // this host actually reports itself sandboxable (see this file's own
        // `it.skipIf` above for the bwrap-presence half of that check).
        if (!required || !capability.available) return;

        const wrapped = wrapSpawnConfig!({
          command: '/bin/sh',
          args: ['-c', `cat "${join(secretDir, 'secret.txt')}"`],
        });
        const result = spawnSync(wrapped.command, wrapped.args, {
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain('do not leak');
      } finally {
        await rm(worktree, { recursive: true, force: true });
        await rm(secretDir, { recursive: true, force: true });
      }
    },
  );
});
