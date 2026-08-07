import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTarGzArchive } from '../install-layout';
import { NODE_BUNDLE_ENTRY_FILE } from '../node-release';
import {
  DEFAULT_LAUNCHD_LABEL,
  type LaunchctlResult,
  type LaunchdIo,
} from './launchd-provisioning';
import { createLaunchdSupervisorBackend } from './launchd-supervisor-backend';

/** Builds a tiny fixture tar.gz whose bundle entry file (`node.mjs`) contains `content` — proves staging/activation move real bytes, matching `install-layout.test.ts`'s own fixture helper. */
async function fixtureArchive(content: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(join(tmpdir(), 'loombox-launchd-backend-fixture-'));
  try {
    await writeFile(join(sourceDir, NODE_BUNDLE_ENTRY_FILE), content);
    return await createTarGzArchive(sourceDir);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

/**
 * A fully in-memory `LaunchdIo` fake — no real `launchctl` process — with
 * scriptable per-subcommand `launchctl` results, so `start()`'s
 * kickstart-then-bootstrap fallback and `status()`'s `print`-output parsing
 * are both exercisable without a real Mac. Mirrors `launchd-provisioning
 * .test.ts`'s own `fakeIo()` shape.
 */
function fakeIo(
  overrides: Partial<LaunchdIo> & { launchctlResponses?: Record<string, LaunchctlResult> } = {},
): LaunchdIo & { files: Map<string, string>; launchctlCalls: string[][] } {
  const { launchctlResponses = {}, ...ioOverrides } = overrides;
  const files = new Map<string, string>();
  const launchctlCalls: string[][] = [];
  return {
    platform: 'darwin',
    homeDir: () => '/Users/lorenzo',
    uid: () => 501,
    readFile: (filePath) => files.get(filePath),
    writeFile: (filePath, content) => {
      files.set(filePath, content);
    },
    mkdir: () => {
      /* in-memory — no real directory to create */
    },
    removeFile: (filePath) => {
      files.delete(filePath);
    },
    launchctl: async (args) => {
      launchctlCalls.push(args);
      return launchctlResponses[args[0] ?? ''] ?? { stdout: '', stderr: '', exitCode: 0 };
    },
    files,
    launchctlCalls,
    ...ioOverrides,
  };
}

describe('createLaunchdSupervisorBackend (issue #654, real install-layout staging)', () => {
  let homeDir: string;
  let baseDir: string;
  let stateDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'loombox-launchd-backend-home-'));
    baseDir = join(homeDir, '.loombox');
    stateDir = join(homeDir, '.loombox', 'node');
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('stages, activates, and bootstraps a fresh install for real — the generated plist is asserted directly', async () => {
    const io = fakeIo();
    const backend = createLaunchdSupervisorBackend(io, {
      baseDir,
      stateDir,
      agentsDir: join(homeDir, 'Library', 'LaunchAgents'),
    });

    const result = await backend.install({
      version: '1.0.0',
      fetchArchive: async () => fixtureArchive('v1'),
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: { LOOMBOX_RELAY_URL: 'wss://relay.example', LOOMBOX_NODE_ID: 'mac-1' },
    });
    expect(result).toEqual({
      ok: true,
      action: 'install',
      message: expect.stringContaining('now running version 1.0.0'),
    });

    const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${DEFAULT_LAUNCHD_LABEL}.plist`);
    const plist = io.files.get(plistPath);
    expect(plist).toBeDefined();
    expect(plist).toContain(`<string>/opt/homebrew/bin/node</string>`);
    expect(plist).toContain(`<string>${join(baseDir, 'current', NODE_BUNDLE_ENTRY_FILE)}</string>`);
    expect(plist).toContain('<key>LOOMBOX_RELAY_URL</key>');
    expect(plist).toContain('<string>wss://relay.example</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');

    expect(io.launchctlCalls).toEqual([
      ['bootstrap', 'gui/501', plistPath],
      ['enable', 'gui/501/dev.loombox.node'],
    ]);

    const marker = await readFile(
      join(baseDir, 'versions', '1.0.0', NODE_BUNDLE_ENTRY_FILE),
      'utf8',
    );
    expect(marker).toBe('v1');
    const currentTarget = await readlink(join(baseDir, 'current'));
    expect(path.basename(currentTarget)).toBe('1.0.0');
  });

  it('reports noop and never re-fetches the archive on an identical re-install', async () => {
    const io = fakeIo();
    const backend = createLaunchdSupervisorBackend(io, {
      baseDir,
      stateDir,
      agentsDir: join(homeDir, 'Library', 'LaunchAgents'),
    });
    const install = {
      version: '1.0.0',
      fetchArchive: async () => fixtureArchive('v1'),
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: { LOOMBOX_RELAY_URL: 'wss://relay.example' },
    };
    await backend.install(install);

    io.launchctlCalls.length = 0;
    const reinstall = await backend.install({
      ...install,
      fetchArchive: async () => {
        throw new Error('fetchArchive should not be called on a real noop');
      },
    });
    expect(reinstall).toEqual({ ok: true, action: 'noop', message: expect.any(String) });
    expect(io.launchctlCalls).toEqual([]);
  });

  it('kickstarts a restart when only the version bumps (plist content unchanged)', async () => {
    const io = fakeIo();
    const backend = createLaunchdSupervisorBackend(io, {
      baseDir,
      stateDir,
      agentsDir: join(homeDir, 'Library', 'LaunchAgents'),
    });
    const env = { LOOMBOX_RELAY_URL: 'wss://relay.example' };
    await backend.install({
      version: '1.0.0',
      fetchArchive: async () => fixtureArchive('v1'),
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: env,
    });

    io.launchctlCalls.length = 0;
    const upgrade = await backend.install({
      version: '2.0.0',
      fetchArchive: async () => fixtureArchive('v2'),
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: env,
    });
    expect(upgrade).toEqual({ ok: true, action: 'update', message: expect.any(String) });
    expect(io.launchctlCalls).toEqual([['kickstart', '-k', 'gui/501/dev.loombox.node']]);

    const currentTarget = await readlink(join(baseDir, 'current'));
    expect(path.basename(currentTarget)).toBe('2.0.0');
  });

  it('updates via bootout+bootstrap+enable when only the environment changes, same version', async () => {
    const io = fakeIo();
    const backend = createLaunchdSupervisorBackend(io, {
      baseDir,
      stateDir,
      agentsDir: join(homeDir, 'Library', 'LaunchAgents'),
    });
    await backend.install({
      version: '1.0.0',
      fetchArchive: async () => fixtureArchive('v1'),
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: { LOOMBOX_RELAY_URL: 'wss://relay.example' },
    });

    io.launchctlCalls.length = 0;
    const update = await backend.install({
      version: '1.0.0',
      fetchArchive: async () => {
        throw new Error('fetchArchive should not be called: the version did not change');
      },
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: { LOOMBOX_RELAY_URL: 'wss://relay.example', LOOMBOX_DEVICE_TOKEN: 'tok-2' },
    });
    expect(update).toEqual({ ok: true, action: 'update', message: expect.any(String) });
    expect(io.launchctlCalls.map((call) => call[0])).toEqual(['bootout', 'bootstrap', 'enable']);
  });

  it('install() reports unsupported (ok: true) off-darwin and never touches disk', async () => {
    const io = fakeIo({ platform: 'linux' });
    const backend = createLaunchdSupervisorBackend(io, {
      baseDir,
      stateDir,
      agentsDir: join(homeDir, 'Library', 'LaunchAgents'),
    });

    const result = await backend.install({
      version: '1.0.0',
      fetchArchive: async () => {
        throw new Error('fetchArchive should never be called when unsupported');
      },
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: {},
    });
    expect(result).toEqual({ ok: true, action: 'unsupported', message: expect.any(String) });
    expect(io.launchctlCalls).toEqual([]);
    await expect(readlink(join(baseDir, 'current'))).rejects.toThrow();
  });

  it('uninstall removes the plist, the installed code, and (by default) the state dir', async () => {
    const io = fakeIo();
    const backend = createLaunchdSupervisorBackend(io, {
      baseDir,
      stateDir,
      agentsDir: join(homeDir, 'Library', 'LaunchAgents'),
    });
    await backend.install({
      version: '1.0.0',
      fetchArchive: async () => fixtureArchive('v1'),
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: {},
    });

    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'identity.json'), '{}');

    const result = await backend.uninstall();
    expect(result.ok).toBe(true);

    const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${DEFAULT_LAUNCHD_LABEL}.plist`);
    expect(io.files.has(plistPath)).toBe(false);
    await expect(readlink(join(baseDir, 'current'))).rejects.toThrow();
    await expect(readFile(join(stateDir, 'identity.json'))).rejects.toThrow();
  });

  it('uninstall keeps the state dir when keepData is set', async () => {
    const io = fakeIo();
    const backend = createLaunchdSupervisorBackend(io, {
      baseDir,
      stateDir,
      agentsDir: join(homeDir, 'Library', 'LaunchAgents'),
    });
    await backend.install({
      version: '1.0.0',
      fetchArchive: async () => fixtureArchive('v1'),
      nodeExecutable: '/opt/homebrew/bin/node',
      environment: {},
    });

    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'identity.json'), '{}');

    await backend.uninstall({ keepData: true });

    const preserved = await readFile(join(stateDir, 'identity.json'), 'utf8');
    expect(preserved).toBe('{}');
    await expect(readlink(join(baseDir, 'current'))).rejects.toThrow();
  });
});

