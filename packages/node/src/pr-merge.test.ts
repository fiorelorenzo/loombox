import { describe, expect, it, vi } from 'vitest';

import { mergePr } from './pr-merge';

/**
 * `mergePr` against a stubbed GitHub REST API (SPEC §7.14; issue #240) —
 * no real network call, ever. Each test stubs `fetchImpl` to answer the
 * read (`GET .../pulls/:n`) and, when reached, the write
 * (`PUT .../pulls/:n/merge`) calls distinctly, proving the "read before
 * write" classification this module's own doc comment describes.
 */

function pullRequestResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ state: 'open', ...body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function options(overrides: Partial<Parameters<typeof mergePr>[0]> = {}) {
  return {
    owner: 'fiorelorenzo',
    repo: 'loombox',
    prNumber: 42,
    method: 'squash' as const,
    token: 'ghp_test',
    ...overrides,
  };
}

describe('mergePr (SPEC §7.14; issue #240)', () => {
  it('merges a clean PR and returns the merge commit sha, never issuing a second read', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: true, mergeable_state: 'clean' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ merged: true, sha: 'abc123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await mergePr({ ...options(), fetchImpl });

    expect(result).toEqual({ outcome: 'merged', sha: 'abc123' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [mergeUrl, mergeInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(mergeUrl).toBe('https://api.github.com/repos/fiorelorenzo/loombox/pulls/42/merge');
    expect(mergeInit.method).toBe('PUT');
    expect(JSON.parse(String(mergeInit.body))).toEqual({ merge_method: 'squash' });
    expect((mergeInit.headers as Record<string, string>).authorization).toBe('Bearer ghp_test');
  });

  it('also merges a "has_hooks" clean-with-a-hook PR (GitHub\'s own other mergeable clean state)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: true, mergeable_state: 'has_hooks' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ merged: true, sha: 'def456' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({
      outcome: 'merged',
      sha: 'def456',
    });
  });

  it('reports already_merged for a PR GitHub already merged — never attempts a write', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ merged: true, state: 'closed' }));

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({
      outcome: 'already_merged',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports blocked/closed for a PR closed without merging — never attempts a write', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ state: 'closed', merged: false }));

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({
      outcome: 'blocked',
      reason: 'closed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports blocked/draft for a draft PR — never attempts a write', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(pullRequestResponse({ draft: true }));

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({
      outcome: 'blocked',
      reason: 'draft',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports not_ready while GitHub is still computing mergeability (mergeable: null) — never attempts a write', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(pullRequestResponse({ mergeable: null }));

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({ outcome: 'not_ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports conflict for a dirty PR (mergeable: false) — never attempts a write', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: false, mergeable_state: 'dirty' }));

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({ outcome: 'conflict' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['blocked', 'requirements_not_met'],
    ['unstable', 'requirements_not_met'],
    ['behind', 'behind_base'],
    ['weird_future_state', 'unknown'],
  ])(
    'reports blocked/%s as reason %s for a PR GitHub reports as not-yet-clean — never attempts a write',
    async (mergeableState, reason) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          pullRequestResponse({ mergeable: true, mergeable_state: mergeableState }),
        );

      await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({
        outcome: 'blocked',
        reason,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('reports blocked/requirements_not_met when the write races a branch-protection rule (405) despite a clean read', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: true, mergeable_state: 'clean' }))
      .mockResolvedValueOnce(new Response('nope', { status: 405 }));

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({
      outcome: 'blocked',
      reason: 'requirements_not_met',
    });
  });

  it('reports conflict when the write races a head-sha change (409) despite a clean read', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: true, mergeable_state: 'clean' }))
      .mockResolvedValueOnce(new Response('sha mismatch', { status: 409 }));

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({ outcome: 'conflict' });
  });

  it('reports failed/unknown for a non-2xx read', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const result = await mergePr({ ...options(), fetchImpl });
    expect(result.outcome).toBe('failed');
    expect(result).toMatchObject({ category: 'unknown' });
  });

  it("reports failed/unknown, with GitHub's own message, for an unexpected non-2xx write", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: true, mergeable_state: 'clean' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Server error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(mergePr({ ...options(), fetchImpl })).resolves.toEqual({
      outcome: 'failed',
      category: 'unknown',
      detail: 'Server error',
    });
  });

  it('never calls fetch a third time — one read, one write, no polling', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: true, mergeable_state: 'clean' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ merged: true, sha: 'z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await mergePr({ ...options(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
