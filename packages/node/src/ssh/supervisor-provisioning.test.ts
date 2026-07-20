import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FakeTransport, type FakeExecHandler } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import type { SupervisorArtifactSource } from './supervisor-artifact';
import {
  executeSupervisorProvisioning,
  planSupervisorProvisioning,
  readRemoteSupervisorVersion,
  resolveSupervisorBaseDir,
} from './supervisor-provisioning';

function generateEd25519Pair(): { privateKey: KeyObject; publicKeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

function sign(bytes: Uint8Array, privateKey: KeyObject): Uint8Array {
  return new Uint8Array(cryptoSign(null, Buffer.from(bytes), privateKey));
}

function signedArtifactSource(
  privateKey: KeyObject,
  payload = 'supervisor-runtime',
): {
  source: SupervisorArtifactSource;
  bytes: Uint8Array;
} {
  const bytes = new TextEncoder().encode(payload);
  const source: SupervisorArtifactSource = {
    fetch: async (_osArch, version) => ({ version, bytes, signature: sign(bytes, privateKey) }),
  };
  return { source, bytes };
}

async function fakeConnected(onExec: FakeExecHandler) {
  const transport = new FakeTransport({ onExec });
  await transport.connect();
  return transport;
}

describe('planSupervisorProvisioning', () => {
  it('marks an unrecognized os/arch unsupported and never fetches an artifact for it', async () => {
    const { publicKeyRaw } = generateEd25519Pair();
    let fetchCalled = false;
    const source: SupervisorArtifactSource = {
      fetch: async () => {
        fetchCalled = true;
        throw new Error('should not be called');
      },
    };
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'SunOS sun4u', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
    });

    expect(plan.action).toBe('unsupported');
    expect(plan.changes).toEqual([]);
    expect(fetchCalled).toBe(false);
  });

  it('is a noop when the remote already reports the target version, without fetching an artifact', async () => {
    const { publicKeyRaw } = generateEd25519Pair();
    let fetchCalled = false;
    const source: SupervisorArtifactSource = {
      fetch: async () => {
        fetchCalled = true;
        throw new Error('should not be called');
      },
    };
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('$HOME/.loombox/supervisor')) {
        return { stdout: '/home/u/.loombox/supervisor', stderr: '', exitCode: 0 };
      }
      if (command.includes('VERSION')) return { stdout: '1.0.0', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
    });

    expect(plan.action).toBe('noop');
    expect(plan.currentVersion).toBe('1.0.0');
    expect(plan.changes).toEqual([]);
    expect(fetchCalled).toBe(false);
  });

  it('plans an install with a diff of what will change when nothing is staged yet', async () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const { source } = signedArtifactSource(privateKey);
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('$HOME/.loombox/supervisor')) {
        return { stdout: '/home/u/.loombox/supervisor', stderr: '', exitCode: 0 };
      }
      if (command.includes('VERSION')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
    });

    expect(plan.action).toBe('install');
    expect(plan.currentVersion).toBeUndefined();
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.changes.join('\n')).toContain('1.0.0');
    expect(plan.artifact).toBeDefined();
  });

  it('plans an upgrade when the remote is staged at an older version', async () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const { source } = signedArtifactSource(privateKey);
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('$HOME/.loombox/supervisor')) {
        return { stdout: '/home/u/.loombox/supervisor', stderr: '', exitCode: 0 };
      }
      if (command.includes('VERSION')) return { stdout: '0.9.0', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
    });

    expect(plan.action).toBe('upgrade');
    expect(plan.currentVersion).toBe('0.9.0');
    expect(plan.artifact).toBeDefined();
  });

  it('refuses to plan an install/upgrade when the fetched artifact has an invalid signature, and carries no artifact forward', async () => {
    const { publicKeyRaw } = generateEd25519Pair();
    const attacker = generateEd25519Pair();
    const { source } = signedArtifactSource(attacker.privateKey);
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('$HOME/.loombox/supervisor')) {
        return { stdout: '/home/u/.loombox/supervisor', stderr: '', exitCode: 0 };
      }
      if (command.includes('VERSION')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
    });

    expect(plan.action).toBe('refused');
    expect(plan.refusalReason).toBe('invalid_signature');
    expect(plan.changes).toEqual([]);
    expect(plan.artifact).toBeUndefined();
  });

  it('refuses to plan when the fetched artifact has no signature at all', async () => {
    const { publicKeyRaw } = generateEd25519Pair();
    const bytes = new TextEncoder().encode('payload');
    const source: SupervisorArtifactSource = {
      fetch: async (_osArch, version) => ({ version, bytes, signature: undefined }),
    };
    const transport = await fakeConnected((command) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('$HOME/.loombox/supervisor')) {
        return { stdout: '/home/u/.loombox/supervisor', stderr: '', exitCode: 0 };
      }
      if (command.includes('VERSION')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const plan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
    });

    expect(plan.action).toBe('refused');
    expect(plan.refusalReason).toBe('missing_signature');
  });
});

