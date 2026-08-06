/**
 * Copies one native npm dependency (`node-pty`, `@napi-rs/keyring`) into a
 * bundle's own `node_modules/`, dereferencing pnpm's symlinked store so the
 * result is real files a bare `node <bundle>` can resolve from a directory
 * with no monorepo and no pnpm (issue #817's acceptance: "a directory with
 * no monorepo and no node_modules" refers to the AMBIENT system the bundle
 * is copied into — the bundle's own `node_modules/` for these two packages
 * is exactly what makes that possible).
 *
 * Deliberately generic, not `node-pty`/`keyring`-specific: any napi-rs-style
 * package that ships a dispatcher plus per-platform `optionalDependencies`
 * (`@napi-rs/keyring-linux-x64-gnu`, ...) gets its dispatcher copied PLUS
 * whichever single platform variant this host's pnpm install actually
 * resolved — never every variant, since only one is ever installed for a
 * given host (pnpm's own os/cpu-filtered install), and copying only what's
 * really there is what makes each platform's release artifact the right
 * size for that platform.
 *
 * Runtime-only, not `files`-field verbatim: `node-pty`'s own npm `files`
 * list (`prebuilds/`, `deps/`, `src/`, `third_party/`, ...) is sized for a
 * fresh `npm install` that still has to pick/build a binary — 58MB of it is
 * OTHER platforms' prebuilds. This host already resolved (or compiled) its
 * own binary during THIS workspace's `pnpm install`; only that binary plus
 * the compiled JS entry point are copied.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Resolves `<moduleName>/package.json` starting from `fromPackageJson`'s own require graph, returning that package's real (symlink-resolved) directory, or `undefined` if it isn't installed there at all (e.g. an optional native variant this host doesn't match). */
function resolvePackageDir(moduleName, fromPackageJson) {
  const require = createRequire(fromPackageJson);
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${moduleName}/package.json`);
  } catch {
    return undefined;
  }
  return path.dirname(pkgJsonPath);
}

async function existsDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function copyFileInto(srcFile, destDir) {
  await mkdir(destDir, { recursive: true });
  // `-L` dereferences pnpm's store symlinks into real files, `-a` preserves
  // the (small) executable-bit-matters-for-.node-loading permissions.
  await execFileAsync('cp', ['-a', '-L', srcFile, destDir]);
}

/** Copies `srcDir`'s CONTENTS into `destDir` (creating it), not `srcDir` itself as a nested subdirectory — `cp -a srcDir destDir` when `destDir` already exists copies `srcDir` INTO it instead of merging, which is never what a "make this native module's own tree look the same, minus the parts we trimmed" copy wants. */
async function copyDirInto(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  await execFileAsync('cp', ['-a', '-L', `${srcDir}/.`, destDir]);
}

/**
 * Copies just what a package needs to `require`/`import` at runtime:
 * `package.json`, its top-level `lib/` (node-pty's compiled JS) if present,
 * every top-level `.js`/`.mjs`/`.cjs`/`.d.ts`/`.node` file (covers the
 * flat napi-rs dispatcher/platform-variant shape), and the ONE native
 * binary directory this host actually has (`build/Release`, `build/Debug`,
 * or `prebuilds/<platform>-<arch>`) — never the other platforms' prebuilds
 * that shipped in the same npm tarball.
 */
async function copyRuntimeFiles(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });

  await copyFileInto(path.join(srcDir, 'package.json'), destDir);

  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /\.(m?js|cjs|d\.ts|node)$/.test(entry.name)) {
      await copyFileInto(path.join(srcDir, entry.name), destDir);
    }
  }

  const libDir = path.join(srcDir, 'lib');
  if (await existsDir(libDir)) {
    await copyDirInto(libDir, path.join(destDir, 'lib'));
  }

  const buildRelease = path.join(srcDir, 'build', 'Release');
  const buildDebug = path.join(srcDir, 'build', 'Debug');
  const prebuildDir = path.join(srcDir, 'prebuilds', `${process.platform}-${process.arch}`);
  if (await existsDir(buildRelease)) {
    await copyDirInto(buildRelease, path.join(destDir, 'build', 'Release'));
  } else if (await existsDir(buildDebug)) {
    await copyDirInto(buildDebug, path.join(destDir, 'build', 'Debug'));
  } else if (await existsDir(prebuildDir)) {
    await copyDirInto(
      prebuildDir,
      path.join(destDir, 'prebuilds', `${process.platform}-${process.arch}`),
    );
  }
}

/**
 * @param {object} options
 * @param {string} options.moduleName - the external specifier the bundle imports (e.g. "node-pty", "@napi-rs/keyring")
 * @param {string} options.fromDir - the package directory whose own dependency resolution to follow (e.g. packages/node)
 * @param {string} options.toNodeModules - the bundle's own node_modules/ destination
 */
export async function copyNativeModule({ moduleName, fromDir, toNodeModules }) {
  const fromPackageJson = path.join(fromDir, 'package.json');
  const srcDir = resolvePackageDir(moduleName, fromPackageJson);
  if (!srcDir) {
    throw new Error(
      `copyNativeModule: "${moduleName}" is not resolvable from ${fromDir} — is it installed for this host?`,
    );
  }

  const destDir = path.join(toNodeModules, ...moduleName.split('/'));
  await rm(destDir, { recursive: true, force: true });
  await copyRuntimeFiles(srcDir, destDir);

  // If this package ships per-platform optionalDependencies (the napi-rs
  // dispatcher pattern), those variants live nested under the DISPATCHER's
  // own node_modules in pnpm's isolated layout, not the original caller's —
  // resolve from `srcDir`'s package.json, not `fromPackageJson`, or every
  // lookup below fails even on a host that has the matching variant
  // installed.
  const dispatcherPackageJson = path.join(srcDir, 'package.json');
  const pkgJson = JSON.parse(await readFile(dispatcherPackageJson, 'utf8'));
  const optionalNames = Object.keys(pkgJson.optionalDependencies ?? {});
  for (const optionalName of optionalNames) {
    const optionalSrcDir = resolvePackageDir(optionalName, dispatcherPackageJson);
    if (!optionalSrcDir) continue; // not installed for this host — expected for every non-matching platform
    const optionalDestDir = path.join(toNodeModules, ...optionalName.split('/'));
    await rm(optionalDestDir, { recursive: true, force: true });
    await copyRuntimeFiles(optionalSrcDir, optionalDestDir);
  }
}
