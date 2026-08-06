// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitDiffFileV1, GitHunkFileV1, GitHunkV1 } from '@loombox/protocol';
import type { DiffTabViewerState, HunkTabViewerState } from '$lib/tabs.svelte';
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

/** Every prop `WorktreeDiffViewer` requires beyond the one the caller is actually exercising — a default `hunkViewer: 'loading'` plus no-op callbacks for every issue #232 handler, so a test only exercising the plain diff surface (issue #206) never has to spell out five hunk-action props it doesn't care about. */
function renderDiffViewer(props: {
  viewer: DiffTabViewerState;
  onRetry?: () => void;
  onOpenFile?: (path: string) => void;
  hunkViewer?: HunkTabViewerState;
  onRetryHunks?: () => void;
  onStageHunk?: (path: string, hunkIndex: number) => void;
  onUnstageHunk?: (path: string, hunkIndex: number) => void;
  onDiscardHunk?: (path: string, hunkIndex: number, hunk: GitHunkV1) => void;
}) {
  return render(WorktreeDiffViewer, {
    props: {
      onRetry: vi.fn(),
      hunkViewer: { status: 'loading' },
      onRetryHunks: vi.fn(),
      onStageHunk: vi.fn(),
      onUnstageHunk: vi.fn(),
      onDiscardHunk: vi.fn(),
      ...props,
    },
  });
}

describe('WorktreeDiffViewer: loading/error/empty states', () => {
  it('shows a loading indicator while status is loading', () => {
    renderDiffViewer({ viewer: { status: 'loading' } });
    expect(screen.getByTestId('worktree-diff-loading')).toBeTruthy();
  });

  it('shows a retryable error notice on status error, calling onRetry when clicked', async () => {
    const onRetry = vi.fn();
    renderDiffViewer({
      viewer: { status: 'error', message: 'git is not available on this target' },
      onRetry,
    });
    expect(screen.getByText('git is not available on this target')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state for a clean worktree (zero files, not an error)', () => {
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    renderDiffViewer({ viewer });
    expect(screen.getByText("No uncommitted changes in this project's worktree.")).toBeTruthy();
  });
});

describe('WorktreeDiffViewer: inline mode (default)', () => {
  it('renders one DiffViewer card per file, file-by-file', () => {
    const viewer: DiffTabViewerState = {
      status: 'loaded',
      files: [modifiedFile('src/a.ts'), modifiedFile('src/b.ts')],
    };
    renderDiffViewer({ viewer });
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
    renderDiffViewer({ viewer });
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
    renderDiffViewer({ viewer });
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
    renderDiffViewer({ viewer });
    expect(screen.getByText('Renamed from original.txt')).toBeTruthy();
  });

  it('forwards a file open click to onOpenFile with that file\u2019s path', async () => {
    const onOpenFile = vi.fn();
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile('src/a.ts')] };
    renderDiffViewer({ viewer, onOpenFile });
    await fireEvent.click(screen.getByTestId('diff-viewer-open'));
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
  });
});

describe('WorktreeDiffViewer: split mode', () => {
  it('switching to Split renders two panes with the old/new lines side by side', async () => {
    stubMatchMedia(false);
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile()] };
    renderDiffViewer({ viewer });

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
    renderDiffViewer({ viewer });

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
    renderDiffViewer({ viewer });

    await fireEvent.click(screen.getByTestId('worktree-diff-mode-split'));
    expect(screen.getByText('Renamed from original.txt')).toBeTruthy();
  });
});

describe('WorktreeDiffViewer: narrow-viewport honesty (issue #206 acceptance line)', () => {
  it('disables the Split option and stays on inline rendering below the tablet breakpoint', async () => {
    stubMatchMedia(true);
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile()] };
    renderDiffViewer({ viewer, onOpenFile: vi.fn() });

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
    renderDiffViewer({ viewer, onOpenFile: vi.fn() });

    const splitButton = screen.getByTestId('worktree-diff-mode-split') as HTMLButtonElement;
    expect(splitButton.disabled).toBe(false);
  });
});

// Issue #232: hunk-level stage/unstage/discard, the staging surface
// alongside issue #206's read-only diff. `hunk()`/`partiallyStagedFile()`
// mirror `packages/node/src/git-diff.test.ts`'s own multi-hunk/partially-
// staged fixture shape.
function unstagedHunk(): GitHunkV1 {
  return {
    header: '@@ -18,1 +18,1 @@',
    oldStart: 18,
    oldLines: 1,
    newStart: 18,
    newLines: 1,
    lines: [
      { kind: 'removed', text: 'line18' },
      { kind: 'added', text: 'LINE18' },
    ],
  };
}

function stagedHunk(): GitHunkV1 {
  return {
    header: '@@ -2,1 +2,1 @@',
    oldStart: 2,
    oldLines: 1,
    newStart: 2,
    newLines: 1,
    lines: [
      { kind: 'removed', text: 'line2' },
      { kind: 'added', text: 'LINE2' },
    ],
  };
}

function partiallyStagedFile(path = 'multi.txt'): GitHunkFileV1 {
  return {
    path,
    previousPath: null,
    status: 'modified',
    staged: [stagedHunk()],
    unstaged: [unstagedHunk()],
  };
}

