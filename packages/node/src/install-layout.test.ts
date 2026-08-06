import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeTransport } from './ssh/fake-transport';
import { LocalProcessTransport } from './ssh/local-process-transport';

import {
  createLocalInstallLayoutDriver,
  createRemoteInstallLayoutDriver,
  createTarGzArchive,
  rollbackVersion,
} from './install-layout';

/** Builds a tiny fixture tar.gz whose one file (`marker.txt`) contains `content` — enough to prove staging/extraction/activation actually moved real bytes, without needing a real bundle. */
async function fixtureArchive(content: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'loombox-install-layout-fixture-'));
  try {
    await writeFile(path.join(sourceDir, 'marker.txt'), content);
    return await createTarGzArchive(sourceDir);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

describe('createLocalInstallLayoutDriver (issue #817, decision A1-2)', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-install-layout-local-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('has no current version on a fresh baseDir', async () => {
    const driver = createLocalInstallLayoutDriver();
    expect(await driver.currentVersion(baseDir)).toBeUndefined();
    expect(await driver.listStagedVersions(baseDir)).toEqual([]);
  });

  it('unpacks a second version beside the first, flips current, and runs the new one — then flips back to the old one', async () => {
    const driver = createLocalInstallLayoutDriver();

    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('v1'));
    await driver.activateVersion(baseDir, '1.0.0');
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    await expect(readFile(path.join(baseDir, 'current', 'marker.txt'), 'utf8')).resolves.toBe('v1');

    // Stage v2 while v1 is live: both directories coexist under versions/.
    await driver.stageVersion(baseDir, '2.0.0', await fixtureArchive('v2'));
    expect(await driver.listStagedVersions(baseDir).then((v) => v.sort())).toEqual([
      '1.0.0',
      '2.0.0',
    ]);
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0'); // staging alone never flips current

    await driver.activateVersion(baseDir, '2.0.0');
    expect(await driver.currentVersion(baseDir)).toBe('2.0.0');
    await expect(readFile(path.join(baseDir, 'current', 'marker.txt'), 'utf8')).resolves.toBe('v2'); // "restart, show it running the new one"

    await rollbackVersion(driver, baseDir, '1.0.0');
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    await expect(readFile(path.join(baseDir, 'current', 'marker.txt'), 'utf8')).resolves.toBe('v1'); // "flip back, show the old one"
  });

  it('refuses to activate a version that was never staged', async () => {
    const driver = createLocalInstallLayoutDriver();
    await expect(driver.activateVersion(baseDir, '9.9.9')).rejects.toThrow(/not staged/);
  });

  it('refuses to remove the currently active version', async () => {
    const driver = createLocalInstallLayoutDriver();
    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('v1'));
    await driver.activateVersion(baseDir, '1.0.0');

    await expect(driver.removeVersion(baseDir, '1.0.0')).rejects.toThrow(/current/);
    expect(await driver.listStagedVersions(baseDir)).toEqual(['1.0.0']);
  });

  it('removes an old, inactive staged version', async () => {
    const driver = createLocalInstallLayoutDriver();
    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('v1'));
    await driver.stageVersion(baseDir, '2.0.0', await fixtureArchive('v2'));
    await driver.activateVersion(baseDir, '2.0.0');

    await driver.removeVersion(baseDir, '1.0.0');
    expect(await driver.listStagedVersions(baseDir)).toEqual(['2.0.0']);
  });

  it('re-staging the same version replaces a partial previous attempt', async () => {
    const driver = createLocalInstallLayoutDriver();
    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('first-attempt'));
    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('second-attempt'));
    await driver.activateVersion(baseDir, '1.0.0');

    await expect(readFile(path.join(baseDir, 'current', 'marker.txt'), 'utf8')).resolves.toBe(
      'second-attempt',
    );
  });

  it('the current symlink target is relative, not baked to this run\u2019s absolute baseDir', async () => {
    const driver = createLocalInstallLayoutDriver();
    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('v1'));
    await driver.activateVersion(baseDir, '1.0.0');

    const target = await readlink(path.join(baseDir, 'current'));
    expect(path.isAbsolute(target)).toBe(false);
    expect(target).toBe(path.join('versions', '1.0.0'));
  });
});

describe('createRemoteInstallLayoutDriver against a real "remote" (LocalProcessTransport, issue #817)', () => {
  let baseDir: string;
  let transport: LocalProcessTransport;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-install-layout-remote-'));
    transport = new LocalProcessTransport();
    await transport.connect();
  });

  afterEach(async () => {
    await transport.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('stages, activates, and flips versions on a real remote shell exactly like the local driver does on this machine', async () => {
    const driver = createRemoteInstallLayoutDriver(transport);

    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('v1'));
    await driver.activateVersion(baseDir, '1.0.0');
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');

    await driver.stageVersion(baseDir, '2.0.0', await fixtureArchive('v2'));
    await driver.activateVersion(baseDir, '2.0.0');
    expect(await driver.currentVersion(baseDir)).toBe('2.0.0');
    await expect(readFile(path.join(baseDir, 'current', 'marker.txt'), 'utf8')).resolves.toBe('v2');

    await rollbackVersion(driver, baseDir, '1.0.0');
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    await expect(readFile(path.join(baseDir, 'current', 'marker.txt'), 'utf8')).resolves.toBe('v1');
  });

  it('refuses to activate an unstaged version without touching current', async () => {
    const driver = createRemoteInstallLayoutDriver(transport);
    await expect(driver.activateVersion(baseDir, '9.9.9')).rejects.toThrow(/not staged/);
    expect(await driver.currentVersion(baseDir)).toBeUndefined();
  });

  it('refuses to remove the currently active version', async () => {
    const driver = createRemoteInstallLayoutDriver(transport);
    await driver.stageVersion(baseDir, '1.0.0', await fixtureArchive('v1'));
    await driver.activateVersion(baseDir, '1.0.0');

    await expect(driver.removeVersion(baseDir, '1.0.0')).rejects.toThrow(/current/);
  });
});

describe('createRemoteInstallLayoutDriver against FakeTransport (pure command-sequence assertions)', () => {
  it('activateVersion runs a portable `ln -sfn` flip, mirroring scripts/deploy-prod.sh', async () => {
    const calls: string[] = [];
    const transport = new FakeTransport({
      onExec: (command) => {
        calls.push(command);
        if (command.startsWith('test -d')) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();
    const driver = createRemoteInstallLayoutDriver(transport);

    await driver.activateVersion('/home/user/.loombox', '1.2.3');

    const linkCall = calls.find((c) => c.startsWith('ln -sfn'));
    expect(linkCall).toBe("ln -sfn 'versions/1.2.3' '/home/user/.loombox/current'");
  });

  it('propagates a non-zero exec exit as a real failure', async () => {
    const transport = new FakeTransport({
      onExec: () => ({ stdout: '', stderr: 'disk full', exitCode: 1 }),
    });
    await transport.connect();
    const driver = createRemoteInstallLayoutDriver(transport);

    await expect(
      driver.stageVersion('/home/user/.loombox', '1.0.0', new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(/disk full/);
  });
});
