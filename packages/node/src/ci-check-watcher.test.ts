import { describe, expect, it, vi } from 'vitest';
import type { CiCheckStateV1 } from '@loombox/protocol';

import { CiCheckWatcher, parseGithubPullRequestUrl, type CiWatchEntry } from './ci-check-watcher';

/**
 * `CiCheckWatcher` end to end against a stubbed GitHub check-runs API
 * (SPEC §7.14; issue #239) — no real network call, ever: `fetchImpl` is a
 * plain `vi.fn()` this file controls directly, never the global `fetch`.
 */

function entry(overrides: Partial<CiWatchEntry> = {}): CiWatchEntry {
  return {
    owner: 'fiorelorenzo',
    repo: 'loombox',
    ref: 'loombox/session-1',
    prNumber: 42,
    prUrl: 'https://github.com/fiorelorenzo/loombox/pull/42',
    projectPath: '/proj',
    ...overrides,
  };
}

function checkRunsResponse(
  runs: Array<{
    id?: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    output?: { title?: string | null; summary?: string | null };
  }>,
): Response {
  return new Response(
    JSON.stringify({
      total_count: runs.length,
      check_runs: runs.map((run, index) => ({ id: index + 1, ...run })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('CiCheckWatcher (SPEC §7.14; issue #239)', () => {
  it('never calls fetch when resolveToken has nothing for this entry — reports unknown instead', async () => {
    const fetchImpl = vi.fn();
    const onUpdate = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => undefined,
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][1]).toMatchObject({ state: 'unknown', checkRuns: [] });
  });

  it('reports passing once every check run completes successfully', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      checkRunsResponse([
        { name: 'build', head_sha: 'sha-a', status: 'completed', conclusion: 'success' },
        { name: 'lint', head_sha: 'sha-a', status: 'completed', conclusion: 'success' },
      ]),
    );
    const onUpdate = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.github.com/repos/fiorelorenzo/loombox/commits/loombox%2Fsession-1/check-runs?per_page=100',
    );
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_token');
    const state = onUpdate.mock.calls[0][1] as CiCheckStateV1;
    expect(state.state).toBe('passing');
    expect(state.headSha).toBe('sha-a');
    expect(state.checkRuns).toHaveLength(2);
  });

  it('reports pending while a check run is still queued/in_progress, with no failure yet', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        checkRunsResponse([
          { name: 'build', head_sha: 'sha-a', status: 'in_progress', conclusion: null },
        ]),
      );
    const onUpdate = vi.fn();
    const onFailure = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onUpdate,
      onFailure,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    expect((onUpdate.mock.calls[0][1] as CiCheckStateV1).state).toBe('pending');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('detects a failing check run, attaches its own output as a summary, and reports failing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      checkRunsResponse([
        {
          name: 'test',
          head_sha: 'sha-a',
          status: 'completed',
          conclusion: 'failure',
          output: { title: 'Tests failed', summary: '3 tests failed in src/foo.test.ts' },
        },
      ]),
    );
    const onFailure = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onFailure,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    expect(onFailure).toHaveBeenCalledTimes(1);
    const state = onFailure.mock.calls[0][1] as CiCheckStateV1;
    expect(state.state).toBe('failing');
    expect(state.checkRuns[0].summary).toBe('3 tests failed in src/foo.test.ts');
  });

  it('fires onFailure exactly once for a failure that stays red across many polls, not once per poll', async () => {
    // A fresh `Response` per call — a `Response`'s body can only be read
    // once, so reusing one instance across polls (`mockResolvedValue`)
    // would make poll 2/3 throw "body already used", silently degrading
    // to `'unknown'` via `pollOne`'s own catch-all rather than genuinely
    // exercising three real `'failing'` reads.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          checkRunsResponse([
            { name: 'test', head_sha: 'sha-a', status: 'completed', conclusion: 'failure' },
          ]),
        ),
      );
    const onFailure = vi.fn();
    const onUpdate = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onUpdate,
      onFailure,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // All three polls must be genuine 'failing' reads, not one real read
    // plus two swallowed errors that happened to still leave the counts
    // above looking right.
    expect(onUpdate.mock.calls.map(([, state]) => (state as CiCheckStateV1).state)).toEqual([
      'failing',
      'failing',
      'failing',
    ]);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('fires onFailure again once the failure clears and a later poll fails again on a new commit', async () => {
    const fetchImpl = vi.fn();
    const onFailure = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onFailure,
    });
    watcher.watch('sess-1', entry());

    fetchImpl.mockResolvedValueOnce(
      checkRunsResponse([
        { name: 'test', head_sha: 'sha-a', status: 'completed', conclusion: 'failure' },
      ]),
    );
    await watcher.pollNow();
    expect(onFailure).toHaveBeenCalledTimes(1);

    // The operator pushes a fix: the same ref now has a passing check on a new commit.
    fetchImpl.mockResolvedValueOnce(
      checkRunsResponse([
        { name: 'test', head_sha: 'sha-b', status: 'completed', conclusion: 'success' },
      ]),
    );
    await watcher.pollNow();
    expect(onFailure).toHaveBeenCalledTimes(1);

    // A later commit fails again — a genuinely new failure, must fire again.
    fetchImpl.mockResolvedValueOnce(
      checkRunsResponse([
        { name: 'test', head_sha: 'sha-c', status: 'completed', conclusion: 'failure' },
      ]),
    );
    await watcher.pollNow();
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it('degrades to unknown (never throws) on a non-2xx response or malformed JSON', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 403 }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const onUpdate = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();
    expect((onUpdate.mock.calls[0][1] as CiCheckStateV1).state).toBe('unknown');

    await watcher.pollNow();
    expect((onUpdate.mock.calls[1][1] as CiCheckStateV1).state).toBe('unknown');
  });

  it('treats an unrecognized future conclusion value as non-failing, never crying wolf', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      checkRunsResponse([
        {
          name: 'exotic',
          head_sha: 'sha-a',
          status: 'completed',
          conclusion: 'some_future_value',
        },
      ]),
    );
    const onFailure = vi.fn();
    const onUpdate = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onUpdate,
      onFailure,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    expect(onFailure).not.toHaveBeenCalled();
    expect((onUpdate.mock.calls[0][1] as CiCheckStateV1).state).toBe('passing');
  });

  it('unwatch stops polling and forgets the last reading and dedup state', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        checkRunsResponse([
          { name: 'test', head_sha: 'sha-a', status: 'completed', conclusion: 'failure' },
        ]),
      );
    const onFailure = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onFailure,
    });
    watcher.watch('sess-1', entry());
    await watcher.pollNow();
    expect(watcher.latestFor('sess-1')).toBeDefined();

    watcher.unwatch('sess-1');
    expect(watcher.latestFor('sess-1')).toBeUndefined();

    fetchImpl.mockClear();
    await watcher.pollNow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('polls every registered session independently in one pass', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        checkRunsResponse([
          { name: 'a', head_sha: 'sha-a', status: 'completed', conclusion: 'success' },
        ]),
      )
      .mockResolvedValueOnce(
        checkRunsResponse([
          { name: 'b', head_sha: 'sha-b', status: 'completed', conclusion: 'failure' },
        ]),
      );
    const onUpdate = vi.fn();
    const onFailure = vi.fn();
    const watcher = new CiCheckWatcher({
      fetchImpl,
      resolveToken: async () => 'ghp_token',
      onUpdate,
      onFailure,
    });
    watcher.watch('sess-1', entry({ ref: 'branch-1' }));
    watcher.watch('sess-2', entry({ ref: 'branch-2' }));

    await watcher.pollNow();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toBe('sess-2');
  });
});

describe('parseGithubPullRequestUrl (issue #239)', () => {
  it('extracts owner/repo from a real gh pr create URL', () => {
    expect(parseGithubPullRequestUrl('https://github.com/fiorelorenzo/loombox/pull/812')).toEqual({
      owner: 'fiorelorenzo',
      repo: 'loombox',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(parseGithubPullRequestUrl('https://github.com/acme/widgets/pull/7/')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('returns undefined for a non-GitHub-pull-request URL', () => {
    expect(
      parseGithubPullRequestUrl('https://gitlab.com/acme/widgets/-/merge_requests/7'),
    ).toBeUndefined();
    expect(parseGithubPullRequestUrl('not a url')).toBeUndefined();
  });
});
