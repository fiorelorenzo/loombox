// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitGraphCommitV1 } from '@loombox/protocol';
import CommitGraphViewer from './CommitGraphViewer.svelte';

afterEach(() => cleanup());

function commit(overrides: Partial<GitGraphCommitV1> = {}): GitGraphCommitV1 {
  return {
    sha: 'a'.repeat(40),
    parents: [],
    authorName: 'loombox test',
    authorEmail: 'test@loombox.dev',
    authorDateIso: new Date().toISOString(),
    subject: 'a commit',
    refs: [],
    isHead: false,
    ...overrides,
  };
}

describe('CommitGraphViewer: loading/error/empty states (SPEC §7.6; issue #231)', () => {
  it('shows a loading indicator for status: loading', () => {
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loading' },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    expect(screen.getByTestId('commit-graph-loading')).toBeTruthy();
  });

  it('shows an error notice with Retry for status: error, and Retry calls onRetry', async () => {
    const onRetry = vi.fn();
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'error', message: 'git is not available' },
        onRetry,
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    expect(screen.getByText('git is not available')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows an empty-state message for an unborn HEAD (zero commits, not an error)', () => {
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits: [], nextOffset: null },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    expect(screen.getByText('No commits yet on this branch.')).toBeTruthy();
  });
});

describe('CommitGraphViewer: rendering real topology (issue #231)', () => {
  it('renders one row per commit, in the exact order given, with sha/subject/author', () => {
    const commits = [
      commit({ sha: 'a'.repeat(40), subject: 'second commit', authorName: 'Ada' }),
      commit({ sha: 'b'.repeat(40), subject: 'base', authorName: 'Bea' }),
    ];
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits, nextOffset: null },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('commit-graph-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('second commit');
    expect(rows[0]?.textContent).toContain('Ada');
    expect(rows[0]?.textContent).toContain('aaaaaaa'); // short sha
    expect(rows[1]?.textContent).toContain('base');
  });

  it('renders a merge badge exactly for a commit with 2+ parents, never for a single-parent commit', () => {
    const commits = [
      commit({ sha: 'a'.repeat(40), parents: ['b'.repeat(40), 'c'.repeat(40)] }),
      commit({ sha: 'd'.repeat(40), parents: ['e'.repeat(40)] }),
    ];
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits, nextOffset: null },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    const badges = screen.getAllByTestId('commit-graph-merge-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain('2 parents');
  });

  it('renders a HEAD badge exactly for the commit HEAD currently resolves to, including a detached HEAD with no branch ref', () => {
    const commits = [commit({ sha: 'a'.repeat(40), isHead: true, refs: [] })];
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits, nextOffset: null },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    expect(screen.getByTestId('commit-graph-head-badge')).toBeTruthy();
    expect(screen.queryByTestId('commit-graph-ref-badge')).toBeNull();
  });

  it('renders every branch/tag ref badge decorating a commit', () => {
    const commits = [
      commit({
        sha: 'a'.repeat(40),
        refs: [
          { name: 'main', kind: 'branch' },
          { name: 'v1.0', kind: 'tag' },
          { name: 'origin/main', kind: 'remoteBranch' },
        ],
      }),
    ];
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits, nextOffset: null },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    const badges = screen.getAllByTestId('commit-graph-ref-badge');
    expect(badges.map((b) => b.textContent?.trim())).toEqual(['main', 'v1.0', 'origin/main']);
  });
});

describe('CommitGraphViewer: paging (issue #231)', () => {
  it('renders Load more exactly when nextOffset is non-null, and clicking it calls onLoadMore', async () => {
    const onLoadMore = vi.fn();
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits: [commit()], nextOffset: 50 },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore,
      },
    });
    await fireEvent.click(screen.getByTestId('commit-graph-load-more'));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('renders no Load more affordance once nextOffset is null — the walk reached the root', () => {
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits: [commit()], nextOffset: null },
        onRetry: vi.fn(),
        loadingMore: false,
        onLoadMore: vi.fn(),
      },
    });
    expect(screen.queryByTestId('commit-graph-load-more')).toBeNull();
  });

  it('a loadingMore fetch never replaces the already-rendered commit list with a bare spinner', () => {
    render(CommitGraphViewer, {
      props: {
        viewer: { status: 'loaded', commits: [commit()], nextOffset: 50 },
        onRetry: vi.fn(),
        loadingMore: true,
        onLoadMore: vi.fn(),
      },
    });
    expect(screen.getByTestId('commit-graph-list')).toBeTruthy();
    expect(screen.queryByTestId('commit-graph-loading')).toBeNull();
  });
});
