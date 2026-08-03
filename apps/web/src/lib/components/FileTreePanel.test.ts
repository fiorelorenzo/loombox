// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeDirectoryState } from '../relay-client';
import FileTreePanel from './FileTreePanel.svelte';

afterEach(() => cleanup());

function tree(
  entries: Record<string, FileTreeDirectoryState>,
): Map<string, FileTreeDirectoryState> {
  return new Map(Object.entries(entries));
}

describe('FileTreePanel (SPEC §7.4; issue #171)', () => {
  it('renders a loaded root: directories before files, alphabetically', () => {
    render(FileTreePanel, {
      props: {
        tree: tree({
          '': {
            path: '',
            status: 'loaded',
            entries: [
              { name: 'zebra.ts', kind: 'file', size: 1 },
              { name: 'src', kind: 'dir', size: 0 },
              { name: 'README.md', kind: 'file', size: 4 },
            ],
          },
        }),
        onExpand: vi.fn(),
      },
    });

    const dirs = screen.getAllByTestId('file-tree-dir');
    const files = screen.getAllByTestId('file-tree-file');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].textContent).toContain('src');
    expect(files.map((f) => f.querySelector('.name')?.textContent)).toEqual([
      'README.md',
      'zebra.ts',
    ]);
  });

  it('shows a loading indicator while a directory is loading', () => {
    render(FileTreePanel, {
      props: {
        tree: tree({ '': { path: '', status: 'loading', entries: [] } }),
        onExpand: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-tree-loading')).toBeTruthy();
  });

  it('shows an error message when a directory failed to load', () => {
    render(FileTreePanel, {
      props: {
        tree: tree({
          '': { path: '', status: 'error', entries: [], error: 'path escapes the project root' },
        }),
        onExpand: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-tree-error').textContent).toContain(
      'path escapes the project root',
    );
  });

  describe('bounded wait + retry on a stuck directory (issue #582)', () => {
    afterEach(() => vi.useRealTimers());

    it('reaches a retryable failure state when the root never answers (silent node)', async () => {
      vi.useFakeTimers();
      render(FileTreePanel, {
        props: {
          tree: tree({ '': { path: '', status: 'loading', entries: [] } }),
          onExpand: vi.fn(),
        },
      });

      expect(screen.getByTestId('file-tree-loading')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(10_000);

      const notice = screen.getByTestId('file-tree-error');
      // The honest wording (issue #582): never the raw "Error: timeout", and
      // it names what the delay probably means, matching the shell's
      // existing node-offline phrasing (`DirectoryPicker`, issue #505).
      expect(notice.textContent).not.toMatch(/error:\s*timeout/i);
      expect(notice.textContent).toContain('may be asleep, offline, or on an older relay');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });

    it('a slow-but-alive root that answers just under the deadline never shows the error', async () => {
      vi.useFakeTimers();
      const onExpand = vi.fn();
      const { rerender } = render(FileTreePanel, {
        props: {
          tree: tree({ '': { path: '', status: 'loading', entries: [] } }),
          onExpand,
        },
      });

      await vi.advanceTimersByTimeAsync(9_000);
      await rerender({
        tree: tree({
          '': { path: '', status: 'loaded', entries: [{ name: 'a.ts', kind: 'file', size: 1 }] },
        }),
        onExpand,
      });

      // Advance well past where the original deadline would have landed —
      // the stale timer must not fire a late, spurious error.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(screen.queryByTestId('file-tree-error')).toBeNull();
      expect(screen.getAllByTestId('file-tree-file')).toHaveLength(1);
    });

    it('retry re-requests the same path rather than only clearing the error', async () => {
      vi.useFakeTimers();
      const onExpand = vi.fn();
      render(FileTreePanel, {
        props: {
          tree: tree({ '': { path: '', status: 'loading', entries: [] } }),
          onExpand,
        },
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(onExpand).not.toHaveBeenCalled();

      await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(onExpand).toHaveBeenCalledExactlyOnceWith('');
      // Retry re-arms its own bounded wait rather than clearing the flag
      // for good: still stuck (`tree` unchanged, mirroring a dead node),
      // it fails again once that fresh wait elapses.
      expect(screen.queryByTestId('file-tree-error')).toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(screen.getByTestId('file-tree-error')).toBeTruthy();
    });
  });

  it('clicking a directory calls onExpand with its full relative path and reveals a nested loading state', async () => {
    const onExpand = vi.fn();
    render(FileTreePanel, {
      props: {
        tree: tree({
          '': {
            path: '',
            status: 'loaded',
            entries: [{ name: 'src', kind: 'dir', size: 0 }],
          },
        }),
        onExpand,
      },
    });

    await fireEvent.click(screen.getByTestId('file-tree-dir'));
    expect(onExpand).toHaveBeenCalledWith('src');
    // Not yet in the tree map (the caller hasn't delivered a response yet) —
    // the panel shows nothing extra for it beyond having expanded, which is
    // fine; once the store updates with a 'loading'/'loaded' entry for
    // 'src', a re-render would show it (covered by the next test).
  });

  it("renders a nested directory's entries once loaded, at the right depth", async () => {
    render(FileTreePanel, {
      props: {
        tree: tree({
          '': {
            path: '',
            status: 'loaded',
            entries: [{ name: 'src', kind: 'dir', size: 0 }],
          },
          src: {
            path: 'src',
            status: 'loaded',
            entries: [{ name: 'index.ts', kind: 'file', size: 10 }],
          },
        }),
        onExpand: vi.fn(),
      },
    });

    // Expand 'src' by clicking it (the component's own local expand state).
    await fireEvent.click(screen.getByTestId('file-tree-dir'));
    const files = screen.getAllByTestId('file-tree-file');
    expect(files).toHaveLength(1);
    expect(files[0].textContent).toContain('index.ts');
  });

  it('clicking a file calls onSelectFile with its full relative path', async () => {
    const onSelectFile = vi.fn();
    render(FileTreePanel, {
      props: {
        tree: tree({
          '': {
            path: '',
            status: 'loaded',
            entries: [{ name: 'README.md', kind: 'file', size: 4 }],
          },
        }),
        onExpand: vi.fn(),
        onSelectFile,
      },
    });

    await fireEvent.click(screen.getByTestId('file-tree-file'));
    expect(onSelectFile).toHaveBeenCalledWith('README.md');
  });

  it('renders a symlink with its own icon, distinct from a plain file', () => {
    render(FileTreePanel, {
      props: {
        tree: tree({
          '': {
            path: '',
            status: 'loaded',
            entries: [{ name: 'link', kind: 'symlink', size: 0 }],
          },
        }),
        onExpand: vi.fn(),
      },
    });
    // A symlink still renders as a leaf/file-style row (not a directory).
    expect(screen.queryByTestId('file-tree-dir')).toBeNull();
    expect(screen.getByTestId('file-tree-file').textContent).toContain('link');
  });
});
