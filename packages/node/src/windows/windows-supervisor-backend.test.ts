import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTarGzArchive,
  createWindowsInstallLayoutDriver,
  type InstallLayoutDriver,
} from '../install-layout';
import { defaultWindowsTaskName } from '../node-environment';
import { NODE_BUNDLE_ENTRY_FILE } from '../node-release';
import type { SchtasksResult, WindowsTaskIo } from './windows-provisioning';
import { createWindowsSupervisorBackend } from './windows-supervisor-backend';

/** Builds a tiny fixture tar.gz whose bundle entry file (`node.mjs`) contains `content` — same fixture shape `install-layout.test.ts`/`launchd-supervisor-backend.test.ts` already use. */
async function fixtureArchive(content: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'loombox-windows-backend-fixture-'));
  try {
    await writeFile(path.join(sourceDir, NODE_BUNDLE_ENTRY_FILE), content);
    return await createTarGzArchive(sourceDir);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

/** A fully in-memory `WindowsTaskIo` fake — no real `schtasks` process — with scriptable per-subcommand responses. Mirrors `windows-provisioning.test.ts`'s own `fakeIo()` shape. */
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
    schtasks: async (args) => {
      schtasksCalls.push(args);
      return schtasksResponses[args[0] ?? ''] ?? { stdout: '', stderr: '', exitCode: 0 };
    },
    files,
    schtasksCalls,
    ...ioOverrides,
  };
}

/** A fully in-memory `InstallLayoutDriver` fake — no real disk, no `tar` — so decision-logic tests stay entirely within one consistent (genuinely win32-shaped) path universe instead of mixing real POSIX disk paths with generated Windows-shaped content. Mirrors the real driver's own refusal to remove the active version. */
function fakeInstallLayoutDriver(): InstallLayoutDriver & {
  fetchedVersions: string[];
  activatedVersions: string[];
} {
  const staged = new Set<string>();
  let current: string | undefined;
  const fetchedVersions: string[] = [];
  const activatedVersions: string[] = [];
  return {
    async listStagedVersions() {
      return [...staged];
    },
    async stageVersion(_baseDir, version) {
      staged.add(version);
      fetchedVersions.push(version);
    },
    async activateVersion(_baseDir, version) {
      if (!staged.has(version)) {
        throw new Error(`install-layout: version ${version} is not staged`);
      }
      current = version;
      activatedVersions.push(version);
    },
    async currentVersion() {
      return current;
    },
    async removeVersion(_baseDir, version) {
      if (version === current) {
        throw new Error(
          `install-layout: refusing to remove version ${version} — it's what "current" points at`,
        );
      }
      staged.delete(version);
    },
    fetchedVersions,
    activatedVersions,
  };
}

const BASE_INSTALL_CONFIG = {
  version: '1.0.0',
  fetchArchive: async () => fixtureArchive('v1'),
  nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
  environment: { LOOMBOX_RELAY_URL: 'wss://relay.example', LOOMBOX_NODE_ID: 'win-1' },
};

