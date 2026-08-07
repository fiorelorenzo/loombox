import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import { generateAmk } from '@loombox/crypto';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';

import { createNode, type NodeDaemon } from './node-daemon';
import { detectSandboxCapability, resetSandboxCapabilityCacheForTests } from './linux-sandbox';
import { resetNpmCacheDirCacheForTests } from './npm-cache';

const execFileAsync = promisify(execFile);

/**
 * End-to-end proof that `NodeDaemonOptions.sessionSandbox` actually wires a
 * `local` session's real agent spawn through `bwrap` (issue #257) — not
 * just that `resolveSessionSandbox`/`AgentSupervisor.start()` accept the
 * option in isolation (see `session-sandbox.test.ts`/`agent-supervisor.
 * test.ts` for those). Reuses `packages/providers/core`'s own hermetic ACP
 * fixture agent as the "real agent process" — copied into the session's
 * worktree at `spawnConfig()` time (synchronously, before the real
 * sandboxed spawn happens) rather than referenced by its normal on-disk
 * path in this repo's checkout, because that checkout path is NOT under
 * `/usr`, the session worktree, or the auto-discovered toolchain root — a
 * real fixture-of-a-fixture problem, not a shortcut: an actual `claude`/
 * `codex`/`omp` provider only ever needs its OWN toolchain root and the
 * worktree (see `session-sandbox.ts`'s `resolveToolchainMounts` doc
 * comment), never an arbitrary third-party script path.
 */
const ECHO_FIXTURE_SOURCE = await readFile(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'providers',
    'core',
    'test',
    'fixtures',
    'echo-acp-agent.mjs',
  ),
  'utf8',
);

function sandboxedEchoProvider(): AcpProvider {
  return {
    id: 'test-sandboxed-echo',
    spawnConfig: ({ cwd }) => {
      const fixturePath = path.join(cwd, '_echo-fixture.mjs');
      // Synchronous by design: AgentSupervisor.start() calls spawnConfig()
      // immediately before spawning, with no await point in between — the
      // file must exist on disk (inside what is about to become the
      // sandboxed root's one writable directory) before that happens.
      writeFileSync(fixturePath, ECHO_FIXTURE_SOURCE);
      return { command: process.execPath, args: [fixturePath], cwd };
    },
    enrich: (update) => update,
  };
}

/**
 * A provider whose fixture script probes a caller-supplied "npm cache"
 * directory BEFORE running the normal ACP handshake (issue #831): if the
 * marker this same script writes on its first run isn't there yet, it
 * writes it (standing in for "npx downloaded the package"); if it IS
 * there, it writes a second, distinct witness file into ITS OWN session
 * worktree (standing in for "npx found it in cache — reused, not
 * re-downloaded"). Two sessions sharing the same real, host-visible
 * `npmCacheDir` prove `NodeDaemon` really threads `resolveNpmCacheDir()`
 * into `resolveSessionSandbox()`'s `extraReadWriteMounts` for a genuine
 * local session — not just that the lower-level primitives support it in
 * isolation (see `session-sandbox.test.ts`'s own npm-cache describe block
 * for that, including the real elapsed-time reuse measurement).
 */
function npmCacheProbeProvider(npmCacheDir: string): AcpProvider {
  return {
    id: 'test-npm-cache-probe',
    spawnConfig: ({ cwd }) => {
      const fixturePath = path.join(cwd, '_npm-cache-probe-fixture.mjs');
      const markerPath = path.join(npmCacheDir, 'downloaded-marker');
      const witnessPath = path.join(cwd, 'reused-cache-witness.txt');
      const probe =
        `import { existsSync, writeFileSync } from 'node:fs';\n` +
        `const marker = ${JSON.stringify(markerPath)};\n` +
        `if (existsSync(marker)) { writeFileSync(${JSON.stringify(witnessPath)}, 'reused'); } ` +
        `else { writeFileSync(marker, 'downloaded'); }\n`;
      writeFileSync(fixturePath, `${ECHO_FIXTURE_SOURCE}\n${probe}`);
      return { command: process.execPath, args: [fixturePath], cwd };
    },
    enrich: (update) => update,
  };
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;

const realCapability = detectSandboxCapability();
if (!realCapability.available) {
  // Honest, unmissable statement of why the positive end-to-end suite
  // below is skipped (issue #257's own "say so honestly" instruction),
  // not a silent gap.
  console.warn(
    `node-daemon-sandbox.test.ts: skipping the real-bwrap-through-NodeDaemon suite — ${realCapability.reason}`,
  );
}

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-sandbox-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-sandbox-state-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@loombox.dev'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'loombox test'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: projectPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'loombox test',
      GIT_AUTHOR_EMAIL: 'test@loombox.dev',
      GIT_COMMITTER_NAME: 'loombox test',
      GIT_COMMITTER_EMAIL: 'test@loombox.dev',
    },
  });
});

afterEach(async () => {
  node?.close();
  node = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
  resetNpmCacheDirCacheForTests();
});

describe.skipIf(!realCapability.available)(
  'NodeDaemon + sessionSandbox: enabled — real bwrap end-to-end (issue #257)',
  () => {
    it('a local session really spawns confined to its worktree: the ACP handshake completes through a genuine bwrap-wrapped child process', async () => {
      const amk = generateAmk();
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-sandbox-1',
        deviceId: 'device-sandbox-1',
        devicePublicKey: 'unused-in-this-test',
        authToken: 'acct-sandbox',
        accountId: 'acct-sandbox',
        amk,
        supervisor: new AgentSupervisor({ providers: [sandboxedEchoProvider()] }),
        sessionSandbox: { enabled: true, npmCacheEnabled: false },
      });

      const session = await node.createSession({ projectPath, provider: 'test-sandboxed-echo' });

      expect(session.id).toBeTruthy();
    });
  },
);