describe('WorktreeDiffViewer: staging surface toggle (issue #232)', () => {
  it('defaults to the Diff surface and switches to Stage changes on click', async () => {
    const viewer: DiffTabViewerState = { status: 'loaded', files: [modifiedFile()] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [partiallyStagedFile()] };
    renderDiffViewer({ viewer, hunkViewer });

    expect(screen.getByTestId('worktree-diff-files')).toBeTruthy();
    expect(screen.queryByTestId('worktree-hunk-files')).toBeNull();

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));

    expect(screen.getByTestId('worktree-hunk-files')).toBeTruthy();
    expect(screen.queryByTestId('worktree-diff-files')).toBeNull();

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-diff'));
    expect(screen.getByTestId('worktree-diff-files')).toBeTruthy();
  });
});

describe('WorktreeDiffViewer: staging content (issue #232)', () => {
  it('shows a loading indicator for the staging surface independent of the diff surface', async () => {
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loading' };
    renderDiffViewer({ viewer, hunkViewer });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));
    expect(screen.getByTestId('worktree-hunk-loading')).toBeTruthy();
  });

  it('shows a retryable error notice on hunkViewer error, calling onRetryHunks when clicked', async () => {
    const onRetryHunks = vi.fn();
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'error', message: 'not a git repository' };
    renderDiffViewer({ viewer, hunkViewer, onRetryHunks });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));
    expect(screen.getByText('not a git repository')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryHunks).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state for a clean worktree on the staging surface too', async () => {
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [] };
    renderDiffViewer({ viewer, hunkViewer });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));
    expect(screen.getByText("No uncommitted changes in this project's worktree.")).toBeTruthy();
  });

  it('renders a partially staged file with separate Staged and Unstaged sections, each with its own hunk', async () => {
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [partiallyStagedFile()] };
    renderDiffViewer({ viewer, hunkViewer });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));

    const staged = screen.getByTestId('hunk-side-staged');
    expect(within(staged).getByText('LINE2')).toBeTruthy();
    expect(within(staged).getByText('@@ -2,1 +2,1 @@')).toBeTruthy();

    const unstaged = screen.getByTestId('hunk-side-unstaged');
    expect(within(unstaged).getByText('LINE18')).toBeTruthy();
    expect(within(unstaged).getByText('@@ -18,1 +18,1 @@')).toBeTruthy();
  });

  it('an unstaged hunk offers Stage and Discard, a staged hunk offers only Unstage', async () => {
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [partiallyStagedFile()] };
    renderDiffViewer({ viewer, hunkViewer });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));

    const staged = screen.getByTestId('hunk-side-staged');
    expect(within(staged).getByTestId('hunk-unstage-button')).toBeTruthy();
    expect(within(staged).queryByTestId('hunk-stage-button')).toBeNull();
    expect(within(staged).queryByTestId('hunk-discard-button')).toBeNull();

    const unstaged = screen.getByTestId('hunk-side-unstaged');
    expect(within(unstaged).getByTestId('hunk-stage-button')).toBeTruthy();
    expect(within(unstaged).getByTestId('hunk-discard-button')).toBeTruthy();
    expect(within(unstaged).queryByTestId('hunk-unstage-button')).toBeNull();
  });

  it('clicking Stage hunk calls onStageHunk with the file path and its position within the unstaged array', async () => {
    const onStageHunk = vi.fn();
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [partiallyStagedFile()] };
    renderDiffViewer({ viewer, hunkViewer, onStageHunk });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));
    await fireEvent.click(
      within(screen.getByTestId('hunk-side-unstaged')).getByTestId('hunk-stage-button'),
    );

    expect(onStageHunk).toHaveBeenCalledWith('multi.txt', 0);
  });

  it('clicking Unstage hunk calls onUnstageHunk with the file path and its position within the staged array', async () => {
    const onUnstageHunk = vi.fn();
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [partiallyStagedFile()] };
    renderDiffViewer({ viewer, hunkViewer, onUnstageHunk });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));
    await fireEvent.click(
      within(screen.getByTestId('hunk-side-staged')).getByTestId('hunk-unstage-button'),
    );

    expect(onUnstageHunk).toHaveBeenCalledWith('multi.txt', 0);
  });

  it('clicking Discard calls onDiscardHunk with the file path, unstaged index, and the hunk itself', async () => {
    const onDiscardHunk = vi.fn();
    const file = partiallyStagedFile();
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [file] };
    renderDiffViewer({ viewer, hunkViewer, onDiscardHunk });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));
    await fireEvent.click(
      within(screen.getByTestId('hunk-side-unstaged')).getByTestId('hunk-discard-button'),
    );

    expect(onDiscardHunk).toHaveBeenCalledWith('multi.txt', 0, file.unstaged[0]);
  });

  it('an untracked file\u2019s single synthetic hunk renders as unstaged with a Stage and a Discard action', async () => {
    const untracked: GitHunkFileV1 = {
      path: 'new.txt',
      previousPath: null,
      status: 'added',
      staged: [],
      unstaged: [
        {
          header: '@@ -0,0 +1,1 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: [{ kind: 'added', text: 'hello' }],
        },
      ],
    };
    const viewer: DiffTabViewerState = { status: 'loaded', files: [] };
    const hunkViewer: HunkTabViewerState = { status: 'loaded', files: [untracked] };
    renderDiffViewer({ viewer, hunkViewer });

    await fireEvent.click(screen.getByTestId('worktree-diff-surface-staging'));

    expect(screen.queryByTestId('hunk-side-staged')).toBeNull();
    const unstaged = screen.getByTestId('hunk-side-unstaged');
    expect(within(unstaged).getByText('hello')).toBeTruthy();
    expect(within(unstaged).getByTestId('hunk-stage-button')).toBeTruthy();
    expect(within(unstaged).getByTestId('hunk-discard-button')).toBeTruthy();
  });
});