describe('createWindowsSupervisorBackend (issue #659) — decision logic, fully in-memory', () => {
  it('a fresh install stages+activates the version, registers via /Create, and starts via /Run', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });

    const result = await backend.install(BASE_INSTALL_CONFIG);
    expect(result).toEqual({
      ok: true,
      action: 'install',
      message: expect.stringContaining('now running version 1.0.0'),
    });
    expect(driver.fetchedVersions).toEqual(['1.0.0']);
    expect(driver.activatedVersions).toEqual(['1.0.0']);

    const taskXmlPath = 'C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\task.xml';
    const xml = io.files.get(taskXmlPath);
    expect(xml).toBeDefined();
    expect(xml).toContain('<Command>C:\\Windows\\System32\\cmd.exe</Command>');
    expect(xml).toContain('<UserId>DEVBOX\\lorenzo</UserId>');

    const launcher = io.files.get('C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\run.cmd');
    expect(launcher).toContain('set "LOOMBOX_RELAY_URL=wss://relay.example"');
    expect(launcher).toContain(
      '"C:\\Program Files\\nodejs\\node.exe" ' +
        '"C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\current\\node.mjs"',
    );

    expect(io.schtasksCalls).toEqual([
      ['/Create', '/XML', taskXmlPath, '/TN', defaultWindowsTaskName('production'), '/F'],
      ['/Run', '/TN', defaultWindowsTaskName('production')],
    ]);
  });

  it('reports noop and never re-fetches the archive on an identical re-install', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });
    await backend.install(BASE_INSTALL_CONFIG);

    io.schtasksCalls.length = 0;
    const reinstall = await backend.install({
      ...BASE_INSTALL_CONFIG,
      fetchArchive: async () => {
        throw new Error('fetchArchive should not be called on a real noop');
      },
    });
    expect(reinstall).toEqual({ ok: true, action: 'noop', message: expect.any(String) });
    expect(io.schtasksCalls).toEqual([]);
  });

  it('a version-only bump (task content unchanged) restarts via /End then /Run, never /Create', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });
    await backend.install(BASE_INSTALL_CONFIG);

    io.schtasksCalls.length = 0;
    const result = await backend.install({ ...BASE_INSTALL_CONFIG, version: '2.0.0' });
    expect(result).toEqual({
      ok: true,
      action: 'update',
      message: expect.stringContaining('now running version 2.0.0'),
    });
    expect(driver.activatedVersions).toEqual(['1.0.0', '2.0.0']);
    expect(io.schtasksCalls).toEqual([
      ['/End', '/TN', defaultWindowsTaskName('production')],
      ['/Run', '/TN', defaultWindowsTaskName('production')],
    ]);
  });

  it('an env-var change (task content changes, same version) re-registers via /End, /Create, /Run', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });
    await backend.install(BASE_INSTALL_CONFIG);

    io.schtasksCalls.length = 0;
    const result = await backend.install({
      ...BASE_INSTALL_CONFIG,
      environment: { ...BASE_INSTALL_CONFIG.environment, LOOMBOX_NODE_ID: 'win-2' },
    });
    expect(result.action).toBe('update');
    const taskXmlPath = 'C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\task.xml';
    expect(io.schtasksCalls).toEqual([
      ['/End', '/TN', defaultWindowsTaskName('production')],
      ['/Create', '/XML', taskXmlPath, '/TN', defaultWindowsTaskName('production'), '/F'],
      ['/Run', '/TN', defaultWindowsTaskName('production')],
    ]);
  });

  it('install() reports unsupported (ok: true) off-Windows and never stages or registers anything', async () => {
    const io = fakeIo({ platform: 'linux' });
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });

    const result = await backend.install({
      ...BASE_INSTALL_CONFIG,
      fetchArchive: async () => {
        throw new Error('fetchArchive should not be called when unsupported');
      },
    });
    expect(result).toEqual({ ok: true, action: 'unsupported', message: expect.any(String) });
    expect(io.schtasksCalls).toEqual([]);
    expect(driver.activatedVersions).toEqual([]);
  });

  it('start() refuses when not installed, and succeeds via /Run once it is', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });

    expect(await backend.start()).toEqual({
      ok: false,
      message: expect.stringContaining('is not installed'),
    });

    await backend.install(BASE_INSTALL_CONFIG);
    const result = await backend.start();
    expect(result).toEqual({ ok: true, message: expect.stringContaining('started') });
  });

  it('stop() is a no-op success when not installed, and best-effort /End otherwise', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });

    expect(await backend.stop()).toEqual({
      ok: true,
      message: expect.stringContaining('not installed'),
    });

    await backend.install(BASE_INSTALL_CONFIG);
    const result = await backend.stop();
    expect(result.ok).toBe(true);
  });

  it('status() reports not-installed, then running/stopped from schtasks /FO LIST output', async () => {
    const io = fakeIo({
      schtasksResponses: {
        '/Query': {
          stdout: 'HostName:  DEVBOX\r\nTaskName: \\loombox\\node\r\nStatus:    Running\r\n',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });

    expect(await backend.status()).toEqual({
      installed: false,
      state: 'stopped',
      message: expect.stringContaining('not installed'),
    });

    await backend.install(BASE_INSTALL_CONFIG);
    const running = await backend.status();
    expect(running).toEqual({
      installed: true,
      state: 'running',
      version: '1.0.0',
      message: expect.stringContaining('Running'),
    });
  });

  it('status() reports "unknown" rather than guessing, for an unrecognized/absent Status line', async () => {
    const io = fakeIo({
      schtasksResponses: {
        '/Query': { stdout: 'TaskName: \\loombox\\node\r\n', stderr: '', exitCode: 0 },
      },
    });
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });
    await backend.install(BASE_INSTALL_CONFIG);

    const status = await backend.status();
    expect(status.state).toBe('unknown');
  });

  it('status() reports "unknown" when schtasks /Query itself fails', async () => {
    const io = fakeIo({
      schtasksResponses: { '/Query': { stdout: '', stderr: 'ERROR: not found', exitCode: 1 } },
    });
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });
    await backend.install(BASE_INSTALL_CONFIG);

    const status = await backend.status();
    expect(status.state).toBe('unknown');
    expect(status.message).toMatch(/schtasks \/Query failed/);
  });

  it('survivesReboot() is true only when installed, has a LogonTrigger, and is not disabled', async () => {
    const io = fakeIo({
      schtasksResponses: {
        '/Query': { stdout: 'Scheduled Task State:   Enabled\r\n', stderr: '', exitCode: 0 },
      },
    });
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });

    expect(await backend.survivesReboot()).toBe(false); // not installed

    await backend.install(BASE_INSTALL_CONFIG);
    expect(await backend.survivesReboot()).toBe(true);
  });

  it('survivesReboot() is false when the registered task is disabled', async () => {
    const io = fakeIo({
      schtasksResponses: {
        '/Query': { stdout: 'Scheduled Task State:   Disabled\r\n', stderr: '', exitCode: 0 },
      },
    });
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });
    await backend.install(BASE_INSTALL_CONFIG);

    expect(await backend.survivesReboot()).toBe(false);
  });

  it('uninstall() ends and deletes the task, and removes the cached task.xml/run.cmd', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });
    await backend.install(BASE_INSTALL_CONFIG);

    const taskXmlPath = 'C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\task.xml';
    const launcherPath = 'C:\\Users\\lorenzo\\AppData\\Local\\.loombox\\run.cmd';
    expect(io.files.has(taskXmlPath)).toBe(true);

    io.schtasksCalls.length = 0;
    const result = await backend.uninstall();
    expect(result.ok).toBe(true);
    expect(io.schtasksCalls).toEqual([
      ['/End', '/TN', defaultWindowsTaskName('production')],
      ['/Delete', '/TN', defaultWindowsTaskName('production'), '/F'],
    ]);
    expect(io.files.has(taskXmlPath)).toBe(false);
    expect(io.files.has(launcherPath)).toBe(false);
  });

  it('uninstall is idempotent: uninstalling an already-uninstalled backend is still ok: true', async () => {
    const io = fakeIo();
    const driver = fakeInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, { installLayoutDriver: driver });

    const result = await backend.uninstall();
    expect(result.ok).toBe(true);
  });
});

