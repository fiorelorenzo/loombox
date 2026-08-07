import { describe, expect, it, vi } from 'vitest';
import type { ReviewCommentStateV1 } from '@loombox/protocol';

import { ReviewCommentWatcher, type ReviewCommentWatchEntry } from './review-comment-watcher';

/**
 * `ReviewCommentWatcher` end to end against a stubbed GitHub GraphQL API
 * (SPEC §7.14; issue #240) — no real network call, ever: `fetchImpl` is a
 * plain `vi.fn()` this file controls directly, never the global `fetch`.
 * Mirrors `ci-check-watcher.test.ts`'s own structure and rationale.
 */

function entry(overrides: Partial<ReviewCommentWatchEntry> = {}): ReviewCommentWatchEntry {
  return {
    owner: 'fiorelorenzo',
    repo: 'loombox',
    prNumber: 42,
    prUrl: 'https://github.com/fiorelorenzo/loombox/pull/42',
    projectPath: '/proj',
    ...overrides,
  };
}

interface RawComment {
  id: string;
  body: string;
  path?: string | null;
  line?: number | null;
  createdAt?: string;
  url?: string | null;
  login?: string;
}

function threadsResponse(
  threads: Array<{ id: string; isResolved: boolean; comments: RawComment[] }>,
): Response {
  return new Response(
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: threads.map((thread) => ({
                id: thread.id,
                isResolved: thread.isResolved,
                comments: {
                  nodes: thread.comments.map((comment) => ({
                    id: comment.id,
                    body: comment.body,
                    path: comment.path ?? 'src/foo.ts',
                    line: comment.line ?? 10,
                    createdAt: comment.createdAt ?? '2026-08-01T00:00:00Z',
                    url: comment.url ?? `https://github.com/fiorelorenzo/loombox/pull/42#${comment.id}`,
                    author: comment.login ? { login: comment.login } : null,
                  })),
                },
              })),
            },
          },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('ReviewCommentWatcher (SPEC §7.14; issue #240)', () => {
  it('never calls fetch when resolveToken has nothing for this entry — reports unknown instead', async () => {
    const resolveToken = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn();
    const onUpdate = vi.fn();
    const watcher = new ReviewCommentWatcher({ resolveToken, fetchImpl, onUpdate });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ state: 'unknown', threads: [] }),
    );
  });

  it('reports clear once every thread is resolved (or there are none at all)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(threadsResponse([]));
    const onUpdate = vi.fn();
    const watcher = new ReviewCommentWatcher({
      resolveToken: async () => 'tok',
      fetchImpl,
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    expect(onUpdate).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ state: 'clear', threads: [] }),
    );
  });

  it('detects an unresolved thread, reports its latest comment, and reports pending', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      threadsResponse([
        {
          id: 'PRRT_1',
          isResolved: false,
          comments: [
            { id: 'PRRC_1', body: 'nit: rename this', login: 'reviewer1' },
            { id: 'PRRC_2', body: 'actually please fix the null check', login: 'reviewer1' },
          ],
        },
      ]),
    );
    const onUpdate = vi.fn();
    const watcher = new ReviewCommentWatcher({
      resolveToken: async () => 'tok',
      fetchImpl,
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    const [, state] = onUpdate.mock.calls[0] as [string, ReviewCommentStateV1];
    expect(state.state).toBe('pending');
    expect(state.threads).toHaveLength(1);
    // The thread's LATEST comment, not its first.
    expect(state.threads[0]).toMatchObject({
      threadId: 'PRRT_1',
      commentId: 'PRRC_2',
      body: 'actually please fix the null check',
      authorLogin: 'reviewer1',
    });
  });

  it('never reports a resolved thread — resolved threads are filtered out entirely', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      threadsResponse([
        { id: 'PRRT_resolved', isResolved: true, comments: [{ id: 'PRRC_1', body: 'fixed' }] },
        { id: 'PRRT_open', isResolved: false, comments: [{ id: 'PRRC_2', body: 'still open' }] },
      ]),
    );
    const onUpdate = vi.fn();
    const watcher = new ReviewCommentWatcher({
      resolveToken: async () => 'tok',
      fetchImpl,
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();

    const [, state] = onUpdate.mock.calls[0] as [string, ReviewCommentStateV1];
    expect(state.threads.map((t) => t.threadId)).toEqual(['PRRT_open']);
  });

  it('a thread that later resolves disappears from the next poll — the "resolved clears it" mechanism', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        threadsResponse([
          { id: 'PRRT_1', isResolved: false, comments: [{ id: 'PRRC_1', body: 'please address' }] },
        ]),
      )
      .mockResolvedValueOnce(
        threadsResponse([{ id: 'PRRT_1', isResolved: true, comments: [{ id: 'PRRC_1', body: 'please address' }] }]),
      );
    const onUpdate = vi.fn();
    const watcher = new ReviewCommentWatcher({
      resolveToken: async () => 'tok',
      fetchImpl,
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();
    expect((onUpdate.mock.calls[0] as [string, ReviewCommentStateV1])[1].state).toBe('pending');

    await watcher.pollNow();
    const [, secondState] = onUpdate.mock.calls[1] as [string, ReviewCommentStateV1];
    expect(secondState.state).toBe('clear');
    expect(secondState.threads).toEqual([]);
  });

  it('fires onNewComment exactly once for a comment that stays unresolved across many polls, not once per poll', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        threadsResponse([
          { id: 'PRRT_1', isResolved: false, comments: [{ id: 'PRRC_1', body: 'please address' }] },
        ]),
      ),
    );
    const onNewComment = vi.fn();
    const watcher = new ReviewCommentWatcher({
      resolveToken: async () => 'tok',
      fetchImpl,
      onNewComment,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onNewComment).toHaveBeenCalledTimes(1);
    expect(onNewComment).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ state: 'pending' }),
      expect.objectContaining({ commentId: 'PRRC_1' }),
    );
  });

  it('fires onNewComment again for a genuinely new reply on an already-notified thread', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        threadsResponse([
          { id: 'PRRT_1', isResolved: false, comments: [{ id: 'PRRC_1', body: 'first comment' }] },
        ]),
      )
      .mockResolvedValueOnce(
        threadsResponse([
          {
            id: 'PRRT_1',
            isResolved: false,
            comments: [
              { id: 'PRRC_1', body: 'first comment' },
              { id: 'PRRC_2', body: 'a reply' },
            ],
          },
        ]),
      );
    const onNewComment = vi.fn();
    const watcher = new ReviewCommentWatcher({
      resolveToken: async () => 'tok',
      fetchImpl,
      onNewComment,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();
    await watcher.pollNow();

    expect(onNewComment).toHaveBeenCalledTimes(2);
    expect((onNewComment.mock.calls[0] as unknown[])[2]).toMatchObject({ commentId: 'PRRC_1' });
    expect((onNewComment.mock.calls[1] as unknown[])[2]).toMatchObject({ commentId: 'PRRC_2' });
  });

  it('degrades to unknown (never throws) on a non-2xx response, a GraphQL errors array, or malformed JSON', async () => {
    const onUpdate = vi.fn();
    const watcher = new ReviewCommentWatcher({
      resolveToken: async () => 'tok',
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(new Response('nope', { status: 500 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response('not json', { status: 200 })),
      onUpdate,
    });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();

    expect(onUpdate).toHaveBeenCalledTimes(3);
    for (const call of onUpdate.mock.calls) {
      expect((call as [string, ReviewCommentStateV1])[1].state).toBe('unknown');
    }
  });

  it('unwatch stops polling and forgets the last reading and dedup state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      threadsResponse([{ id: 'PRRT_1', isResolved: false, comments: [{ id: 'PRRC_1', body: 'x' }] }]),
    );
    const onNewComment = vi.fn();
    const watcher = new ReviewCommentWatcher({ resolveToken: async () => 'tok', fetchImpl, onNewComment });
    watcher.watch('sess-1', entry());

    await watcher.pollNow();
    expect(watcher.latestFor('sess-1')?.state).toBe('pending');

    watcher.unwatch('sess-1');
    expect(watcher.latestFor('sess-1')).toBeUndefined();

    await watcher.pollNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no second poll for the unwatched session
    expect(onNewComment).toHaveBeenCalledTimes(1); // no re-fire either
  });

  it('polls every registered session independently in one pass', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { variables: { number: number } };
        return Promise.resolve(
          body.variables.number === 1
            ? threadsResponse([{ id: 'PRRT_a', isResolved: false, comments: [{ id: 'PRRC_a', body: 'a' }] }])
            : threadsResponse([]),
        );
      });
    const onUpdate = vi.fn();
    const watcher = new ReviewCommentWatcher({ resolveToken: async () => 'tok', fetchImpl, onUpdate });
    watcher.watch('sess-1', entry({ prNumber: 1 }));
    watcher.watch('sess-2', entry({ prNumber: 2 }));

    await watcher.pollNow();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(watcher.latestFor('sess-1')?.state).toBe('pending');
    expect(watcher.latestFor('sess-2')?.state).toBe('clear');
  });
});