describe('createLaunchdSupervisorBackend (issue #654, decision logic against an in-memory LaunchdIo)', () => {
  const AGENTS_DIR = '/Users/lorenzo/Library/LaunchAgents';
  const PLIST_PATH = `${AGENTS_DIR}/${DEFAULT_LAUNCHD_LABEL}.plist`;
  const SERVICE_TARGET = `gui/501/${DEFAULT_LAUNCHD_LABEL}`;

  it('start()/stop()/status()/survivesReboot() report "not installed" when no plist exists', async () => {
    const io = fakeIo();
    const backend = createLaunchdSupervisorBackend(io, { agentsDir: AGENTS_DIR });

    expect(await backend.start()).toEqual({
      ok: false,
      message: expect.stringContaining('not installed'),
    });
    expect(await backend.stop()).toEqual({
      ok: true,
      message: expect.stringContaining('not installed'),
    });
    expect(await backend.status()).toEqual({
      installed: false,
      state: 'stopped',
      message: expect.stringContaining('not installed'),
    });
    expect(await backend.survivesReboot()).toBe(false);
  });

  it('status() parses launchctl print output into the run-state vocabulary', async () => {
    const io = fakeIo({
      launchctlResponses: {
        print: { stdout: 'service = {\n\tstate = running\n};\n', stderr: '', exitCode: 0 },
      },
    });
    io.files.set(PLIST_PATH, 'plist-content');
    const backend = createLaunchdSupervisorBackend(io, { agentsDir: AGENTS_DIR });

    const status = await backend.status();
    expect(status.installed).toBe(true);
    expect(status.state).toBe('running');
  });

  it('status() reports stopped when launchctl print exits non-zero (not currently loaded)', async () => {
    const io = fakeIo({
      launchctlResponses: {
        print: { stdout: '', stderr: 'Could not find service', exitCode: 1 },
      },
    });
    io.files.set(PLIST_PATH, 'plist-content');
    const backend = createLaunchdSupervisorBackend(io, { agentsDir: AGENTS_DIR });

    const status = await backend.status();
    expect(status.installed).toBe(true);
    expect(status.state).toBe('stopped');
  });

  it('survivesReboot() is true only when the plist has RunAtLoad true AND the service is loaded', async () => {
    const io = fakeIo({ launchctlResponses: { print: { stdout: '', stderr: '', exitCode: 0 } } });
    io.files.set(
      PLIST_PATH,
      '  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n',
    );
    const backend = createLaunchdSupervisorBackend(io, { agentsDir: AGENTS_DIR });

    expect(await backend.survivesReboot()).toBe(true);
  });

  it('survivesReboot() is false when RunAtLoad is false, even if loaded', async () => {
    const io = fakeIo({ launchctlResponses: { print: { stdout: '', stderr: '', exitCode: 0 } } });
    io.files.set(PLIST_PATH, '  <key>RunAtLoad</key>\n  <false/>\n');
    const backend = createLaunchdSupervisorBackend(io, { agentsDir: AGENTS_DIR });

    expect(await backend.survivesReboot()).toBe(false);
  });

  it('start() falls back to bootstrap+enable when kickstart fails (job not currently loaded)', async () => {
    const io = fakeIo({
      launchctlResponses: {
        kickstart: { stdout: '', stderr: 'Could not find service', exitCode: 1 },
      },
    });
    io.files.set(PLIST_PATH, 'plist-content');
    const backend = createLaunchdSupervisorBackend(io, { agentsDir: AGENTS_DIR });

    const result = await backend.start();
    expect(result).toEqual({ ok: true, message: expect.stringContaining('started') });
    expect(io.launchctlCalls).toEqual([
      ['kickstart', '-k', SERVICE_TARGET],
      ['bootstrap', 'gui/501', PLIST_PATH],
      ['enable', SERVICE_TARGET],
    ]);
  });
});
