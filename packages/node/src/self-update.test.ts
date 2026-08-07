import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTarGzArchive, createLocalInstallLayoutDriver } from './install-layout';
import type { InstallLayoutDriver } from './install-layout';
import {
  applyNodeSelfUpdate,
  evaluateNodeUpdateStatus,
  verifyStagedNodeBuild,
  type NodeUpdateArtifact,
  type NodeUpdateSource,
} from './self-update';

/** A real Ed25519 keypair (SPEC §16's minisign-style pinned key), same helper shape as `local-fs-artifact-source.test.ts`'s own. */
function generateEd25519Pair(): { privateKey: KeyObject; publicKeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

/**
 * Builds a real, flat `node.mjs` + `package.json` bundle (the exact shape
 * `install-layout.ts`'s `stageVersion` extracts — `build-identity.ts`'s
 * own doc comment) and gzip-tars it, so `applyNodeSelfUpdate`'s staged-
 * verify step spawns a REAL subprocess against REAL files on disk, never a
 * mock — mirrors `install-layout.test.ts`'s own `fixtureArchive` helper.
 * `script` is the entire `node.mjs` body; a "good" bundle prints its own
 * identity as JSON on `--version` (mirrors `main.ts`'s real
 * `printBuildIdentity`), a "deliberately broken" one doesn't.
 */
async function fixtureNodeBundle(script: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'loombox-self-update-fixture-'));
  try {
    await writeFile(path.join(sourceDir, 'node.mjs'), script);
    return await createTarGzArchive(sourceDir);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

function goodBundleScript(version: string, commit = 'deadbeef'): string {
  return `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, commit: ${JSON.stringify(commit)} }));\n`;
}

const BROKEN_BUNDLE_SCRIPT = "console.error('boom'); process.exitCode = 1;\n";
const WRONG_VERSION_BUNDLE_SCRIPT = goodBundleScript('9.9.9');
const GARBAGE_OUTPUT_BUNDLE_SCRIPT = "console.log('not json at all');\n";

function fakeSource(artifactByVersion: Record<string, NodeUpdateArtifact>): NodeUpdateSource {
  return {
    checkLatest: async () => undefined,
    async fetch(version) {
      const artifact = artifactByVersion[version];
      if (!artifact) throw new Error(`fakeSource: no artifact staged for ${version}`);
      return artifact;
    },
  };
}

describe('evaluateNodeUpdateStatus', () => {
  it('is "current" when the latest known version equals the running one', () => {
    expect(evaluateNodeUpdateStatus('0.8.0', '0.8.0')).toBe('current');
  });

  it('is "update_available" when a strictly newer version is known', () => {
    expect(evaluateNodeUpdateStatus('0.8.0', '0.9.0')).toBe('update_available');
  });

  it('is "current", never "update_available", when the running version is newer (a dev build ahead of the latest release)', () => {
    expect(evaluateNodeUpdateStatus('0.9.0', '0.8.0')).toBe('current');
  });

  it('is "unknown" when nothing has been found yet — absence never reads as "current"', () => {
    expect(evaluateNodeUpdateStatus('0.8.0', undefined)).toBe('unknown');
  });
});

describe('verifyStagedNodeBuild', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-self-update-verify-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function stageScript(script: string): Promise<string> {
    const entry = path.join(baseDir, 'node.mjs');
    await writeFile(entry, script);
    return entry;
  }

  it('accepts a real subprocess that starts and reports the expected version', async () => {
    const entry = await stageScript(goodBundleScript('2.0.0'));
    const result = await verifyStagedNodeBuild(entry, '2.0.0');
    expect(result).toMatchObject({ ok: true, identity: { version: '2.0.0', commit: 'deadbeef' } });
  });

  it('rejects a deliberately broken build that exits non-zero — a real forced failure, not a mock', async () => {
    const entry = await stageScript(BROKEN_BUNDLE_SCRIPT);
    const result = await verifyStagedNodeBuild(entry, '2.0.0');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/did not start/);
  });

  it('rejects a build that starts but reports the wrong version (a packaging bug)', async () => {
    const entry = await stageScript(WRONG_VERSION_BUNDLE_SCRIPT);
    const result = await verifyStagedNodeBuild(entry, '2.0.0');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/reports version 9\.9\.9, expected 2\.0\.0/);
  });

  it('rejects a build whose --version output is not valid JSON', async () => {
    const entry = await stageScript(GARBAGE_OUTPUT_BUNDLE_SCRIPT);
    const result = await verifyStagedNodeBuild(entry, '2.0.0');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/not valid JSON/);
  });

  it('rejects a probe that never resolves within timeoutMs, killed rather than hung forever', async () => {
    // Genuine real-time exception (`ts-no-test-timers`'s own carve-out):
    // this proves `verifyStagedNodeBuild` actually kills a REAL hung
    // subprocess via `execFile`'s own `timeout` option, which schedules
    // against the platform clock inside `child_process` itself — there is
    // no fake-timer seam to drive that deterministically from here.
    // `timeoutMs: 300` keeps the real wait short.
    const entry = await stageScript('setInterval(() => {}, 1000);\n'); // never exits, never prints
    const result = await verifyStagedNodeBuild(entry, '2.0.0', { timeoutMs: 300 });
    expect(result.ok).toBe(false);
  }, 10_000);
});

