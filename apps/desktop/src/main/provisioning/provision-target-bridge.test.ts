import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeTransport, SshTargetStore, type SshTargetConfig } from '@loombox/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveProvisionTargetDeps,
  resolveSupervisorArtifactDeps,
  runProvisionTarget,
} from './provision-target-bridge';

const TARGET: SshTargetConfig = {
  id: 'devbox-1',
  label: 'Dev box',
  host: '127.0.0.1',
  user: 'loombox',
};

/** Fails the test if it's ever consulted — proves a stopped-at-step-1 chain never reaches supervisor_install. */
const NEVER_FETCHED_ARTIFACT_SOURCE = {
  fetch: async () => {
    throw new Error('artifactSource.fetch should never be called: verify_and_persist failed first');
  },
};

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'loombox-desktop-provision-bridge-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('resolveProvisionTargetDeps', () => {
  it('is undefined until #398/#399 land (no resident-node relay/identity config source exists yet)', () => {
    expect(resolveProvisionTargetDeps()).toBeUndefined();
  });
});

describe('resolveSupervisorArtifactDeps (issue #817)', () => {
  it('resolves a real, working local-fs artifact source, pinned public key, and @loombox/supervisor\u2019s own version', async () => {
    const deps = await resolveSupervisorArtifactDeps();

    expect(deps.supervisor.targetVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(deps.supervisor.publicKey).toBeInstanceOf(Uint8Array);
    expect(deps.supervisor.publicKey.byteLength).toBe(32);
    expect(typeof deps.supervisor.artifactSource.fetch).toBe('function');
  });

  it('honors an overridden releasesDir instead of the default ~/.loombox/releases', async () => {
    const releasesDir = await mkdtemp(join(tmpdir(), 'loombox-desktop-releases-'));
    try {
      const deps = await resolveSupervisorArtifactDeps({ releasesDir });
      await expect(
        deps.supervisor.artifactSource.fetch(
          { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' },
          '1.0.0',
        ),
      ).rejects.toThrow(/no supervisor build staged/);
    } finally {
      await rm(releasesDir, { recursive: true, force: true });
    }
  });
});

describe('runProvisionTarget', () => {
  it('genuinely delegates to @loombox/node provision() and returns its real, unmodified result', async () => {
    const connectError = new Error('connect ECONNREFUSED 127.0.0.1:22');
    (connectError as unknown as { code: string }).code = 'ECONNREFUSED';

    const result = await runProvisionTarget(TARGET, {
      transportFactory: () => new FakeTransport({ connectError }),
      store: new SshTargetStore({ stateDir }),
      runtime: { skip: true },
      supervisor: {
        artifactSource: NEVER_FETCHED_ARTIFACT_SOURCE,
        targetVersion: '0.0.0-test',
        publicKey: new Uint8Array(32),
      },
      residentNode: {
        skip: true,
        config: { relayUrl: 'wss://relay.loombox.dev', nodeId: TARGET.id },
      },
    });

    // The real provision() contract (packages/node/src/ssh/provision-target.ts):
    // stops at the first failed step, later steps are absent entirely.
    expect(result.ok).toBe(false);
    expect(result.targetId).toBe(TARGET.id);
    expect(result.failedStep).toBe('verify_and_persist');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ step: 'verify_and_persist', ok: false });

    // A genuine connect failure never persists the target.
    expect(new SshTargetStore({ stateDir }).list()).toEqual([]);
  });
});
