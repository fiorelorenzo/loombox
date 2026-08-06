import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RemoteOsArch } from './remote-runtime';
import type { SupervisorArtifactSource } from './supervisor-artifact';

/**
 * A real, working {@link SupervisorArtifactSource} backed by a local
 * directory tree instead of a network fetch (issue #817's honest scope: a
 * GitHub Releases fetch — SPEC §16's actual target, "distributed via GitHub
 * Releases with published checksums" — is out of reach from this pass, so
 * this is what actually satisfies the interface today, not a stub that
 * pretends to). Genuinely useful beyond "unblock the interface", too: it's
 * exactly what `scripts/package-node-release.mjs` populates locally before
 * upload, and what a future `--offline`/self-hosted-relay install (SPEC
 * §11's permanent self-hosting guarantee) would read a pre-downloaded cache
 * from — the same shape a real GitHub-Releases-backed source would need to
 * land its downloads into anyway.
 *
 * Layout: `<releasesDir>/<version>/<os>-<arch>/supervisor-bin` (the payload)
 * plus an optional sibling `supervisor-bin.sig` (the detached Ed25519
 * signature, SPEC §16's "minisign"-style pinned key). A version/os/arch this
 * source has nothing staged for is a real "not found" — this never invents
 * or falls back to a different platform's build.
 */
export interface LocalFsSupervisorArtifactSourceOptions {
  /** Directory containing one `<version>/<os>-<arch>/` subtree per released build. */
  releasesDir: string;
}

const ARTIFACT_FILE_NAME = 'supervisor-bin';
const SIGNATURE_SUFFIX = '.sig';

function artifactDir(releasesDir: string, version: string, osArch: RemoteOsArch): string {
  return path.join(releasesDir, version, `${osArch.os}-${osArch.arch}`);
}

export function createLocalFsSupervisorArtifactSource(
  options: LocalFsSupervisorArtifactSourceOptions,
): SupervisorArtifactSource {
  return {
    async fetch(osArch, version) {
      const dir = artifactDir(options.releasesDir, version, osArch);
      const artifactPath = path.join(dir, ARTIFACT_FILE_NAME);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(artifactPath);
      } catch (error) {
        throw new Error(
          `local-fs artifact source: no supervisor build staged for ${osArch.os}/${osArch.arch} ` +
            `version ${version} at ${artifactPath}`,
          { cause: error },
        );
      }

      let signature: Uint8Array | undefined;
      try {
        signature = await readFile(`${artifactPath}${SIGNATURE_SUFFIX}`);
      } catch {
        // No detached signature staged — `verifySupervisorArtifact` treats
        // `undefined` exactly like an invalid one (refused, never trusted),
        // so this is never a silent downgrade to "unverified but allowed".
        signature = undefined;
      }

      return { version, bytes, signature };
    },
  };
}
