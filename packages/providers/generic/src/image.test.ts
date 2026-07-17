import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildImageResourceLinkContentBlock,
  sweepStaleImageTempDirs,
  writeImageTempFile,
} from './image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('writeImageTempFile', () => {
  it('writes bytes outside any project dir, under a 0700 dir with a 0600 file', async () => {
    const handle = await writeImageTempFile(PNG_BYTES);
    cleanups.push(handle.cleanup);

    expect(handle.path.startsWith(tmpdir())).toBe(true);
    expect(handle.mimeType).toBe('image/png');
    expect(path.extname(handle.path)).toBe('.png');

    const fileStat = await stat(handle.path);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = await stat(path.dirname(handle.path));
    expect(dirStat.mode & 0o777).toBe(0o700);

    const written = await readFile(handle.path);
    expect(new Uint8Array(written)).toEqual(PNG_BYTES);
  });

  it('random-names each file so two writes never collide', async () => {
    const a = await writeImageTempFile(PNG_BYTES);
    const b = await writeImageTempFile(PNG_BYTES);
    cleanups.push(a.cleanup, b.cleanup);
    expect(a.path).not.toBe(b.path);
  });

  it('falls back to application/octet-stream + .bin for an unrecognized format', async () => {
    const handle = await writeImageTempFile(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    cleanups.push(handle.cleanup);
    expect(handle.mimeType).toBe('application/octet-stream');
    expect(path.extname(handle.path)).toBe('.bin');
  });

  it('cleanup() deletes both the file and its containing temp dir', async () => {
    const handle = await writeImageTempFile(PNG_BYTES);
    const dir = path.dirname(handle.path);

    await handle.cleanup();

    await expect(stat(handle.path)).rejects.toThrow();
    await expect(stat(dir)).rejects.toThrow();
  });

  it('cleanup() is idempotent (a second call does not throw)', async () => {
    const handle = await writeImageTempFile(PNG_BYTES);
    await handle.cleanup();
    await expect(handle.cleanup()).resolves.toBeUndefined();
  });
});

describe('buildImageResourceLinkContentBlock', () => {
  it('builds a resource_link content block pointing at the temp file', async () => {
    const handle = await writeImageTempFile(PNG_BYTES);
    cleanups.push(handle.cleanup);

    const block = buildImageResourceLinkContentBlock(handle, { name: 'screenshot.png' });
    expect(block).toEqual({
      type: 'resource_link',
      uri: `file://${handle.path}`,
      mimeType: 'image/png',
      name: 'screenshot.png',
      size: undefined,
    });
  });
});

describe('sweepStaleImageTempDirs', () => {
  it('removes only matching-prefix directories older than maxAgeMs', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-sweep-test-'));
    cleanups.push(() => rm(baseDir, { recursive: true, force: true }));

    const stale = await writeImageTempFile(PNG_BYTES, { dirPrefix: 'sweep-target-' });
    const fresh = await writeImageTempFile(PNG_BYTES, { dirPrefix: 'sweep-target-' });
    cleanups.push(fresh.cleanup);

    const staleDir = path.dirname(stale.path);
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(staleDir, oldTime, oldTime);

    // Move both temp dirs' actual location under our controlled baseDir by
    // sweeping tmpdir() directly but scoping maxAgeMs so only the stale one
    // qualifies, and dirPrefix so nothing outside this test's own dirs (or
    // another concurrent test's) is touched.
    const removed = await sweepStaleImageTempDirs({
      baseDir: tmpdir(),
      dirPrefix: 'sweep-target-',
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(removed).toContain(staleDir);
    expect(removed).not.toContain(path.dirname(fresh.path));
    await expect(stat(staleDir)).rejects.toThrow();
    await expect(stat(path.dirname(fresh.path))).resolves.toBeDefined();
  });

  it('returns an empty array and does not throw when baseDir has nothing matching', async () => {
    const removed = await sweepStaleImageTempDirs({
      baseDir: tmpdir(),
      dirPrefix: 'loombox-nonexistent-prefix-xyz-',
    });
    expect(removed).toEqual([]);
  });

  it('does not throw when baseDir itself does not exist', async () => {
    const removed = await sweepStaleImageTempDirs({
      baseDir: path.join(tmpdir(), 'loombox-does-not-exist-dir'),
    });
    expect(removed).toEqual([]);
  });
});
