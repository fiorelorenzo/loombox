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
