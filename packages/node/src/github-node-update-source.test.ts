import { describe, expect, it, vi } from 'vitest';
import { createGithubReleaseNodeUpdateSource } from './github-node-update-source';

/** Builds a fake `fetch` that answers `GET /repos/<repo>/releases/latest` with `release`, and the two asset download URLs used below with `assetBodies` — mirrors `github-tracker-backend.test.ts`'s own `vi.fn(async (input) => ...)` convention. No real network anywhere in this file. */
function fakeFetch(
  release: { tag_name: string; assets: { name: string; browser_download_url: string }[] },
  assetBodies: Record<string, Uint8Array> = {},
): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/fiorelorenzo/loombox/releases/latest') {
      return new Response(JSON.stringify(release), { status: 200 });
    }
    const body = assetBodies[url];
    if (body) return new Response(body, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const LINUX_X64 = { os: 'linux', arch: 'x64' };

describe('createGithubReleaseNodeUpdateSource (issue #656)', () => {
  it('checkLatest reads the version out of the matching platform asset filename, not the release tag', async () => {
    const fetchImpl = fakeFetch({
      tag_name: 'v0.7.0',
      assets: [
        { name: 'node-0.8.0-linux-x64.tar.gz', browser_download_url: 'https://dl/node-linux' },
        { name: 'node-0.8.0-darwin-arm64.tar.gz', browser_download_url: 'https://dl/node-darwin' },
        { name: 'supervisor-0.3.0-linux-x64-bin', browser_download_url: 'https://dl/sup-linux' },
      ],
    });
    const source = createGithubReleaseNodeUpdateSource({
      repo: 'fiorelorenzo/loombox',
      osArch: LINUX_X64,
      fetchImpl,
    });

    const latest = await source.checkLatest();
    expect(latest).toEqual({ version: '0.8.0' });
  });

  it('checkLatest returns undefined when no asset matches this platform', async () => {
    const fetchImpl = fakeFetch({
      tag_name: 'v0.7.0',
      assets: [
        { name: 'node-0.8.0-darwin-arm64.tar.gz', browser_download_url: 'https://dl/node-darwin' },
      ],
    });
    const source = createGithubReleaseNodeUpdateSource({
      repo: 'fiorelorenzo/loombox',
      osArch: LINUX_X64,
      fetchImpl,
    });

    expect(await source.checkLatest()).toBeUndefined();
  });

  it('fetch downloads the matching platform asset and reports no signature when none is published (today\u2019s real release shape)', async () => {
    const bytes = new TextEncoder().encode('fake-node-bundle-bytes');
    const fetchImpl = fakeFetch(
      {
        tag_name: 'v0.7.0',
        assets: [
          { name: 'node-0.8.0-linux-x64.tar.gz', browser_download_url: 'https://dl/node-linux' },
        ],
      },
      { 'https://dl/node-linux': bytes },
    );
    const source = createGithubReleaseNodeUpdateSource({
      repo: 'fiorelorenzo/loombox',
      osArch: LINUX_X64,
      fetchImpl,
    });

    const artifact = await source.fetch('0.8.0');
    expect(artifact.version).toBe('0.8.0');
    expect(new Uint8Array(artifact.bytes)).toEqual(bytes);
    expect(artifact.signature).toBeUndefined();
  });

  it('fetch downloads a sibling .sig asset when one is published', async () => {
    const bytes = new TextEncoder().encode('fake-node-bundle-bytes');
    const signature = new TextEncoder().encode('fake-signature');
    const fetchImpl = fakeFetch(
      {
        tag_name: 'v0.7.0',
        assets: [
          { name: 'node-0.8.0-linux-x64.tar.gz', browser_download_url: 'https://dl/node-linux' },
          {
            name: 'node-0.8.0-linux-x64.tar.gz.sig',
            browser_download_url: 'https://dl/node-linux.sig',
          },
        ],
      },
      { 'https://dl/node-linux': bytes, 'https://dl/node-linux.sig': signature },
    );
    const source = createGithubReleaseNodeUpdateSource({
      repo: 'fiorelorenzo/loombox',
      osArch: LINUX_X64,
      fetchImpl,
    });

    const artifact = await source.fetch('0.8.0');
    expect(artifact.signature && new Uint8Array(artifact.signature)).toEqual(signature);
  });

  it('fetch rejects with a clear error when the requested version has no asset for this platform', async () => {
    const fetchImpl = fakeFetch({
      tag_name: 'v0.7.0',
      assets: [
        { name: 'node-0.8.0-linux-x64.tar.gz', browser_download_url: 'https://dl/node-linux' },
      ],
    });
    const source = createGithubReleaseNodeUpdateSource({
      repo: 'fiorelorenzo/loombox',
      osArch: LINUX_X64,
      fetchImpl,
    });

    await expect(source.fetch('9.9.9')).rejects.toThrow(
      /no "node-9\.9\.9-linux-x64\.tar\.gz" asset/,
    );
  });

  it('surfaces a non-ok HTTP response as a real failure, never a silent "nothing newer"', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 403 }),
    ) as unknown as typeof fetch;
    const source = createGithubReleaseNodeUpdateSource({
      repo: 'fiorelorenzo/loombox',
      osArch: LINUX_X64,
      fetchImpl,
    });

    await expect(source.checkLatest()).rejects.toThrow(/403/);
  });
});
