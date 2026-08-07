import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalFsNodeReleaseSource, NODE_BUNDLE_ENTRY_FILE } from './node-release';
import type { RemoteOsArch } from './ssh/remote-runtime';

const LINUX_X64: RemoteOsArch = { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' };
const DARWIN_ARM64: RemoteOsArch = {
  os: 'darwin',
  arch: 'arm64',
  rawOs: 'Darwin',
  rawArch: 'arm64',
};

describe('NODE_BUNDLE_ENTRY_FILE', () => {
  it('is the bare bundle filename scripts/package-node-release.mjs actually produces', () => {
    expect(NODE_BUNDLE_ENTRY_FILE).toBe('node.mjs');
  });
});

describe('createLocalFsNodeReleaseSource (issue #654)', () => {
  let releasesDir: string;

  beforeEach(async () => {
    releasesDir = await mkdtemp(path.join(tmpdir(), 'loombox-local-fs-node-release-'));
  });

  afterEach(async () => {
    await rm(releasesDir, { recursive: true, force: true });
  });

  it('reads the staged tar.gz for the requested version/os/arch', async () => {
    const dir = path.join(releasesDir, 'node', '1.2.3');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'node-1.2.3-linux-x64.tar.gz'), 'fake-tarball-bytes');

    const source = createLocalFsNodeReleaseSource({ releasesDir });
    const bytes = await source.fetch(LINUX_X64, '1.2.3');

    expect(Buffer.from(bytes).toString('utf8')).toBe('fake-tarball-bytes');
  });

  it('never conflates one os/arch\u2019s build with another\u2019s', async () => {
    const linuxDir = path.join(releasesDir, 'node', '1.0.0');
    await mkdir(linuxDir, { recursive: true });
    await writeFile(path.join(linuxDir, 'node-1.0.0-linux-x64.tar.gz'), 'linux-build');

    const source = createLocalFsNodeReleaseSource({ releasesDir });
    await expect(source.fetch(DARWIN_ARM64, '1.0.0')).rejects.toThrow(/no node build staged/);
  });

  it('rejects with a clear error when nothing is staged for the requested version', async () => {
    const source = createLocalFsNodeReleaseSource({ releasesDir });
    await expect(source.fetch(LINUX_X64, '9.9.9')).rejects.toThrow(/no node build staged/);
  });
});
