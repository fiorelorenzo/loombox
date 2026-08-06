#!/usr/bin/env node
/**
 * `pnpm package:node-release` (issue #817, decision A1-2): builds this
 * host's node + supervisor bundles and packages them into the two release
 * shapes the rest of this issue's work consumes —
 *
 *   1. `release/node/<version>/node-<version>-<os>-<arch>.tar.gz` — a
 *      gzipped tar of `@loombox/node`'s bundle output (`node.mjs`, its
 *      trimmed `package.json`, `node_modules/{node-pty,@napi-rs/keyring}`),
 *      ready for `install-layout.ts`'s `stageVersion` to unpack straight
 *      into `~/.loombox/versions/<version>/`.
 *   2. `release/supervisor/<version>/<os>-<arch>/supervisor-bin[.sig]` — a
 *      gzipped tar of `@loombox/supervisor`'s standalone bundle output
 *      (`dist/index.mjs` + `node_modules/node-pty`), the exact layout
 *      `createLocalFsSupervisorArtifactSource` reads and
 *      `verifySupervisorArtifact` checks — Ed25519-signed when
 *      `SUPERVISOR_SIGNING_KEY` (PKCS8 DER, base64 —
 *      `scripts/generate-supervisor-signing-key.mjs`'s own output shape) is
 *      set in the environment, left unsigned (no `.sig` file) otherwise, so
 *      a local/dev run without the secret still produces something usable
 *      for `createLocalFsSupervisorArtifactSource`-backed manual testing.
 *
 * `LOOMBOX_BUILD_COMMIT`, when set (`.github/workflows/release-node.yml`
 * sets it to the tagged commit), gets baked into the node bundle exactly
 * like `bundle.mjs`'s own `bakeBuildCommit` option — no separate step here.
 *
 * One host, one `<os>-<arch>` pair: this script builds only for the
 * platform it's actually running on (native modules resolve per-host, same
 * constraint `copy-native-module.mjs` documents) — the release workflow
 * runs it once per matrix leg (linux-x64, darwin-arm64 — the two
 * `RemoteOsArch` values this codebase recognizes today) and uploads every
 * leg's output as one release.
 */
import { execFile } from 'node:child_process';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { bundlePackage } from './lib/bundle-package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const releaseDir = path.join(repoRoot, 'release');

async function createTarGz(sourceDir) {
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('tar', ['czf', '-', '-C', sourceDir, '.'], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  });
  return stdout;
}

function hostOsArch() {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined;
  if (!os || !arch) {
    throw new Error(
      `package-node-release: unsupported host platform ${process.platform}/${process.arch} ` +
        '(this codebase\u2019s RemoteOsArch only recognizes linux/darwin, x64/arm64)',
    );
  }
  return { os, arch };
}

async function packageNode(version) {
  const pkgDir = path.join(repoRoot, 'packages', 'node');
  const result = await bundlePackage({
    pkgDir,
    entry: 'src/main.ts',
    outfile: 'dist/node.mjs',
    external: ['node-pty', '@napi-rs/keyring', 'cpu-features', 'nan'],
    nativeModules: [{ name: 'node-pty', fromDir: '../supervisor' }, '@napi-rs/keyring'],
    bakeBuildCommit: true,
  });

  const { os, arch } = hostOsArch();
  const outDir = path.join(releaseDir, 'node', version);
  await mkdir(outDir, { recursive: true });
  const tarball = await createTarGz(result.outDir);
  const tarballPath = path.join(outDir, `node-${version}-${os}-${arch}.tar.gz`);
  await writeFile(tarballPath, tarball);

  console.log(
    `packaged @loombox/node ${version} (${os}-${arch}${result.bakedCommit ? `, commit ${result.bakedCommit}` : ''}) -> ${path.relative(repoRoot, tarballPath)}`,
  );
  return tarballPath;
}

async function packageSupervisor(version) {
  const pkgDir = path.join(repoRoot, 'packages', 'supervisor');
  const result = await bundlePackage({
    pkgDir,
    entry: 'src/index.ts',
    outfile: 'dist/index.mjs',
    external: ['node-pty'],
  });

  const { os, arch } = hostOsArch();
  const outDir = path.join(releaseDir, 'supervisor', version, `${os}-${arch}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const tarball = await createTarGz(result.outDir);
  const artifactPath = path.join(outDir, 'supervisor-bin');
  await writeFile(artifactPath, tarball);

  const signingKeyB64 = process.env.SUPERVISOR_SIGNING_KEY?.trim();
  if (signingKeyB64) {
    const privateKey = createPrivateKey({
      key: Buffer.from(signingKeyB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = cryptoSign(null, tarball, privateKey);
    await writeFile(`${artifactPath}.sig`, signature);
    console.log(
      `packaged @loombox/supervisor ${version} (${os}-${arch}), signed -> ${path.relative(repoRoot, artifactPath)}`,
    );
  } else {
    console.log(
      `packaged @loombox/supervisor ${version} (${os}-${arch}), UNSIGNED (no SUPERVISOR_SIGNING_KEY set) -> ${path.relative(repoRoot, artifactPath)}`,
    );
  }
  return artifactPath;
}

async function readVersion(pkgDir) {
  const raw = await readFile(path.join(pkgDir, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`package-node-release: ${pkgDir}/package.json has no valid "version" field`);
  }
  return parsed.version;
}

const nodeVersion = await readVersion(path.join(repoRoot, 'packages', 'node'));
const supervisorVersion = await readVersion(path.join(repoRoot, 'packages', 'supervisor'));

await mkdir(releaseDir, { recursive: true });
await packageNode(nodeVersion);
await packageSupervisor(supervisorVersion);