describe('createWindowsSupervisorBackend (issue #867, environment defaults)', () => {
  it('defaults taskName from the given environment, collision-free with production, when no explicit override is given', async () => {
    const io = fakeIo();
    const productionBackend = createWindowsSupervisorBackend(io, {
      installLayoutDriver: fakeInstallLayoutDriver(),
    });
    const previewBackend = createWindowsSupervisorBackend(io, {
      environment: 'preview',
      installLayoutDriver: fakeInstallLayoutDriver(),
    });

    expect((await productionBackend.status()).message).toContain(
      defaultWindowsTaskName('production'),
    );
    expect((await previewBackend.status()).message).toContain(defaultWindowsTaskName('preview'));
    expect(defaultWindowsTaskName('preview')).not.toBe(defaultWindowsTaskName('production'));
  });
});

describe('createWindowsSupervisorBackend (issue #659) — wired to the real createWindowsInstallLayoutDriver, real disk', () => {
  // `baseDir` is a real, disk-usable POSIX tmp path standing in for what
  // would be a genuine `C:\...` path on real Windows — the same
  // constraint `install-layout.test.ts`'s own `createWindowsInstallLayout
  // Driver` suite documents. This proves the *wiring* (the default driver
  // genuinely stages/activates real bytes when this backend calls it) —
  // path-shape correctness itself is proven separately, in the
  // fully-in-memory suite above and in `windows-provisioning.test.ts`.
  //
  // State is asserted through the *driver's own* API
  // (`currentVersion`/`listStagedVersions`), not a manually re-joined
  // disk path: `windows-supervisor-backend.ts` builds `baseDir`-relative
  // paths with `win32.join` (deterministic on every host, matching real
  // Windows exactly), while the driver's own internal joins use the
  // ambient, platform-adaptive `node:path` (`path.win32` for real, but
  // `path.posix` on this test host, exactly like `install-layout.test.ts`
  // documents). Both are correct — and identical — on real Windows; only
  // a real POSIX tmp `baseDir` standing in for one in a test makes them
  // diverge as raw strings. Going through the driver's own accessor
  // sidesteps that divergence entirely rather than asserting on it.
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-windows-backend-real-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('stages and activates a real version via the default install-layout driver, and uninstall removes it', async () => {
    const io = fakeIo();
    const driver = createWindowsInstallLayoutDriver();
    const backend = createWindowsSupervisorBackend(io, {
      baseDir,
      stateDir: path.join(baseDir, 'node'),
      installLayoutDriver: driver,
    });

    const result = await backend.install(BASE_INSTALL_CONFIG);
    expect(result.ok).toBe(true);
    expect(result.action).toBe('install');
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');

    // The real bytes genuinely moved — read back through the driver's own
    // real `current` junction/symlink (real disk, real tar extraction),
    // not a hand-reconstructed path.
    const currentTarget = await readlink(path.join(baseDir, 'current'));
    const marker = await readFile(path.join(currentTarget, NODE_BUNDLE_ENTRY_FILE), 'utf8');
    expect(marker).toBe('v1');

    await backend.uninstall();
    expect(await driver.currentVersion(baseDir)).toBeUndefined();
    expect(await driver.listStagedVersions(baseDir)).toEqual([]);
  });
});
