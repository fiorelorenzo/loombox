import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetNpmCacheDirCacheForTests, resolveNpmCacheDir } from './npm-cache';

describe('resolveNpmCacheDir', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'loombox-npm-cache-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('NPM_CONFIG_CACHE wins outright — the exact same var real npm honors first — and never even reaches PATH/npm probing', () => {
    const dir = resolveNpmCacheDir({
      env: { NPM_CONFIG_CACHE: path.join(home, 'explicit-cache') },
      pathEnv: '',
      homeDir: home,
      probe: () => {
        throw new Error('must not be called when NPM_CONFIG_CACHE is set');
      },
    });
    expect(dir).toBe(path.join(home, 'explicit-cache'));
    expect(existsSync(dir!)).toBe(true);
  });

  it('falls back to a real `npm config get cache`-shaped probe when NPM_CONFIG_CACHE is unset', async () => {
    const npmBinDir = await mkdtemp(path.join(tmpdir(), 'loombox-npm-cache-bin-'));
    try {
      await writeFile(path.join(npmBinDir, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const probed = path.join(home, 'npm-reported-cache');
      const dir = resolveNpmCacheDir({
        env: {},
        pathEnv: npmBinDir,
        homeDir: home,
        probe: (npmPath) => {
          expect(npmPath).toBe(path.join(npmBinDir, 'npm'));
          return probed;
        },
      });
      expect(dir).toBe(probed);
      expect(existsSync(dir!)).toBe(true);
    } finally {
      await rm(npmBinDir, { recursive: true, force: true });
    }
  });

  it('falls back to $HOME/.npm when npm is not on PATH at all', () => {
    const dir = resolveNpmCacheDir({ env: {}, pathEnv: '', homeDir: home });
    expect(dir).toBe(path.join(home, '.npm'));
    expect(existsSync(dir!)).toBe(true);
  });

  it('falls back to $HOME/.npm when the probe itself fails to resolve anything', () => {
    const dir = resolveNpmCacheDir({
      env: {},
      pathEnv: '',
      homeDir: home,
      probe: () => undefined,
    });
    expect(dir).toBe(path.join(home, '.npm'));
  });

  it('refuses (returns undefined) a NPM_CONFIG_CACHE pointed at the filesystem root — the #257-shaped "computed /, would bind the whole host" class of bug, one severity worse here since this mount is read-write', () => {
    const dir = resolveNpmCacheDir({ env: { NPM_CONFIG_CACHE: '/' }, pathEnv: '', homeDir: home });
    expect(dir).toBeUndefined();
  });

  it('refuses a NPM_CONFIG_CACHE pointed at the account home directory itself', () => {
    const dir = resolveNpmCacheDir({ env: { NPM_CONFIG_CACHE: home }, pathEnv: '', homeDir: home });
    expect(dir).toBeUndefined();
  });

  it('refuses a NPM_CONFIG_CACHE pointed at an ANCESTOR of the home directory (mounting it would still expose all of $HOME)', () => {
    const dir = resolveNpmCacheDir({
      env: { NPM_CONFIG_CACHE: path.dirname(home) },
      pathEnv: '',
      homeDir: home,
    });
    expect(dir).toBeUndefined();
  });

  it('a plausible cache dir that merely happens to live under $HOME is fine — only the home directory or a broader ancestor is refused', () => {
    const dir = resolveNpmCacheDir({
      env: { NPM_CONFIG_CACHE: path.join(home, '.npm') },
      pathEnv: '',
      homeDir: home,
    });
    expect(dir).toBe(path.join(home, '.npm'));
  });

  it('creates the resolved directory on disk when it does not exist yet, mirroring what a real first npx invocation would', () => {
    const target = path.join(home, 'not-yet-created', 'npm-cache');
    expect(existsSync(target)).toBe(false);
    const dir = resolveNpmCacheDir({
      env: { NPM_CONFIG_CACHE: target },
      pathEnv: '',
      homeDir: home,
    });
    expect(dir).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('caches the resolved value across calls with no override, so a real npm spawn only ever happens once per process — reset for tests via resetNpmCacheDirCacheForTests', () => {
    resetNpmCacheDirCacheForTests();
    const originalEnv = process.env.NPM_CONFIG_CACHE;
    const originalPath = process.env.PATH;
    process.env.NPM_CONFIG_CACHE = path.join(home, 'default-path-cache');
    process.env.PATH = '';
    try {
      const first = resolveNpmCacheDir();
      const second = resolveNpmCacheDir();
      expect(first).toBe(path.join(home, 'default-path-cache'));
      expect(second).toBe(first);
    } finally {
      if (originalEnv === undefined) delete process.env.NPM_CONFIG_CACHE;
      else process.env.NPM_CONFIG_CACHE = originalEnv;
      process.env.PATH = originalPath;
      resetNpmCacheDirCacheForTests();
    }
  });
});