describe('applyNodeSelfUpdate', () => {
  let baseDir: string;
  let driver: InstallLayoutDriver;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-self-update-apply-'));
    driver = createLocalInstallLayoutDriver();
    // Every scenario below starts from a real, already-running "1.0.0" —
    // staged and activated up front, exactly like a real node's baseDir
    // when it starts applying an update to itself.
    await driver.stageVersion(baseDir, '1.0.0', await fixtureNodeBundle(goodBundleScript('1.0.0')));
    await driver.activateVersion(baseDir, '1.0.0');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('stages, verifies, and activates a good build, then hands off to restart — the happy path', async () => {
    const source = fakeSource({
      '2.0.0': {
        version: '2.0.0',
        bytes: await fixtureNodeBundle(goodBundleScript('2.0.0')),
        signature: undefined,
      },
    });
    const restart = vi.fn();

    const outcome = await applyNodeSelfUpdate({
      baseDir,
      driver,
      source,
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      restart,
    });

    expect(outcome).toMatchObject({
      ok: true,
      action: 'activated',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    });
    expect(await driver.currentVersion(baseDir)).toBe('2.0.0');
    expect(restart).toHaveBeenCalledOnce();
  });

  it('never activates a deliberately broken build — it fails its verification and the node stays on the old version', async () => {
    const source = fakeSource({
      '2.0.0': {
        version: '2.0.0',
        bytes: await fixtureNodeBundle(BROKEN_BUNDLE_SCRIPT),
        signature: undefined,
      },
    });
    const restart = vi.fn();

    const outcome = await applyNodeSelfUpdate({
      baseDir,
      driver,
      source,
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      restart,
    });

    expect(outcome).toMatchObject({
      ok: false,
      action: 'verification_failed',
      fromVersion: '1.0.0',
    });
    expect(outcome.toVersion).toBeUndefined();
    // "the node stays on the old version and says so" — current was never
    // touched, and restart (the only thing that would actually affect the
    // running process) was never called: the node still runs, unaffected.
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    expect(restart).not.toHaveBeenCalled();
  });

  it('reports a fetch failure without ever staging or restarting', async () => {
    const source: NodeUpdateSource = {
      checkLatest: async () => undefined,
      fetch: async () => {
        throw new Error('network unreachable');
      },
    };
    const restart = vi.fn();

    const outcome = await applyNodeSelfUpdate({
      baseDir,
      driver,
      source,
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      restart,
    });

    expect(outcome).toMatchObject({ ok: false, action: 'fetch_failed', fromVersion: '1.0.0' });
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    expect(restart).not.toHaveBeenCalled();
  });

  it('refuses an artifact with no signature when a public key is configured — never staged live', async () => {
    const { publicKeyRaw } = generateEd25519Pair();
    const source = fakeSource({
      '2.0.0': {
        version: '2.0.0',
        bytes: await fixtureNodeBundle(goodBundleScript('2.0.0')),
        signature: undefined,
      },
    });
    const restart = vi.fn();

    const outcome = await applyNodeSelfUpdate({
      baseDir,
      driver,
      source,
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      publicKey: publicKeyRaw,
      restart,
    });

    expect(outcome).toMatchObject({ ok: false, action: 'signature_invalid', fromVersion: '1.0.0' });
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    expect(restart).not.toHaveBeenCalled();
  });

  it('accepts a correctly signed artifact when a public key is configured', async () => {
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const bytes = await fixtureNodeBundle(goodBundleScript('2.0.0'));
    const signature = new Uint8Array(cryptoSign(null, Buffer.from(bytes), privateKey));
    const source = fakeSource({ '2.0.0': { version: '2.0.0', bytes, signature } });

    const outcome = await applyNodeSelfUpdate({
      baseDir,
      driver,
      source,
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      publicKey: publicKeyRaw,
      restart: vi.fn(),
    });

    expect(outcome).toMatchObject({ ok: true, action: 'activated', toVersion: '2.0.0' });
  });

  it('rolls back to the old version when activation itself fails, and never restarts — the node still runs', async () => {
    const source = fakeSource({
      '2.0.0': {
        version: '2.0.0',
        bytes: await fixtureNodeBundle(goodBundleScript('2.0.0')),
        signature: undefined,
      },
    });
    const restart = vi.fn();
    const failingDriver: InstallLayoutDriver = {
      ...driver,
      activateVersion: async (dir, version) => {
        if (version === '2.0.0') throw new Error('disk full');
        await driver.activateVersion(dir, version);
      },
    };

    const outcome = await applyNodeSelfUpdate({
      baseDir,
      driver: failingDriver,
      source,
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      restart,
    });

    expect(outcome).toMatchObject({
      ok: false,
      action: 'activation_failed_rolled_back',
      fromVersion: '1.0.0',
    });
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    expect(restart).not.toHaveBeenCalled();
  });
});
