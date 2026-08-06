// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitDiffFileV1 } from '@loombox/protocol';
import type { DiffTabViewerState } from '$lib/tabs.svelte';
import WorktreeDiffViewer from './WorktreeDiffViewer.svelte';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia(narrow: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: narrow,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function modifiedFile(path = 'src/foo.ts'): GitDiffFileV1 {
  return { path, previousPath: null, status: 'modified', oldText: 'a\nb\n', newText: 'a\nB\n' };
}

describe('WorktreeDiffViewer: loading/error/empty states', () => {
  it('shows a loading indicator while status is loading', () => {
    render(WorktreeDiffViewer, {
      props: { viewer: { status: 'loading' }, onRetry: vi.fn() },
    });
    expect(screen.getByTestId('worktree-diff-loading')).toBeTruthy();
  });

  it('shows a retryable error notice on status error, calling onRetry when clicked', async () => {
    const onRetry = vi.fn();
    render(WorktreeDiffViewer, {
      props: {
        viewer: { status: 'error', message: 'git is not available on this target' },
        onRetry,
      },
    });
    expect(screen.getByText('git is not available on this target')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state for a clean worktree (zero files, not an error)', () => {
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });
    expect(screen.getByText("No uncommitted changes in this project's worktree.")).toBeTruthy();
  });
});

describe('WorktreeDiffViewer: inline mode (default)', () => {
  it('renders one DiffViewer card per file, file-by-file', () => {
    const viewer: DiffTabViewerState = {
      status: 'loaded',
      files: [modifiedFile('src/a.ts'), modifiedFile('src/b.ts')],
    };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });
    const files = screen.getAllByTestId('worktree-diff-file');
    expect(files).toHaveLength(2);
    expect(within(files[0]).getByText('src/a.ts')).toBeTruthy();
    expect(within(files[1]).getByText('src/b.ts')).toBeTruthy();
  });

  it('a binary file renders the existing structural-only fallback, not garbled text or a crash', () => {
    const binary: GitDiffFileV1 = {
      path: 'assets/logo.png',
      previousPath: null,
      status: 'modified',
      oldText: null,
      newText: '',
    };
    const viewer: DiffTabViewerState = { status: 'loaded', files: [binary] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });
    expect(screen.getByTestId('structural-diff').textContent).toContain('assets/logo.png');
  });

  it('a deleted file renders every old line as removed, with no crash', () => {
    const deleted: GitDiffFileV1 = {
      path: 'gone.txt',
      previousPath: null,
      status: 'deleted',
      oldText: 'line1\nline2\n',
      newText: '',
    };
    const viewer: DiffTabViewerState = { status: 'loaded', files: [deleted] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });
    expect(screen.getByText('gone.txt')).toBeTruthy();
    expect(screen.queryByTestId('structural-diff')).toBeNull();
  });

  it('a renamed file shows a "Renamed from" note above the diff', () => {
    const renamed: GitDiffFileV1 = {
      path: 'renamed.txt',
      previousPath: 'original.txt',
      status: 'renamed',
      oldText: 'x\n',
      newText: 'x\n',
    };
    const viewer: DiffTabViewerState = { status: 'loaded', files: [renamed] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });
    expect(screen.getByText('Renamed from original.txt')).toBeTruthy();
  });

  it('forwards a file open click to onOpenFile with that file\u2019s path', async () => {
    const onOpenFile = vi.fn();
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile('src/a.ts')] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn(), onOpenFile } });
    await fireEvent.click(screen.getByTestId('diff-viewer-open'));
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
  });
});

describe('WorktreeDiffViewer: split mode', () => {
  it('switching to Split renders two panes with the old/new lines side by side', async () => {
    stubMatchMedia(false);
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile()] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });

    await fireEvent.click(screen.getByTestId('worktree-diff-mode-split'));

    const oldPane = screen.getByTestId('worktree-diff-split-old');
    const newPane = screen.getByTestId('worktree-diff-split-new');
    expect(within(oldPane).getByText('b')).toBeTruthy();
    expect(within(newPane).getByText('B')).toBeTruthy();
  });

  it('a binary file in split mode renders the same structural-only fallback text, no crash', async () => {
    stubMatchMedia(false);
    const binary: GitDiffFileV1 = {
      path: 'assets/logo.png',
      previousPath: null,
      status: 'modified',
      oldText: null,
      newText: '',
    };
    const viewer: DiffTabViewerState = { status: 'loaded', files: [binary] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });

    await fireEvent.click(screen.getByTestId('worktree-diff-mode-split'));
    expect(screen.getByTestId('worktree-diff-split-structural').textContent).toContain(
      'assets/logo.png',
    );
    expect(screen.queryByTestId('worktree-diff-split-old')).toBeNull();
  });

  it('a renamed file in split mode still shows the "Renamed from" note', async () => {
    stubMatchMedia(false);
    const renamed: GitDiffFileV1 = {
      path: 'renamed.txt',
      previousPath: 'original.txt',
      status: 'renamed',
      oldText: 'x\n',
      newText: 'x\n',
    };
    const viewer: DiffTabViewerState = { status: 'loaded', files: [renamed] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn() } });

    await fireEvent.click(screen.getByTestId('worktree-diff-mode-split'));
    expect(screen.getByText('Renamed from original.txt')).toBeTruthy();
  });
});

describe('WorktreeDiffViewer: narrow-viewport honesty (issue #206 acceptance line)', () => {
  it('disables the Split option and stays on inline rendering below the tablet breakpoint', async () => {
    stubMatchMedia(true);
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile()] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn(), onOpenFile: vi.fn() } });

    const splitButton = screen.getByTestId('worktree-diff-mode-split') as HTMLButtonElement;
    expect(splitButton.disabled).toBe(true);

    await fireEvent.click(splitButton);
    // Still inline: a per-file DiffViewer card renders, no split panes.
    expect(screen.getByTestId('diff-viewer-open')).toBeTruthy();
    expect(screen.queryByTestId('worktree-diff-split-old')).toBeNull();
  });

  it('leaves Split enabled and available at/above the tablet breakpoint', () => {
    stubMatchMedia(false);
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile()] };
    render(WorktreeDiffViewer, { props: { viewer, onRetry: vi.fn(), onOpenFile: vi.fn() } });

    const splitButton = screen.getByTestId('worktree-diff-mode-split') as HTMLButtonElement;
    expect(splitButton.disabled).toBe(false);
  });
});
