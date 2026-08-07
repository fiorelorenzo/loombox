import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTarGzArchive } from '../install-layout';
import { NODE_BUNDLE_ENTRY_FILE } from '../node-release';
import { FakeTransport } from '../ssh/fake-transport';
import { LocalProcessTransport } from '../ssh/local-process-transport';
import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from '../ssh/remote-transport';
import { DEFAULT_UNIT_NAME, generateSystemdUnit } from '../ssh/systemd-provisioning';
import type { SupervisorBackend } from '../supervisor-backend';
import { createSystemdLocalSupervisorBackend } from './systemd-local-supervisor-backend';

const execFileAsync = promisify(execFile);

/** Builds a tiny fixture tar.gz whose one file (`node.mjs`) contains `content` — same helper shape `../ssh/systemd-supervisor-backend.test.ts` uses. */
async function fixtureArchive(content: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(join(tmpdir(), 'loombox-systemd-local-backend-fixture-'));
  try {
    await writeFile(join(sourceDir, NODE_BUNDLE_ENTRY_FILE), content);
    return await createTarGzArchive(sourceDir);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

/**
 * Wraps a real `LocalProcessTransport` (so staging/activation/unit-file
 * writes genuinely touch disk) but intercepts every command that would
 * mutate this devbox's *real* systemd user session — same convention
 * `../ssh/systemd-supervisor-backend.test.ts`'s own
 * `RealFileFakeSystemctlTransport` uses.
 */
class RealFileFakeSystemctlTransport implements RemoteTransport {
  readonly interceptedCommands: string[] = [];
  private readonly inner = new LocalProcessTransport();

  constructor(private readonly queryResponses: Record<string, string> = {}) {}

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  async exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
    const isSystemdCommand =
      command.startsWith('systemctl --user') ||
      command.startsWith('loginctl enable-linger') ||
      command.startsWith('loginctl show-user');
    if (isSystemdCommand) {
      this.interceptedCommands.push(command);
      for (const [prefix, stdout] of Object.entries(this.queryResponses)) {
        if (command.startsWith(prefix)) return { stdout, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return this.inner.exec(command, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe('createSystemdLocalSupervisorBackend (issue #658, real file I/O)', () => {
  let homeDir: string;
  let baseDir: string;
  let unitDir: string;
  let stateDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'loombox-systemd-local-backend-home-'));
    baseDir = join(homeDir, '.loombox');
    unitDir = join(homeDir, '.config', 'systemd', 'user');
    stateDir = join(homeDir, '.loombox', 'node');
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function makeBackend(transport: RemoteTransport, enableLinger: boolean): SupervisorBackend {
    return createSystemdLocalSupervisorBackend({ baseDir, unitDir, stateDir, enableLinger }, transport);
  }

  it('stages, activates, and starts a fresh install for real, then reports noop on an identical re-install', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport, true);
      const install = await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: { LOOMBOX_RELAY_URL: 'wss://relay.example' },
      });
      expect(install.ok).toBe(true);
      expect(install.action).toBe('install');
      expect(install.message).toContain('now running version 1.0.0');
      expect(install.message).toContain('Linger is enabled');
      expect(transport.interceptedCommands).toEqual([
        'systemctl --user daemon-reload',
        `systemctl --user enable --now '${DEFAULT_UNIT_NAME}'`,
        'loginctl enable-linger "$(id -un)"',
      ]);

      const marker = await readFile(
        join(baseDir, 'versions', '1.0.0', NODE_BUNDLE_ENTRY_FILE),
        'utf8',
      );
      expect(marker).toBe('v1');
      const currentTarget = await readlink(join(baseDir, 'current'));
      expect(path.basename(currentTarget)).toBe('1.0.0');

      // The generated unit is exactly `generateSystemdUnit`'s own output —
      // this backend never reimplements unit rendering (issue #658's
      // "shares its source with the ssh path" acceptance).
      const unitContent = await readFile(join(unitDir, DEFAULT_UNIT_NAME), 'utf8');
      expect(unitContent).toBe(
        generateSystemdUnit({
          execStart: '/usr/bin/node',
          execArgs: [join(baseDir, 'current', NODE_BUNDLE_ENTRY_FILE)],
          environment: { LOOMBOX_RELAY_URL: 'wss://relay.example' },
          description: 'loombox resident node',
        }),
      );

      transport.interceptedCommands.length = 0;
      const reinstall = await backend.install({
        version: '1.0.0',
        fetchArchive: async () => {
          throw new Error('fetchArchive should not be called on a real noop');
        },
        nodeExecutable: '/usr/bin/node',
        environment: { LOOMBOX_RELAY_URL: 'wss://relay.example' },
      });
      expect(reinstall).toEqual({ ok: true, action: 'noop', message: expect.any(String) });
      expect(transport.interceptedCommands).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it('never runs loginctl enable-linger when declined, still installs and starts everything else, and says so honestly', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport, false);
      const install = await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: {},
      });
      expect(install.ok).toBe(true);
      expect(install.action).toBe('install');
      expect(install.message).toContain('will NOT survive a reboot');
      // Everything else still ran for real — only the linger step is missing.
      expect(transport.interceptedCommands).toEqual([
        'systemctl --user daemon-reload',
        `systemctl --user enable --now '${DEFAULT_UNIT_NAME}'`,
      ]);
      expect(transport.interceptedCommands.some((c) => c.startsWith('loginctl enable-linger'))).toBe(
        false,
      );
      const unitContent = await readFile(join(unitDir, DEFAULT_UNIT_NAME), 'utf8');
      expect(unitContent).toContain('ExecStart=/usr/bin/node');
    } finally {
      await transport.close();
    }
  });

  it('restarts explicitly when only the version bumps (unit content unchanged)', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport, true);
      const env = { LOOMBOX_RELAY_URL: 'wss://relay.example' };
      await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: env,
      });

      transport.interceptedCommands.length = 0;
      const upgrade = await backend.install({
        version: '2.0.0',
        fetchArchive: async () => fixtureArchive('v2'),
        nodeExecutable: '/usr/bin/node',
        environment: env,
      });
      expect(upgrade).toEqual({ ok: true, action: 'update', message: expect.any(String) });
      expect(transport.interceptedCommands).toEqual([
        `systemctl --user restart '${DEFAULT_UNIT_NAME}'`,
      ]);

      const currentTarget = await readlink(join(baseDir, 'current'));
      expect(path.basename(currentTarget)).toBe('2.0.0');
    } finally {
      await transport.close();
    }
  });

  it('uninstall removes the unit, the installed code, and (by default) the state dir', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport, true);
      await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: {},
      });
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'identity.json'), '{}');

      const result = await backend.uninstall();
      expect(result.ok).toBe(true);

      await expect(readFile(join(unitDir, DEFAULT_UNIT_NAME))).rejects.toThrow();
      await expect(readlink(join(baseDir, 'current'))).rejects.toThrow();
      await expect(readFile(join(stateDir, 'identity.json'))).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });

  it('uninstall keeps the state dir when keepData is set, and never touches linger', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport, true);
      await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: {},
      });
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'identity.json'), '{}');

      transport.interceptedCommands.length = 0;
      await backend.uninstall({ keepData: true });

      const preserved = await readFile(join(stateDir, 'identity.json'), 'utf8');
      expect(preserved).toBe('{}');
      await expect(readlink(join(baseDir, 'current'))).rejects.toThrow();
      expect(transport.interceptedCommands.some((c) => c.includes('linger'))).toBe(false);
    } finally {
      await transport.close();
    }
  });
});

