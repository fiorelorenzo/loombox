import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';
import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import { FakeTransport } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import {
  DEFAULT_UNIT_NAME,
  executeSystemdProvisioning,
  generateSystemdUnit,
  planSystemdProvisioning,
} from './systemd-provisioning';
import { Ssh2Transport } from './ssh2-transport';

describe('generateSystemdUnit', () => {
  it('renders a Type=simple/Restart=always/KillMode=process user-unit (issue #89, SPEC §16)', () => {
    const content = generateSystemdUnit({
      execStart: '/home/loombox/.loombox/supervisor/supervisor-bin',
      execArgs: ['--node'],
      workingDirectory: '/home/loombox',
      environment: { LOOMBOX_ROLE: 'resident-node' },
    });

    expect(content).toContain('[Unit]');
    expect(content).toContain('[Service]');
    expect(content).toContain('Type=simple');
    expect(content).toContain('Restart=always');
    expect(content).toContain('KillMode=process');
    expect(content).toContain('ExecStart=/home/loombox/.loombox/supervisor/supervisor-bin --node');
    expect(content).toContain('WorkingDirectory=/home/loombox');
    expect(content).toContain('Environment=LOOMBOX_ROLE=resident-node');
    expect(content).toContain('[Install]');
    expect(content).toContain('WantedBy=default.target');
  });

  it('is deterministic for the same config (used for the noop/update comparison)', () => {
    const config = { execStart: '/bin/loombox-node' };
    expect(generateSystemdUnit(config)).toBe(generateSystemdUnit(config));
  });
});

