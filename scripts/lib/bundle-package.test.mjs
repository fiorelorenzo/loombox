import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { bundlePackage } from './bundle-package.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const nodePkgDir = path.join(repoRoot, 'packages', 'node');

/**
 * Real end-to-end coverage for issue #817's whole point (decision A1-2):
 * builds the actual `@loombox/node` bundle with esbuild, copies its output
 * to a directory with no relationship to this monorepo, and runs it there
 * with a stripped-down `PATH`-only env — the exact acceptance this issue is
 * graded on ("starts from a directory with no monorepo and no
 * `node_modules`, using only the system Node" / "with no git checkout
 * present, the node reports version and commit").
 *
 * Deliberately bundles the real package rather than a synthetic fixture:
 * a synthetic one would never have caught either regression this test
 * actually reproduced while writing it — esbuild's own CJS-interop shim
 * throwing on `ssh2`'s `require('net')`/`__dirname` in `format: 'esm'`
 * output (fixed via `bundlePackage`'s `banner`), and `build-identity.ts`'s
 * `readOwnVersion()` resolving `package.json` one directory up from a
 * bundle that has no directory structure to go "up" from (fixed by trying
 * the co-located `package.json` first).
 */
describe('bundlePackage (issue #817, decision A1-2)', () => {
  it('runs standalone with only the system Node and reports a baked commit with no git checkout', async () => {
    const bakedCommit = 'test-baked-commit-0123456789ab';
    const ownVersion = JSON.parse(
      await readFile(path.join(nodePkgDir, 'package.json'), 'utf8'),
    ).version;

    const previousEnvValue = process.env.LOOMBOX_BUILD_COMMIT;
    process.env.LOOMBOX_BUILD_COMMIT = bakedCommit;
    let result;
    try {
      result = await bundlePackage({
        pkgDir: nodePkgDir,
        entry: 'src/main.ts',
        outfile: 'dist/bundle-package.test-output.mjs',
        external: ['node-pty', '@napi-rs/keyring', 'cpu-features', 'nan'],
        nativeModules: [{ name: 'node-pty', fromDir: '../supervisor' }, '@napi-rs/keyring'],
        bakeBuildCommit: true,
      });
    } finally {
      if (previousEnvValue === undefined) delete process.env.LOOMBOX_BUILD_COMMIT;
      else process.env.LOOMBOX_BUILD_COMMIT = previousEnvValue;
    }

    // The bake itself: a literal, not a runtime env lookup that just
    // happens to also be set right now.
    expect(result.bakedCommit).toBe(bakedCommit);

    const standaloneDir = await mkdtemp(path.join(tmpdir(), 'loombox-bundle-smoke-'));
    try {
      await cp(result.outDir, standaloneDir, { recursive: true });
      const bundlePath = path.join(standaloneDir, path.basename(result.outfile));

      // No LOOMBOX_BUILD_COMMIT, no monorepo, no .git anywhere above this
      // tmpdir that this process would ever consult (git itself would
      // walk up past /tmp and might find an ambient repo on some
      // machines — the whole point of asserting on the printed value,
      // not just "it didn't crash", is that a stray git fallback would
      // print a *different*, wrong commit rather than silently pass).
      const { stdout } = await execFileAsync(process.execPath, [bundlePath, '--version'], {
        cwd: standaloneDir,
        env: { PATH: process.env.PATH ?? '' },
      });

      expect(JSON.parse(stdout)).toEqual({ version: ownVersion, commit: bakedCommit });
    } finally {
      await rm(standaloneDir, { recursive: true, force: true });
    }
  }, 60_000);
});
