import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalInstallLayoutDriver, createTarGzArchive } from '../install-layout';
import { createLocalFsSupervisorArtifactSource } from './local-fs-artifact-source';
import type { RemoteOsArch } from './remote-runtime';
import { verifySupervisorArtifact } from './supervisor-artifact';

/** Generates a real Ed25519 keypair and returns the raw 32-byte public key alongside the signing `KeyObject` — same shape as `supervisor-artifact.test.ts`'s own helper (SPEC §16's minisign-style pinned key). */
function generateEd25519Pair(): { privateKey: KeyObject; publicKeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

function sign(bytes: Uint8Array, privateKey: KeyObject): Uint8Array {
  return new Uint8Array(cryptoSign(null, Buffer.from(bytes), privateKey));
}

const LINUX_X64: RemoteOsArch = { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' };

describe('createLocalFsSupervisorArtifactSource (issue #817)', () => {
  let releasesDir: string;

  beforeEach(async () => {
    releasesDir = await mkdtemp(path.join(tmpdir(), 'loombox-local-fs-artifact-'));
  });

  afterEach(async () => {
    await rm(releasesDir, { recursive: true, force: true });
  });

  it('reads a staged artifact + its detached signature for the requested version/os/arch', async () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const payload = new TextEncoder().encode('#!/bin/sh\necho real-supervisor\n');
    const signature = sign(payload, privateKey);

    const dir = path.join(releasesDir, '1.0.0', 'linux-x64');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'supervisor-bin'), payload);
    await writeFile(path.join(dir, 'supervisor-bin.sig'), signature);

    const source = createLocalFsSupervisorArtifactSource({ releasesDir });
    const artifact = await source.fetch(LINUX_X64, '1.0.0');

    expect(artifact.version).toBe('1.0.0');
    expect(new Uint8Array(artifact.bytes)).toEqual(payload);
    expect(verifySupervisorArtifact(artifact, publicKeyRaw)).toEqual({ ok: true });
  });

  it('returns signature: undefined when no .sig file is staged, never a fabricated one', async () => {
    const dir = path.join(releasesDir, '1.0.0', 'linux-x64');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'supervisor-bin'), 'unsigned-payload');

    const source = createLocalFsSupervisorArtifactSource({ releasesDir });
    const artifact = await source.fetch(LINUX_X64, '1.0.0');

    expect(artifact.signature).toBeUndefined();
  });

  it('rejects with a clear error when nothing is staged for the requested version/os/arch', async () => {
    const source = createLocalFsSupervisorArtifactSource({ releasesDir });
    await expect(source.fetch(LINUX_X64, '9.9.9')).rejects.toThrow(/no supervisor build staged/);
  });

  it('never conflates one os/arch\u2019s build with another\u2019s', async () => {
    const linuxDir = path.join(releasesDir, '1.0.0', 'linux-x64');
    await mkdir(linuxDir, { recursive: true });
    await writeFile(path.join(linuxDir, 'supervisor-bin'), 'linux-build');

    const source = createLocalFsSupervisorArtifactSource({ releasesDir });
    const darwinArm: RemoteOsArch = {
      os: 'darwin',
      arch: 'arm64',
      rawOs: 'Darwin',
      rawArch: 'arm64',
    };
    await expect(source.fetch(darwinArm, '1.0.0')).rejects.toThrow(/no supervisor build staged/);
  });

  it('a tampered artifact fails verification and is never staged (issue #817 acceptance)', async () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const originalPayload = new TextEncoder().encode('#!/bin/sh\necho real-supervisor\n');
    const signature = sign(originalPayload, privateKey);

    const dir = path.join(releasesDir, '1.0.0', 'linux-x64');
    await mkdir(dir, { recursive: true });
    // Signed, then tampered on disk after signing — exactly the
    // "verified bytes replaced after the fact" attack this whole
    // verify-before-stage chain exists to catch.
    await writeFile(path.join(dir, 'supervisor-bin'), 'tampered-payload-not-what-was-signed');
    await writeFile(path.join(dir, 'supervisor-bin.sig'), signature);

    const source = createLocalFsSupervisorArtifactSource({ releasesDir });
    const artifact = await source.fetch(LINUX_X64, '1.0.0');

    const verification = verifySupervisorArtifact(artifact, publicKeyRaw);
    expect(verification).toMatchObject({ ok: false, reason: 'invalid_signature' });

    // The install-layout half of "never staged": a caller that gates
    // staging on verification (exactly how `supervisor-provisioning.ts`'s
    // `planSupervisorProvisioning` already does for the ssh path) never
    // calls stageVersion at all when verification fails — proven here by
    // never calling it and asserting nothing landed under baseDir.
    const baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-install-layout-tampered-'));
    try {
      const driver = createLocalInstallLayoutDriver();
      if (verification.ok) {
        await driver.stageVersion(baseDir, artifact.version, await createTarGzArchive(dir));
      }
      expect(await driver.listStagedVersions(baseDir)).toEqual([]);
      expect(await driver.currentVersion(baseDir)).toBeUndefined();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