describe.skipIf(!realCapability.available)(
  'NodeDaemon + sessionSandbox: enabled — npm/npx cache mount really wired through a real local session (issue #831)',
  () => {
    afterEach(() => {
      resetNpmCacheDirCacheForTests();
    });

    it('a second local session on the same node sees what the first session wrote into the shared cache mount — proof the daemon actually threads resolveNpmCacheDir() into the sandbox, not just that the primitive supports it in isolation', async () => {
      const npmCacheDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-npm-cache-'));
      const originalCacheEnv = process.env.NPM_CONFIG_CACHE;
      // Deterministic and hermetic: this test's own tmp dir, never this
      // dev box's real `~/.npm` (`resolveNpmCacheDir()` honors
      // `NPM_CONFIG_CACHE` first, before ever probing `npm`/falling back
      // to `$HOME/.npm` — see that module's own doc comment).
      process.env.NPM_CONFIG_CACHE = npmCacheDir;
      resetNpmCacheDirCacheForTests();
      try {
        const amk = generateAmk();
        node = createNode({
          relayUrl: relay.url,
          stateDir: nodeStateDir,
          nodeId: 'node-sandbox-npm-cache',
          deviceId: 'device-sandbox-npm-cache',
          devicePublicKey: 'unused-in-this-test',
          authToken: 'acct-sandbox-npm-cache',
          accountId: 'acct-sandbox-npm-cache',
          amk,
          supervisor: new AgentSupervisor({ providers: [npmCacheProbeProvider(npmCacheDir)] }),
          sessionSandbox: { enabled: true, npmCacheEnabled: true },
        });

        const sessionA = await node.createSession({
          projectPath,
          provider: 'test-npm-cache-probe',
        });
        expect(existsSync(path.join(npmCacheDir, 'downloaded-marker'))).toBe(true);

        const sessionB = await node.createSession({
          projectPath,
          provider: 'test-npm-cache-probe',
        });
        expect(sessionB.worktreePath).not.toBe(sessionA.worktreePath);
        const witness = await readFile(
          path.join(sessionB.worktreePath, 'reused-cache-witness.txt'),
          'utf8',
        );
        expect(witness).toBe('reused');
      } finally {
        if (originalCacheEnv === undefined) delete process.env.NPM_CONFIG_CACHE;
        else process.env.NPM_CONFIG_CACHE = originalCacheEnv;
        await rm(npmCacheDir, { recursive: true, force: true });
      }
    });
  },
);

describe('NodeDaemon + sessionSandbox: enabled — fail-closed (issue #257 non-negotiable constraint)', () => {
  afterEach(() => {
    resetSandboxCapabilityCacheForTests();
  });

  it('sandbox unavailable (no bwrap reachable on PATH) means createSession() itself REJECTS — the agent process is never spawned unsandboxed', async () => {
    // A real, not mocked, "sandbox unavailable" host: PATH with no `bwrap`
    // reachable on it. `resolveSessionSandbox`'s own default call path
    // reads `process.env.PATH` at call time — restored via the `finally`
    // below, and the module-level capability cache reset both before and
    // after so this never leaks into another test file's default-cache
    // reads. `git` (real `git`, symlinked in) stays resolvable on this
    // narrowed PATH — worktree creation, which runs before sandbox
    // resolution, needs it — while `bwrap` (which lives right next to it,
    // both under `/usr/bin` on this box) deliberately does not.
    resetSandboxCapabilityCacheForTests();
    const gitOnlyBinDir = await mkdtemp(path.join(tmpdir(), 'loombox-sandbox-git-only-bin-'));
    const { stdout: realGitPath } = await execFileAsync('which', ['git']);
    await symlink(realGitPath.trim(), path.join(gitOnlyBinDir, 'git'));
    const originalPath = process.env.PATH;
    process.env.PATH = gitOnlyBinDir;
    try {
      const amk = generateAmk();
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-sandbox-2',
        deviceId: 'device-sandbox-2',
        devicePublicKey: 'unused-in-this-test',
        authToken: 'acct-sandbox-2',
        accountId: 'acct-sandbox-2',
        amk,
        supervisor: new AgentSupervisor({ providers: [sandboxedEchoProvider()] }),
        sessionSandbox: { enabled: true, npmCacheEnabled: false },
      });

      await expect(
        node.createSession({ projectPath, provider: 'test-sandboxed-echo' }),
      ).rejects.toThrow(/sandbox unavailable/);
    } finally {
      process.env.PATH = originalPath;
      await rm(gitOnlyBinDir, { recursive: true, force: true });
    }
  });

  it('sessionSandbox left at its default (disabled) never consults the sandbox at all — an ordinary local session starts exactly as before this issue', async () => {
    const amk = generateAmk();
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-sandbox-3',
      deviceId: 'device-sandbox-3',
      devicePublicKey: 'unused-in-this-test',
      authToken: 'acct-sandbox-3',
      accountId: 'acct-sandbox-3',
      amk,
      supervisor: new AgentSupervisor({ providers: [sandboxedEchoProvider()] }),
      // sessionSandbox intentionally omitted — defaults to disabled.
    });

    const session = await node.createSession({ projectPath, provider: 'test-sandboxed-echo' });
    expect(session.id).toBeTruthy();
  });
});
