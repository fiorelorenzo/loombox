import { z } from 'zod';

import type { NodeUpdateArtifact, NodeUpdateSource } from './self-update';

/**
 * The real {@link NodeUpdateSource}: GitHub Releases, exactly where issue
 * #817's release automation (`.github/workflows/release-node.yml`) already
 * publishes `node-<version>-<os>-<arch>.tar.gz` on every `vX.Y.Z` tag —
 * `scripts/package-node-release.mjs`'s own asset naming, matched here by
 * the same pattern. `fetchImpl` is injected wholesale (mirrors
 * `ci-check-watcher.ts`'s own `resolveToken`/`fetchImpl` DI, the
 * established convention for this codebase's other GitHub REST callers —
 * `github-tracker-backend.ts`, `github-identity.ts`), defaulting to the
 * real global `fetch` in production; tests supply a fake so this never
 * needs real network.
 *
 * `.github/workflows/release-node.yml`'s own doc comment: node and
 * supervisor share one release, but version independently
 * (`packages/node/package.json`'s own `version`, not the tag) — a release
 * asset's version lives in its FILENAME, not the tag it's attached to, so
 * every method below reads it from there.
 */

const githubReleaseAssetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.string().min(1),
});
const githubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  assets: z.array(githubReleaseAssetSchema),
});
type GithubRelease = z.infer<typeof githubReleaseSchema>;

export interface GithubReleaseNodeUpdateSourceOptions {
  /** `"owner/repo"` — e.g. `"fiorelorenzo/loombox"`. */
  repo: string;
  /** This node's own platform, matched against the asset filename exactly like `RemoteOsArch`'s `os`/`arch` (`ssh/remote-runtime.ts`) — the two `RemoteOsArch` values this codebase resolves natively today are `linux`/`darwin` and `x64`/`arm64`, the same set `.github/workflows/release-node.yml`'s own build matrix produces. */
  osArch: { os: string; arch: string };
  /** Defaults to the real global `fetch`. Tests inject a fake — see this module's own doc comment. */
  fetchImpl?: typeof fetch;
}

function assetFileName(osArch: { os: string; arch: string }, version: string): string {
  return `node-${version}-${osArch.os}-${osArch.arch}.tar.gz`;
}

export function createGithubReleaseNodeUpdateSource(
  options: GithubReleaseNodeUpdateSourceOptions,
): NodeUpdateSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const releaseUrl = `https://api.github.com/repos/${options.repo}/releases/latest`;
  const assetNamePattern = new RegExp(
    `^node-(.+)-${options.osArch.os}-${options.osArch.arch}\\.tar\\.gz$`,
  );

  async function fetchLatestRelease(): Promise<GithubRelease> {
    const response = await fetchImpl(releaseUrl, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      throw new Error(
        `github-node-update-source: GET ${releaseUrl} -> ${response.status} ${response.statusText}`,
      );
    }
    const body: unknown = await response.json();
    return githubReleaseSchema.parse(body);
  }

  return {
    async checkLatest() {
      const release = await fetchLatestRelease();
      for (const asset of release.assets) {
        const match = assetNamePattern.exec(asset.name);
        if (match?.[1]) return { version: match[1] };
      }
      return undefined;
    },

    async fetch(version: string): Promise<NodeUpdateArtifact> {
      const release = await fetchLatestRelease();
      const fileName = assetFileName(options.osArch, version);
      const asset = release.assets.find((candidate) => candidate.name === fileName);
      if (!asset) {
        throw new Error(
          `github-node-update-source: no "${fileName}" asset on release ${release.tag_name}`,
        );
      }
      const response = await fetchImpl(asset.browser_download_url);
      if (!response.ok) {
        throw new Error(
          `github-node-update-source: GET ${asset.browser_download_url} -> ${response.status} ${response.statusText}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());

      // Best-effort: today's real `node-<version>-<os>-<arch>.tar.gz`
      // release assets ship unsigned (only the supervisor binary is
      // signed — see `self-update.ts`'s own `NodeUpdateArtifact` doc
      // comment), so a missing sibling `.sig` is the expected, common
      // case, never treated as a fetch failure.
      const sigAsset = release.assets.find((candidate) => candidate.name === `${fileName}.sig`);
      let signature: Uint8Array | undefined;
      if (sigAsset) {
        const sigResponse = await fetchImpl(sigAsset.browser_download_url);
        signature = sigResponse.ok ? new Uint8Array(await sigResponse.arrayBuffer()) : undefined;
      }

      return { version, bytes, signature };
    },
  };
}
