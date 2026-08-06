/**
 * Shared esbuild-based bundler for `@loombox/node` and `@loombox/supervisor`
 * (issue #817, decision A1-2: "one esbuild bundle per release... run by the
 * system Node"). One ESM entry point per component, with each package's own
 * native dependency (`node-pty`, `@napi-rs/keyring`) left `external` and
 * copied beside the bundle afterward — see `./copy-native-module.mjs`.
 *
 * Deliberately package-agnostic: `packages/node/scripts/bundle.mjs` and
 * `packages/supervisor/scripts/bundle.mjs` are both thin callers, so the one
 * real bundling recipe (defines, target, native-module copy) can't drift
 * between the two components.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import * as esbuild from 'esbuild';

import { copyNativeModule } from './copy-native-module.mjs';

const execFileAsync = promisify(execFile);

/**
 * Best-effort `git rev-parse HEAD` against `cwd`, used only as a local-dev
 * convenience when `LOOMBOX_BUILD_COMMIT` isn't already set (mirrors
 * `scripts/deploy-prod.sh`'s own `export LOOMBOX_BUILD_COMMIT="$SHA"`
 * convention for the real release path). Never throws — a bundle built
 * outside a git checkout still bundles, just without a baked-in commit.
 */
async function resolveBuildCommit(cwd) {
  const fromEnv = process.env.LOOMBOX_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {object} options
 * @param {string} options.pkgDir - absolute path to the package directory (contains package.json)
 * @param {string} options.entry - entry file, relative to pkgDir (e.g. "src/main.ts")
 * @param {string} options.outfile - bundle output file, relative to pkgDir (e.g. "dist/node.mjs")
 * @param {string[]} options.external - package specifiers esbuild must not bundle
 * @param {(string | {name: string, fromDir: string})[]} [options.nativeModules] - subset of `external` to physically copy beside the bundle (their prebuilt binaries); each entry may override which package directory's dependency resolution to follow (e.g. a native dep declared by a workspace dependency rather than this package directly) — defaults to `external`, resolved from `pkgDir`
 * @param {boolean} [options.bakeBuildCommit] - substitute `process.env.LOOMBOX_BUILD_COMMIT` with a literal at bundle time (issue #655's "no git checkout present" case)
 */
export async function bundlePackage(options) {
  const {
    pkgDir,
    entry,
    outfile,
    external,
    nativeModules = external,
    bakeBuildCommit = false,
  } = options;

  const pkgJsonRaw = await readFile(path.join(pkgDir, 'package.json'), 'utf8');
  const pkgJson = JSON.parse(pkgJsonRaw);

  const outfileAbs = path.join(pkgDir, outfile);
  const outDir = path.dirname(outfileAbs);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  /** @type {Record<string, string>} */
  const define = {};
  let bakedCommit;
  if (bakeBuildCommit) {
    bakedCommit = await resolveBuildCommit(pkgDir);
    if (bakedCommit) {
      define['process.env.LOOMBOX_BUILD_COMMIT'] = JSON.stringify(bakedCommit);
    }
  }

  const result = await esbuild.build({
    absWorkingDir: pkgDir,
    entryPoints: [entry],
    outfile: outfileAbs,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // A future artifact-source verification failure should be loud, not a
    // silently truncated stack — keep names/whitespace close to source.
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    external,
    define,
    metafile: true,
  });

  // Trimmed package.json, co-located with the bundle: `build-identity.ts`'s
  // `readOwnVersion()` looks for `package.json` next to its own module
  // first (issue #817 — the bundled layout is flat, `<version>/node.mjs`,
  // not `<version>/src/build-identity.mjs`, so the dev-checkout convention
  // of "one directory up" would resolve outside the versioned install dir
  // entirely).
  await writeFile(
    path.join(outDir, 'package.json'),
    JSON.stringify({ name: pkgJson.name, version: pkgJson.version, type: 'module' }, null, 2) +
      '\n',
  );

  for (const nativeModule of nativeModules) {
    const { name: moduleName, fromDir: moduleFromDir = pkgDir } =
      typeof nativeModule === 'string' ? { name: nativeModule } : nativeModule;
    await copyNativeModule({
      moduleName,
      fromDir: path.resolve(pkgDir, moduleFromDir),
      toNodeModules: path.join(outDir, 'node_modules'),
    });
  }

  return {
    outfile: outfileAbs,
    outDir,
    version: pkgJson.version,
    bakedCommit,
    metafile: result.metafile,
  };
}
