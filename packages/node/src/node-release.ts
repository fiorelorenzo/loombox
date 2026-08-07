import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RemoteOsArch } from './ssh/remote-runtime';

/**
 * The bundled `@loombox/node` entry file's bare name inside a staged
 * version directory (decision A1-2) — `scripts/package-node-release.mjs`'s
 * `packageNode()` bundles `src/main.ts` to exactly this name
 * (`bundlePackage({ outfile: 'dist/node.mjs' })`, which lands at the
 * archive's own root once `install-layout.ts`'s `stageVersion` extracts
 * it), so `~/.loombox/versions/<version>/node.mjs` is what a backend's
 * `ProgramArguments`/`ExecStart` actually runs, via `current/node.mjs`.
 * Exported so `./supervisor-backend.ts`'s implementations never hardcode
 * this string in more than one place.
 */
export const NODE_BUNDLE_ENTRY_FILE = 'node.mjs';

/**
 * Where a fetched node-release archive's bytes come from, for a given
 * remote/local OS+arch and version — the `./supervisor-backend.ts`
 * counterpart to `./ssh/supervisor-artifact.ts`'s `SupervisorArtifactSource`
 * (that one fetches `@loombox/supervisor`'s own bundle, staged under
 * `$HOME/.loombox/supervisor/supervisor-bin` by the older,
 * still-unchanged `./ssh/supervisor-provisioning.ts` mechanism; this one
 * fetches `@loombox/node`'s own bundle, staged under `~/.loombox/versions/
 * <version>/` by `./install-layout.ts` — two different packages, two
 * different staging directories, deliberately not unified into one
 * artifact type).
 */
export interface NodeReleaseSource {
  /** Resolves to the gzipped-tar bytes `InstallLayoutDriver.stageVersion` extracts — `node.mjs`, its trimmed `package.json`, `node_modules/{node-pty,@napi-rs/keyring}` (`scripts/package-node-release.mjs`'s own output shape). Rejects with a clear error when nothing is staged for the requested os/arch/version — never silently falls back to a different platform's build. */
  fetch(osArch: RemoteOsArch, version: string): Promise<Uint8Array>;
}

export interface LocalFsNodeReleaseSourceOptions {
  /** Directory containing one `node/<version>/node-<version>-<os>-<arch>.tar.gz` per released build — `scripts/package-node-release.mjs`'s own `release/` output layout, or a deployed mirror of it (e.g. `~/.loombox/releases`, matching `./ssh/local-fs-artifact-source.ts`'s own default root for the sibling supervisor artifact). */
  releasesDir: string;
}

/**
 * A real, working {@link NodeReleaseSource} backed by a local directory
 * tree — exactly what `scripts/package-node-release.mjs` populates
 * locally, and what a future GitHub-Releases-backed source would land its
 * downloads into anyway (mirrors `./ssh/local-fs-artifact-source.ts`'s own
 * honest-scope doc comment: a network fetch is a follow-up, this is what
 * actually satisfies the interface today).
 */
export function createLocalFsNodeReleaseSource(
  options: LocalFsNodeReleaseSourceOptions,
): NodeReleaseSource {
  return {
    async fetch(osArch, version) {
      const filePath = path.join(
        options.releasesDir,
        'node',
        version,
        `node-${version}-${osArch.os}-${osArch.arch}.tar.gz`,
      );
      try {
        return await readFile(filePath);
      } catch (error) {
        throw new Error(
          `local-fs node-release source: no node build staged for ${osArch.os}/${osArch.arch} ` +
            `version ${version} at ${filePath}`,
          { cause: error },
        );
      }
    },
  };
}
