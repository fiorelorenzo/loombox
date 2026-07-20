import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FakeTransport, type FakeExecHandler } from './fake-transport';
import type { SupervisorArtifactSource } from './supervisor-artifact';
import {
  compareTargetVersion,
  compareVersions,
  TargetUpdateMonitor,
} from './target-update-monitor';

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
): SupervisorArtifactSource {
  const bytes = new TextEncoder().encode(payload);
  return {
    fetch: async (_osArch, version) => ({ version, bytes, signature: sign(bytes, privateKey) }),
  };
}

async function fakeConnected(onExec: FakeExecHandler) {
  const transport = new FakeTransport({ onExec });
  await transport.connect();
  return transport;
}

describe('compareVersions', () => {
  it('compares dotted numeric versions numerically, not lexicographically', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.2.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('compareTargetVersion', () => {
  it('reports "unknown" when the remote has no reported version', () => {
    expect(compareTargetVersion(undefined, '1.0.0')).toBe('unknown');
  });

  it('reports "current" when versions match', () => {
    expect(compareTargetVersion('1.2.0', '1.2.0')).toBe('current');
  });

  it('reports "behind" when the remote is older than pinned', () => {
    expect(compareTargetVersion('1.0.0', '1.2.0')).toBe('behind');
  });

  it('reports "ahead" when the remote is newer than pinned', () => {
    expect(compareTargetVersion('2.0.0', '1.2.0')).toBe('ahead');
  });
});

describe('TargetUpdateMonitor', () => {
  it('handshakes a target, tracks its status, and lists it as outdated when behind', async () => {
    const monitor = new TargetUpdateMonitor({ pinnedVersion: '1.2.0' });
    const transport = await fakeConnected((command) => {
      if (command.includes('$HOME/.loombox/supervisor'))
        return { stdout: '/h/.loombox/supervisor', stderr: '', exitCode: 0 };
      if (command.includes('VERSION')) return { stdout: '1.0.0', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    expect(monitor.statusFor('box-1')).toBeUndefined();
    expect(monitor.isOutdated('box-1')).toBe(false);

    const result = await monitor.handshake('box-1', transport);
    expect(result.status).toBe('behind');
    expect(result.remoteVersion).toBe('1.0.0');
    expect(result.pinnedVersion).toBe('1.2.0');
    expect(monitor.isOutdated('box-1')).toBe(true);
    expect(monitor.listOutdated().map((r) => r.targetId)).toEqual(['box-1']);
  });

  it('does not list a current target as outdated', async () => {
    const monitor = new TargetUpdateMonitor({ pinnedVersion: '1.0.0' });
    const transport = await fakeConnected((command) => {
      if (command.includes('$HOME/.loombox/supervisor'))
        return { stdout: '/h/.loombox/supervisor', stderr: '', exitCode: 0 };
      if (command.includes('VERSION')) return { stdout: '1.0.0', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await monitor.handshake('box-1', transport);
    expect(monitor.isOutdated('box-1')).toBe(false);
    expect(monitor.listOutdated()).toEqual([]);
  });

  it('updateTarget triggers the idempotent re-provision flow and re-handshakes so status reflects the outcome', async () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const source = signedArtifactSource(privateKey);
    const monitor = new TargetUpdateMonitor({ pinnedVersion: '2.0.0' });

    let stagedVersion: string | undefined = '1.0.0';
    const transport = await fakeConnected((command, options) => {
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('$HOME/.loombox/supervisor'))
        return { stdout: '/h/.loombox/supervisor', stderr: '', exitCode: 0 };
      if (command.startsWith('cat') && command.includes('VERSION')) {
        return { stdout: stagedVersion ?? '', stderr: '', exitCode: stagedVersion ? 0 : 1 };
      }
      if (command.startsWith('printf') && command.includes('VERSION')) {
        // Extract the quoted version being written: printf '%s' '2.0.0' > '.../VERSION'
        const match = /printf '%s' '([^']*)'/.exec(command);
        stagedVersion = match?.[1];
        void options;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const before = await monitor.handshake('box-1', transport);
    expect(before.status).toBe('behind');

    const updateResult = await monitor.updateTarget('box-1', transport, {
      artifactSource: source,
      publicKey: publicKeyRaw,
    });

    expect(updateResult.ok).toBe(true);
    expect(updateResult.action).toBe('upgrade');
    expect(updateResult.installedVersion).toBe('2.0.0');

    const after = monitor.statusFor('box-1');
    expect(after?.status).toBe('current');
    expect(after?.remoteVersion).toBe('2.0.0');
    expect(monitor.isOutdated('box-1')).toBe(false);
  });
});