describe('planSystemdProvisioning (issue #89)', () => {
  it('refuses gracefully when the remote has no systemctl, leaving the target otherwise usable', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.includes('command -v systemctl')) {
          return { stdout: 'missing\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();

    const plan = await planSystemdProvisioning(transport, {
      unit: { execStart: '/bin/loombox-node' },
    });

    expect(plan.action).toBe('unsupported');
    expect(plan.systemctlPresent).toBe(false);
    expect(plan.commands).toEqual([]);

    // Declining (never calling execute) is exactly what happens for an
    // 'unsupported' plan — nothing was ever touched on the remote beyond the
    // read-only detection probes above.
    const result = await executeSystemdProvisioning(transport, plan);
    expect(result.ok).toBe(false);
    expect(result.action).toBe('unsupported');
  });

  it('emits the exact install command sequence and unit content for a fresh install', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.includes('command -v systemctl')) {
          return { stdout: 'present\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('cat ')) return { stdout: '', stderr: '', exitCode: 0 };
        if (command.startsWith('printf %s "$HOME')) {
          return { stdout: '/home/loombox/.config/systemd/user\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();

    const plan = await planSystemdProvisioning(transport, {
      unit: { execStart: '/home/loombox/.loombox/supervisor/supervisor-bin' },
    });

    expect(plan.action).toBe('install');
    expect(plan.unitName).toBe(DEFAULT_UNIT_NAME);
    expect(plan.unitPath).toBe(`/home/loombox/.config/systemd/user/${DEFAULT_UNIT_NAME}`);
    expect(plan.commands).toHaveLength(5);
    expect(plan.commands[0]).toBe(`mkdir -p '/home/loombox/.config/systemd/user'`);
    // The write-unit-content command carries the exact generated unit body.
    expect(plan.commands[1]).toContain(plan.unitPath);
    expect(plan.commands[1]).toContain('Type=simple');
    expect(plan.commands[1]).toContain(plan.desiredContent.replace(/'/g, `'\\''`));
    expect(plan.commands[2]).toBe('systemctl --user daemon-reload');
    expect(plan.commands[3]).toBe(`systemctl --user enable --now '${DEFAULT_UNIT_NAME}'`);
    expect(plan.commands[4]).toBe('loginctl enable-linger "$(id -un)"');
  });
});

/**
 * Wraps a real `LocalProcessTransport` (so `mkdir`/`printf`/`cat` genuinely
 * touch disk, proving the unit content lands byte-for-byte) but intercepts
 * any command that would actually mutate this devbox's *real* systemd user
 * session (`systemctl --user daemon-reload`/`enable --now`, `loginctl
 * enable-linger`) — this devbox is itself a real systemd host (Debian 13),
 * so letting those commands run for real would pollute the shared machine's
 * actual systemd state. `command -v systemctl`/`uname` are read-only and
 * pass straight through. Records every intercepted command for assertion.
 */
class RealFileFakeSystemctlTransport implements RemoteTransport {
  readonly interceptedCommands: string[] = [];
  private readonly inner = new LocalProcessTransport();

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  async exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
    if (command.startsWith('systemctl --user') || command.startsWith('loginctl enable-linger')) {
      this.interceptedCommands.push(command);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return this.inner.exec(command, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe('planSystemdProvisioning + executeSystemdProvisioning (real "remote" file I/O, issue #89)', () => {
  it('installs the unit file for real, is idempotent (noop) on replan, and updates in place on a config change', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'loombox-systemd-home-'));
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();

    try {
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      const options = {
        unit: {
          execStart: '/home/loombox/.loombox/supervisor/supervisor-bin',
          execArgs: ['--node'],
        },
        unitDir,
      };

      const installPlan = await planSystemdProvisioning(transport, options);
      expect(installPlan.action).toBe('install');
      expect(installPlan.systemctlPresent).toBe(true);

      const installResult = await executeSystemdProvisioning(transport, installPlan);
      expect(installResult.ok).toBe(true);
      expect(installResult.action).toBe('install');
      // The exact enable/reload sequence issue #89 asks for actually ran
      // (intercepted rather than hitting the real devbox systemd — see the
      // transport's doc comment — but the command sequence itself is real).
      expect(transport.interceptedCommands).toEqual([
        'systemctl --user daemon-reload',
        `systemctl --user enable --now '${DEFAULT_UNIT_NAME}'`,
        'loginctl enable-linger "$(id -un)"',
      ]);

      // Re-planning against the now-installed file reports noop: the exact
      // same content is already staged, nothing left to do.
      const replan = await planSystemdProvisioning(transport, options);
      expect(replan.action).toBe('noop');
      expect(replan.commands).toEqual([]);
      const noopResult = await executeSystemdProvisioning(transport, replan);
      expect(noopResult.ok).toBe(true);
      expect(noopResult.action).toBe('noop');

      // Changing the config (a version/path bump) is detected as an update,
      // not a fresh install.
      transport.interceptedCommands.length = 0;
      const updatedOptions = {
        ...options,
        unit: { ...options.unit, environment: { LOOMBOX_ROLE: 'resident-node' } },
      };
      const updatePlan = await planSystemdProvisioning(transport, updatedOptions);
      expect(updatePlan.action).toBe('update');
      const updateResult = await executeSystemdProvisioning(transport, updatePlan);
      expect(updateResult.ok).toBe(true);
      expect(updateResult.action).toBe('update');
    } finally {
      await transport.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('declining to provision (never calling executeSystemdProvisioning) leaves the remote untouched', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'loombox-systemd-decline-'));
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();

    try {
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      // planSystemdProvisioning only ever reads; simply not calling execute
      // is issue #89's "declining leaves the target usable" — verified here
      // by checking the unit directory was never created.
      await planSystemdProvisioning(transport, {
        unit: { execStart: '/bin/loombox-node' },
        unitDir,
      });

      const check = await transport.exec(`[ -e '${unitDir}' ] && echo exists || echo absent`);
      expect(check.stdout.trim()).toBe('absent');
      expect(transport.interceptedCommands).toEqual([]);
    } finally {
      await transport.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

// Real-sshd integration (issue #89's acceptance: "integration test runs
// against a systemd-capable variant of the test SSH fixture"). The shared
// Dockerized SSH fixture (Alpine + sshd, see docker-sshd-fixture.ts) has no
// real systemd/pid1 — sshd itself execs as PID 1 — so there is no
// systemd-capable variant of it to run a live systemctl against. This test
// instead proves the provisioning LOGIC for real over a real SSH connection
// to that fixture: `planSystemdProvisioning` correctly detects the absence
// of systemctl and reports 'unsupported' without ever writing anything, and
// declining (not calling execute) leaves the target otherwise fully usable —
// exactly issue #89's decline-path acceptance criterion. Asserting the exact
// emitted install command sequence + unit content is instead covered by the
// FakeTransport/RealFileFakeSystemctlTransport cases above (see this wave's
// PR notes on the systemd-in-Docker gap).
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  'planSystemdProvisioning (Dockerized sshd fixture — no real systemd, issue #89)',
  () => {
    let fixture: DockerSshdFixture;
    let transport: Ssh2Transport;

    beforeAll(async () => {
      fixture = await startDockerSshdFixture();
    }, 120_000);

    afterAll(async () => {
      await fixture?.stop();
    }, 30_000);

    beforeEach(async () => {
      transport = new Ssh2Transport({
        host: fixture.host,
        port: fixture.port,
        username: fixture.username,
        privateKeyPath: fixture.privateKeyPath,
      });
      await transport.connect();
    });

    afterEach(async () => {
      await transport.close();
    });

    it('detects the fixture genuinely has no systemctl and refuses without writing anything, over a real SSH connection', async () => {
      const plan = await planSystemdProvisioning(transport, {
        unit: { execStart: '/home/loombox/.loombox/supervisor/supervisor-bin' },
      });

      expect(plan.systemctlPresent).toBe(false);
      expect(plan.action).toBe('unsupported');
      expect(plan.commands).toEqual([]);

      const result = await executeSystemdProvisioning(transport, plan);
      expect(result.ok).toBe(false);
      expect(result.action).toBe('unsupported');

      // Nothing was written: the unit directory this plan would have used
      // doesn't exist.
      const check = await transport.exec(
        `[ -e "$HOME/.config/systemd/user" ] && echo exists || echo absent`,
      );
      expect(check.stdout.trim()).toBe('absent');
    });
  },
);
