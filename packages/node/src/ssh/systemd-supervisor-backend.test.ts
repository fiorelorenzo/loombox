import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTarGzArchive } from '../install-layout';
import { NODE_BUNDLE_ENTRY_FILE } from '../node-release';
import type { SupervisorBackend } from '../supervisor-backend';
import { FakeTransport } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';
import { createSystemdSshSupervisorBackend } from './systemd-supervisor-backend';
import { DEFAULT_UNIT_NAME } from './systemd-provisioning';

/** Builds a tiny fixture tar.gz whose one file (`marker.txt`) contains `content` — same helper shape `install-layout.test.ts` uses. */
async function fixtureArchive(content: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(join(tmpdir(), 'loombox-systemd-backend-fixture-'));
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
 * `systemd-provisioning.test.ts`'s own `RealFileFakeSystemctlTransport`
 * uses, extended here to also fake `is-active`/`is-enabled`/`start`/
 * `stop`/`show-user` query results via `queryResponses`.
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

describe('createSystemdSshSupervisorBackend (issue #654, real file I/O)', () => {
  let homeDir: string;
  let baseDir: string;
  let unitDir: string;
  let stateDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'loombox-systemd-backend-home-'));
    baseDir = join(homeDir, '.loombox');
    unitDir = join(homeDir, '.config', 'systemd', 'user');
    stateDir = join(homeDir, '.loombox', 'node');
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function makeBackend(transport: RemoteTransport): SupervisorBackend {
    return createSystemdSshSupervisorBackend(transport, { baseDir, unitDir, stateDir });
  }

  it('stages, activates, and starts a fresh install for real, then reports noop on an identical re-install', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport);
      const install = await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: { LOOMBOX_RELAY_URL: 'wss://relay.example' },
      });
      expect(install).toEqual({
        ok: true,
        action: 'install',
        message: expect.stringContaining('now running version 1.0.0'),
      });
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
      const unitContent = await readFile(join(unitDir, DEFAULT_UNIT_NAME), 'utf8');
      expect(unitContent).toContain(
        `ExecStart=/usr/bin/node ${join(baseDir, 'current', NODE_BUNDLE_ENTRY_FILE)}`,
      );
      expect(unitContent).toContain('Environment=LOOMBOX_RELAY_URL=wss://relay.example');

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

  it('restarts explicitly when only the version bumps (unit content unchanged)', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport);
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

  it('reports update (not restart) when only the environment changes, same version', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport);
      await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: { LOOMBOX_RELAY_URL: 'wss://relay.example' },
      });

      transport.interceptedCommands.length = 0;
      const update = await backend.install({
        version: '1.0.0',
        fetchArchive: async () => {
          throw new Error('fetchArchive should not be called: the version did not change');
        },
        nodeExecutable: '/usr/bin/node',
        environment: { LOOMBOX_RELAY_URL: 'wss://relay.example', LOOMBOX_DEVICE_TOKEN: 'tok-2' },
      });
      expect(update).toEqual({ ok: true, action: 'update', message: expect.any(String) });
      expect(transport.interceptedCommands).toEqual([
        'systemctl --user daemon-reload',
        `systemctl --user enable --now '${DEFAULT_UNIT_NAME}'`,
        'loginctl enable-linger "$(id -un)"',
      ]);
    } finally {
      await transport.close();
    }
  });

  it('uninstall removes the unit, the installed code, and (by default) the state dir', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport);
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

  it('uninstall keeps the state dir when keepData is set', async () => {
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();
    try {
      const backend = makeBackend(transport);
      await backend.install({
        version: '1.0.0',
        fetchArchive: async () => fixtureArchive('v1'),
        nodeExecutable: '/usr/bin/node',
        environment: {},
      });
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'identity.json'), '{}');

      await backend.uninstall({ keepData: true });

      const preserved = await readFile(join(stateDir, 'identity.json'), 'utf8');
      expect(preserved).toBe('{}');
      await expect(readlink(join(baseDir, 'current'))).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });
});

describe('createSystemdSshSupervisorBackend (issue #654, decision logic against FakeTransport)', () => {
  function fixedOsArchHandler(
    responses: Record<string, RemoteExecResult>,
  ): (command: string, options: RemoteExecOptions) => RemoteExecResult {
    return (command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      for (const [prefix, result] of Object.entries(responses)) {
        if (command.startsWith(prefix)) return result;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  }

  it('install() reports unsupported (ok: true) and never fetches the archive when systemctl is absent', async () => {
    const transport = new FakeTransport({
      onExec: fixedOsArchHandler({
        'command -v systemctl': { stdout: 'missing\n', stderr: '', exitCode: 0 },
      }),
    });
    await transport.connect();
    const backend = createSystemdSshSupervisorBackend(transport, {
      baseDir: '/home/loombox/.loombox',
      unitDir: '/home/loombox/.config/systemd/user',
    });

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
    const backend = createSystemdSshSupervisorBackend(transport, {
      baseDir: '/home/loombox/.loombox',
      unitDir: '/home/loombox/.config/systemd/user',
    });

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

  it('status() maps systemctl is-active to the run-state vocabulary', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        if (command.startsWith('test -f')) return { stdout: 'yes\n', stderr: '', exitCode: 0 };
        if (command.startsWith('readlink')) return { stdout: '', stderr: '', exitCode: 1 };
        if (command.startsWith('systemctl --user is-active')) {
          return { stdout: 'active\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();
    const backend = createSystemdSshSupervisorBackend(transport, {
      baseDir: '/home/loombox/.loombox',
      unitDir: '/home/loombox/.config/systemd/user',
    });

    const status = await backend.status();
    expect(status.installed).toBe(true);
    expect(status.state).toBe('running');
  });

  it('survivesReboot() is true only when the unit is enabled AND linger is on', async () => {
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
    const backend = createSystemdSshSupervisorBackend(transport, {
      baseDir: '/home/loombox/.loombox',
      unitDir: '/home/loombox/.config/systemd/user',
    });

    expect(await backend.survivesReboot()).toBe(true);
  });
});