describe('createSystemdLocalSupervisorBackend (issue #658, decision logic against FakeTransport)', () => {
  it('install() reports unsupported (ok: true) and never fetches the archive when systemctl is absent', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.startsWith('command -v systemctl')) {
          return { stdout: 'missing\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();
    const backend = createSystemdLocalSupervisorBackend(
      { baseDir: '/home/loombox/.loombox', unitDir: '/home/loombox/.config/systemd/user', enableLinger: true },
      transport,
    );

    const result = await backend.install({
      version: '1.0.0',
      fetchArchive: async () => {
        throw new Error('fetchArchive should never be called when unsupported');
      },
      nodeExecutable: '/usr/bin/node',
      environment: {},
    });
    expect(result).toEqual({ ok: true, action: 'unsupported', message: expect.any(String) });
  });

  it('start()/stop()/status()/survivesReboot() report "not installed" when no unit file exists', async () => {
    const transport = new FakeTransport({
      onExec: () => ({ stdout: '', stderr: '', exitCode: 1 }),
    });
    await transport.connect();
    const backend = createSystemdLocalSupervisorBackend(
      { baseDir: '/home/loombox/.loombox', unitDir: '/home/loombox/.config/systemd/user', enableLinger: false },
      transport,
    );

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

  it('survivesReboot() is true only when the unit is enabled AND linger is on, regardless of what install() was told', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        if (command.startsWith('test -f')) return { stdout: 'yes\n', stderr: '', exitCode: 0 };
        if (command.startsWith('systemctl --user is-enabled')) {
          return { stdout: 'enabled\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('loginctl show-user')) {
          return { stdout: 'Linger=yes\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();
    // Even a backend constructed with `enableLinger: false` reports the
    // real, live state — survivesReboot() never trusts what install() was
    // told, only what systemctl/loginctl say right now.
    const backend = createSystemdLocalSupervisorBackend(
      { baseDir: '/home/loombox/.loombox', unitDir: '/home/loombox/.config/systemd/user', enableLinger: false },
      transport,
    );

    expect(await backend.survivesReboot()).toBe(true);
  });

  it('survivesReboot() is false when the unit is enabled but linger is off', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        if (command.startsWith('test -f')) return { stdout: 'yes\n', stderr: '', exitCode: 0 };
        if (command.startsWith('systemctl --user is-enabled')) {
          return { stdout: 'enabled\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('loginctl show-user')) {
          return { stdout: 'Linger=no\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();
    const backend = createSystemdLocalSupervisorBackend(
      { baseDir: '/home/loombox/.loombox', unitDir: '/home/loombox/.config/systemd/user', enableLinger: true },
      transport,
    );

    expect(await backend.survivesReboot()).toBe(false);
  });
});

/** Whether a real, reachable `systemd --user` session exists on this machine — checked once, synchronously, so the suite below can `describe.skipIf` out entirely on a box/container with no user D-Bus/systemd session (e.g. most CI runners) instead of failing. */
function systemdUserSessionAvailable(): boolean {
  const result = spawnSync('systemctl', ['--user', 'show-environment'], { timeout: 5000 });
  return result.error === undefined && result.status === 0;
}

// This describe block deliberately runs against the REAL `systemctl --user`
// on whatever machine runs it (issue #658's own acceptance: "installing
// produces a real unit, and `systemctl --user restart` brings the node back
// with identity and pairing intact — verify with a scratch unit and scratch
// state dir on this box"). Every identifier below is scratch: a unit name
// unique to this process's pid (never `loombox-node.service`, this
// machine's real resident node) and a throwaway `~/.loombox`-shaped tree
// under `os.tmpdir()`. `unitDir` is NOT scratch — it's this real user's
// real `~/.config/systemd/user`, because a live `systemd --user` manager's
// unit search path is fixed at its own startup and does not follow a
// client-side override; only the *unit name* inside it is scratch, and
// `afterEach` disables/removes exactly that one name.
describe.skipIf(!systemdUserSessionAvailable())(
  'createSystemdLocalSupervisorBackend (issue #658, real systemctl --user, scratch unit)',
  () => {
    const unitName = `loombox-backend-test-${process.pid}.service`;
    let homeDir: string;
    let baseDir: string;
    let stateDir: string;
    const realUnitDir = join(homedir(), '.config', 'systemd', 'user');

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'loombox-systemd-local-backend-real-'));
      baseDir = join(homeDir, '.loombox');
      stateDir = join(homeDir, '.loombox', 'node');
    });

    afterEach(async () => {
      await execFileAsync('systemctl', ['--user', 'disable', '--now', unitName]).catch(() => {});
      await rm(join(realUnitDir, unitName), { force: true });
      await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => {});
      await rm(homeDir, { recursive: true, force: true });
    });

    it('installs a real unit that stays running, restarts it for real, and preserves state-dir contents; uninstall leaves nothing behind', async () => {
      const backend = createSystemdLocalSupervisorBackend({
        unitName,
        baseDir,
        unitDir: realUnitDir,
        stateDir,
        enableLinger: false,
      });

      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'identity.json'), JSON.stringify({ nodeId: 'scratch-node' }));

      // A real, long-lived (but harmless) node.mjs — actually exec'd by
      // systemd, not just written to disk. Stays alive via a paused stdin
      // read (keeps the event loop open), deliberately not a timer: this
      // process only needs to exist for `systemctl` to supervise, not to
      // wait on anything.
      const install = await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('process.stdin.resume();'),
        nodeExecutable: process.execPath,
        environment: {},
      });
      expect(install.ok).toBe(true);
      expect(install.action).toBe('install');
      expect(install.message).toContain('will NOT survive a reboot');

      const runningStatus = await backend.status();
      expect(runningStatus.installed).toBe(true);
      expect(runningStatus.state).toBe('running');
      expect(runningStatus.version).toBe('1.0.0');

      // The literal command this issue's acceptance names.
      const restart = await execFileAsync('systemctl', ['--user', 'restart', unitName]);
      expect(restart.stderr).toBe('');

      const afterRestart = await backend.status();
      expect(afterRestart.state).toBe('running');
      const identityAfterRestart = await readFile(join(stateDir, 'identity.json'), 'utf8');
      expect(JSON.parse(identityAfterRestart)).toEqual({ nodeId: 'scratch-node' });

      // Declined linger: never asked for, and honestly not enabled.
      expect(await backend.survivesReboot()).toBe(false);
      const linger = await execFileAsync('loginctl', ['show-user', `${process.getuid?.()}`, '-p', 'Linger']).catch(
        () => undefined,
      );
      void linger; // this user's own linger state is pre-existing account state, not asserted on here — see this module's own doc comment: uninstall/decline never touch it.

      const uninstall = await backend.uninstall();
      expect(uninstall.ok).toBe(true);
      const afterUninstall = await backend.status();
      expect(afterUninstall.installed).toBe(false);
      await expect(readFile(join(stateDir, 'identity.json'))).rejects.toThrow();
      await expect(readlink(join(baseDir, 'current'))).rejects.toThrow();
      const unitStillThere = await execFileAsync('systemctl', ['--user', 'status', unitName]).catch(
        (error: { code?: number }) => error,
      );
      // `systemctl status` on an unknown unit exits 4 ("no such unit").
      expect((unitStillThere as { code?: number }).code).toBe(4);
    });
  },
);