describe('executeSupervisorProvisioning', () => {
  it('is a no-op for a "noop" plan and never touches the transport', async () => {
    const transport = await fakeConnected(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const result = await executeSupervisorProvisioning(transport, {
      osArch: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' },
      baseDir: '/home/u/.loombox/supervisor',
      currentVersion: '1.0.0',
      targetVersion: '1.0.0',
      action: 'noop',
      changes: [],
      message: 'already current',
    });
    expect(result).toEqual({ ok: true, action: 'noop', installedVersion: '1.0.0' });
    expect(transport.calls).toEqual([]);
  });

  it('refuses to run a "refused" plan and never touches the transport', async () => {
    const transport = await fakeConnected(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const result = await executeSupervisorProvisioning(transport, {
      osArch: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' },
      baseDir: '/home/u/.loombox/supervisor',
      currentVersion: undefined,
      targetVersion: '1.0.0',
      action: 'refused',
      changes: [],
      refusalReason: 'invalid_signature',
      message: 'refusing to provision: bad signature',
    });
    expect(result.ok).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it('stages a verified artifact for real, and a second run of the same plan-then-execute is a no-op (idempotent re-provisioning, issue #87)', async () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const { source, bytes } = signedArtifactSource(privateKey, 'supervisor-runtime-payload');

    const transport = new LocalProcessTransport();
    await transport.connect();
    const baseDir = await resolveSupervisorBaseDir(transport);
    // Give every run in this test its own sandbox dir under the real tmp
    // filesystem `LocalProcessTransport` actually executes against.
    const sandboxBase = `${baseDir}-test-${Date.now()}`;

    const firstPlan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
      baseDir: sandboxBase,
    });
    expect(firstPlan.action).toBe('install');

    const firstResult = await executeSupervisorProvisioning(transport, firstPlan);
    expect(firstResult).toEqual({ ok: true, action: 'install', installedVersion: '1.0.0' });

    const stagedVersion = await readRemoteSupervisorVersion(transport, sandboxBase);
    expect(stagedVersion).toBe('1.0.0');

    const binCheck = await transport.exec(`cat "${sandboxBase}/supervisor-bin"`);
    expect(binCheck.stdout).toBe(new TextDecoder().decode(bytes));

    // Re-running plan+execute against the now-current target is a no-op.
    const secondPlan = await planSupervisorProvisioning(transport, {
      artifactSource: source,
      targetVersion: '1.0.0',
      publicKey: publicKeyRaw,
      baseDir: sandboxBase,
    });
    expect(secondPlan.action).toBe('noop');
    const secondResult = await executeSupervisorProvisioning(transport, secondPlan);
    expect(secondResult).toEqual({ ok: true, action: 'noop', installedVersion: '1.0.0' });

    // Bumping the target version upgrades in place.
    const { source: v2Source } = signedArtifactSource(privateKey, 'supervisor-runtime-v2');
    const upgradePlan = await planSupervisorProvisioning(transport, {
      artifactSource: v2Source,
      targetVersion: '2.0.0',
      publicKey: publicKeyRaw,
      baseDir: sandboxBase,
    });
    expect(upgradePlan.action).toBe('upgrade');
    expect(upgradePlan.currentVersion).toBe('1.0.0');
    const upgradeResult = await executeSupervisorProvisioning(transport, upgradePlan);
    expect(upgradeResult).toEqual({ ok: true, action: 'upgrade', installedVersion: '2.0.0' });
    expect(await readRemoteSupervisorVersion(transport, sandboxBase)).toBe('2.0.0');

    await transport.exec(`rm -rf "${sandboxBase}"`);
    await transport.close();
  });
});
