import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SshTargetConfig } from '../target';
import { decommissionSshTarget } from './decommission';
import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import {
  executeSupervisorProvisioning,
  planSupervisorProvisioning,
} from './supervisor-provisioning';
import type { SupervisorArtifactSource } from './supervisor-artifact';
import { FakeTransport } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';
import { DEFAULT_UNIT_NAME } from './systemd-provisioning';
import { Ssh2Transport } from './ssh2-transport';
import { SshTargetStore } from './verify-and-persist';

const CANDIDATE: SshTargetConfig = {
  id: 'devbox-1',
  label: 'Dev box',
  host: '100.87.202.117',
  user: 'dev',
};

let stateDir: string;
let store: SshTargetStore;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'loombox-decommission-store-'));
  store = new SshTargetStore({ stateDir });
  store.save(CANDIDATE);
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('decommissionSshTarget (issue #90)', () => {
  it('disables and removes an installed unit and its versioned bundle, revokes the target from the trusted set, and keeps the resident node state dir by default', async () => {
    const calls: string[] = [];
    const transport = new FakeTransport({
      onExec: (command) => {
        calls.push(command);
        if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.includes('command -v systemctl')) {
          return { stdout: 'present\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME/.config/systemd/user')) {
          return { stdout: '/home/loombox/.config/systemd/user\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME/.loombox')) {
          return { stdout: '/home/loombox/.loombox\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('cat ')) {
          return { stdout: '[Unit]\nDescription=x\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();

    const result = await decommissionSshTarget(transport, store, { targetId: CANDIDATE.id });

    expect(result.unitWasInstalled).toBe(true);
    expect(result.unitStopped).toBe(true);
    expect(result.unitDisabled).toBe(true);
    expect(result.deviceKeyRevoked).toBe(true);
    expect(result.filesRemoved).toBe(false);

    expect(calls).toContain(`systemctl --user disable --now '${DEFAULT_UNIT_NAME}' 2>/dev/null`);
    // The unit file and versioned bundle are gone even on the default
    // (keep-data) path now — moving onto the seam means an uninstalled
    // unit is never left disabled-but-present (decision E1-3).
    expect(calls).toContain(`rm -f '/home/loombox/.config/systemd/user/${DEFAULT_UNIT_NAME}'`);
    expect(calls).toContain(
      `rm -f '/home/loombox/.loombox/current' && rm -rf '/home/loombox/.loombox/versions'`,
    );
    // ...but the resident node's own state dir is never touched by default.
    expect(calls.some((c) => c.includes('.loombox/node'))).toBe(false);

    // The target no longer appears as usable — it's gone from the trusted set.
    expect(store.get(CANDIDATE.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('skips stop/disable entirely when no unit was ever installed for this target', async () => {
    const calls: string[] = [];
    const transport = new FakeTransport({
      onExec: (command) => {
        calls.push(command);
        if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.includes('command -v systemctl')) {
          return { stdout: 'present\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME')) {
          return { stdout: '/home/loombox/.config/systemd/user\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('cat ')) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();

    const result = await decommissionSshTarget(transport, store, { targetId: CANDIDATE.id });

    expect(result.unitWasInstalled).toBe(false);
    expect(result.unitStopped).toBe(false);
    expect(result.unitDisabled).toBe(false);
    expect(calls.some((c) => c.startsWith('systemctl'))).toBe(false);
    // Revocation still happens regardless of whether a unit existed.
    expect(store.get(CANDIDATE.id)).toBeUndefined();
  });

  it('accepting file cleanup also removes the versioned bundle and the resident node state dir', async () => {
    const calls: string[] = [];
    const transport = new FakeTransport({
      onExec: (command) => {
        calls.push(command);
        if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.includes('command -v systemctl')) {
          return { stdout: 'present\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME/.config/systemd/user')) {
          return { stdout: '/home/loombox/.config/systemd/user\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME/.loombox/node')) {
          return { stdout: '/home/loombox/.loombox/node\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME/.loombox')) {
          return { stdout: '/home/loombox/.loombox\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('cat ')) {
          return { stdout: '[Unit]\nDescription=x\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();

    const result = await decommissionSshTarget(transport, store, {
      targetId: CANDIDATE.id,
      removeFiles: true,
    });

    expect(result.filesRemoved).toBe(true);
    expect(calls).toContain(`rm -f '/home/loombox/.config/systemd/user/${DEFAULT_UNIT_NAME}'`);
    expect(calls).toContain(
      `rm -f '/home/loombox/.loombox/current' && rm -rf '/home/loombox/.loombox/versions'`,
    );
    expect(calls).toContain(`rm -rf '/home/loombox/.loombox/node'`);
  });

  it('accepting file cleanup also removes an explicitly given legacy pre-#817 staged directory', async () => {
    const calls: string[] = [];
    const transport = new FakeTransport({
      onExec: (command) => {
        calls.push(command);
        if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.includes('command -v systemctl')) {
          return { stdout: 'present\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME/.config/systemd/user')) {
          return { stdout: '/home/loombox/.config/systemd/user\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('printf %s "$HOME/.loombox')) {
          return { stdout: '/home/loombox/.loombox\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('cat ')) {
          return { stdout: '[Unit]\nDescription=x\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();

    const result = await decommissionSshTarget(transport, store, {
      targetId: CANDIDATE.id,
      legacySupervisorBaseDir: '/home/loombox/.loombox/supervisor',
      removeFiles: true,
    });

    expect(result.filesRemoved).toBe(true);
    expect(calls).toContain(`rm -rf '/home/loombox/.loombox/supervisor'`);
  });
});

/** Same real-file/fake-systemctl split as `systemd-provisioning.test.ts` — see that file's doc comment for why `systemctl --user ...` is intercepted rather than run for real on this devbox. `rm -rf`/`rm -f` run for real, proving actual file cleanup. */
class RealFileFakeSystemctlTransport implements RemoteTransport {
  readonly interceptedCommands: string[] = [];
  private readonly inner = new LocalProcessTransport();

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  async exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
    if (command.startsWith('systemctl --user')) {
      this.interceptedCommands.push(command);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return this.inner.exec(command, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe('decommissionSshTarget (real file cleanup, issue #90)', () => {
  it('really deletes the staged supervisor directory and unit file on accept, leaves them alone on decline', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'loombox-decommission-files-'));
    const transport = new RealFileFakeSystemctlTransport();
    await transport.connect();

    try {
      const supervisorBaseDir = join(homeDir, '.loombox', 'supervisor');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      const unitPath = join(unitDir, DEFAULT_UNIT_NAME);

      await transport.exec(`mkdir -p '${supervisorBaseDir}' '${unitDir}'`);
      await transport.exec(`printf 'fake-binary' > '${supervisorBaseDir}/supervisor-bin'`);
      await transport.exec(`printf '1.0.0' > '${supervisorBaseDir}/VERSION'`);
      await transport.exec(`printf '[Unit]\\nDescription=x\\n' > '${unitPath}'`);

      // Decline: nothing is removed.
      const declined = await decommissionSshTarget(transport, store, {
        targetId: CANDIDATE.id,
        legacySupervisorBaseDir: supervisorBaseDir,
        unitDir,
        baseDir: join(homeDir, '.loombox'),
        stateDir: join(homeDir, '.loombox', 'node'),
        removeFiles: false,
      });
      expect(declined.filesRemoved).toBe(false);
      const stillThere = await transport.exec(
        `[ -e '${supervisorBaseDir}/VERSION' ] && echo yes || echo no`,
      );
      expect(stillThere.stdout.trim()).toBe('yes');

      // Re-persist (decommissioning above already revoked it from the store).
      store.save(CANDIDATE);

      // Accept: both the supervisor directory and the unit file are really gone.
      const accepted = await decommissionSshTarget(transport, store, {
        targetId: CANDIDATE.id,
        legacySupervisorBaseDir: supervisorBaseDir,
        unitDir,
        baseDir: join(homeDir, '.loombox'),
        stateDir: join(homeDir, '.loombox', 'node'),
        removeFiles: true,
      });
      expect(accepted.filesRemoved).toBe(true);

      const supervisorGone = await transport.exec(
        `[ -e '${supervisorBaseDir}' ] && echo yes || echo no`,
      );
      expect(supervisorGone.stdout.trim()).toBe('no');
      const unitGone = await transport.exec(`[ -e '${unitPath}' ] && echo yes || echo no`);
      expect(unitGone.stdout.trim()).toBe('no');

      expect(store.get(CANDIDATE.id)).toBeUndefined();
    } finally {
      await transport.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

// Real-sshd integration (issue #90's acceptance: "integration test covers
// the full flow"): provisions the supervisor for real on the Dockerized SSH
// fixture, then decommissions with removeFiles: true and confirms the
// staged files are genuinely gone and the target no longer appears in the
// trusted set. The fixture has no real systemd (see systemd-provisioning
// .test.ts's doc comment), so the stop/disable step is exercised as a real,
// honest no-op here (systemctlPresent: false) rather than faked.
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  'decommissionSshTarget (Dockerized sshd fixture, issue #90)',
  () => {
    let fixture: DockerSshdFixture;
    let transport: Ssh2Transport;

    beforeEach(async () => {
      fixture = await startDockerSshdFixture();
      transport = new Ssh2Transport({
        host: fixture.host,
        port: fixture.port,
        username: fixture.username,
        privateKeyPath: fixture.privateKeyPath,
      });
      await transport.connect();
    }, 120_000);

    afterEach(async () => {
      await transport.close();
      await fixture?.stop();
    }, 30_000);

    it('decommissions a fully provisioned target end to end: stop/disable no-ops honestly, files are removed, target is revoked', async () => {
      const { publicKeyRaw, source } = buildFixtureArtifactSource();
      const provisionPlan = await planSupervisorProvisioning(transport, {
        artifactSource: source,
        targetVersion: '1.0.0',
        publicKey: publicKeyRaw,
      });
      const provisionResult = await executeSupervisorProvisioning(transport, provisionPlan);
      expect(provisionResult.ok).toBe(true);

      const staged = await transport.exec(
        `[ -e '${provisionPlan.baseDir}/VERSION' ] && echo yes || echo no`,
      );
      expect(staged.stdout.trim()).toBe('yes');

      const result = await decommissionSshTarget(transport, store, {
        targetId: CANDIDATE.id,
        legacySupervisorBaseDir: provisionPlan.baseDir,
        removeFiles: true,
      });

      expect(result.unitWasInstalled).toBe(false);
      expect(result.unitStopped).toBe(false);
      expect(result.unitDisabled).toBe(false);
      expect(result.filesRemoved).toBe(true);
      expect(result.deviceKeyRevoked).toBe(true);
      expect(store.get(CANDIDATE.id)).toBeUndefined();

      const goneAfter = await transport.exec(
        `[ -e '${provisionPlan.baseDir}' ] && echo yes || echo no`,
      );
      expect(goneAfter.stdout.trim()).toBe('no');
    });
  },
);

function generateEd25519Pair(): { privateKey: KeyObject; publicKeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

/** Builds a minimal, self-signed artifact source for the Docker-fixture provisioning step above — same convention `supervisor-provisioning.test.ts` uses for its own fixture artifact. */
function buildFixtureArtifactSource(): {
  publicKeyRaw: Uint8Array;
  source: SupervisorArtifactSource;
} {
  const { privateKey, publicKeyRaw } = generateEd25519Pair();
  const bytes = new TextEncoder().encode('#!/bin/sh\necho fake-supervisor\n');
  const signature = new Uint8Array(cryptoSign(null, Buffer.from(bytes), privateKey));
  return {
    publicKeyRaw,
    source: { fetch: async (_osArch, version) => ({ version, bytes, signature }) },
  };
}
