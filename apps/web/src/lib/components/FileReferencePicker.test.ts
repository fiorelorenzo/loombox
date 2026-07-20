// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeDirectoryState } from '../relay-client';
import FileReferencePicker from './FileReferencePicker.svelte';

afterEach(() => cleanup());

function tree(
  entries: Record<string, FileTreeDirectoryState>,
): Map<string, FileTreeDirectoryState> {
  return new Map(Object.entries(entries));
}

const twoFileTree = tree({
  '': {
    path: '',
    status: 'loaded',
    entries: [
      { name: 'README.md', kind: 'file', size: 4 },
      { name: 'src', kind: 'dir', size: 0 },
    ],
  },
  src: {
    path: 'src',
    status: 'loaded',
    entries: [{ name: 'index.ts', kind: 'file', size: 10 }],
  },
});

describe('FileReferencePicker (SPEC §7.25 "@file references"; issue #160)', () => {
  it('renders nothing when closed', () => {
    render(FileReferencePicker, {
      props: {
        open: false,
        tree: twoFileTree,
        onExpand: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByTestId('file-reference-picker')).toBeNull();
  });

  it('lists every known file (across every loaded directory) when the query is empty', () => {
    render(FileReferencePicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const items = screen.getAllByTestId('file-reference-picker-item');
    expect(items.map((i) => i.textContent?.trim()).sort()).toEqual(['README.md', 'src/index.ts']);
  });

  it('excludes directories from the results — only files are @file targets', () => {
    render(FileReferencePicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const items = screen.getAllByTestId('file-reference-picker-item');
    expect(
      items.some((i) => i.textContent?.includes('src') && !i.textContent.includes('index.ts')),
    ).toBe(false);
  });

  it('fuzzy-filters by full relative path as the user types', async () => {
    render(FileReferencePicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    await fireEvent.input(screen.getByTestId('file-reference-picker-input'), {
      target: { value: 'idx' },
    });
    const items = screen.getAllByTestId('file-reference-picker-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('src/index.ts');
  });

  it('Enter selects the active entry and fires onSelect then onClose with the full relative path', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(FileReferencePicker, {
      props: { open: true, tree: twoFileTree, onExpand: vi.fn(), onSelect, onClose },
    });
    const input = screen.getByTestId('file-reference-picker-input');
    await fireEvent.input(input, { target: { value: 'idx' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('src/index.ts');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking an entry selects it directly', async () => {
    const onSelect = vi.fn();
    render(FileReferencePicker, {
      props: { open: true, tree: twoFileTree, onExpand: vi.fn(), onSelect, onClose: vi.fn() },
    });
    const items = screen.getAllByTestId('file-reference-picker-item');
    const readme = items.find((i) => i.textContent?.includes('README.md'));
    await fireEvent.click(readme!);
    expect(onSelect).toHaveBeenCalledWith('README.md');
  });

  it('Esc closes without selecting anything', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(FileReferencePicker, {
      props: { open: true, tree: twoFileTree, onExpand: vi.fn(), onSelect, onClose },
    });
    await fireEvent.keyDown(screen.getByTestId('file-reference-picker-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opportunistically expands every directory it can already see but has not loaded yet, bounded, so the corpus grows toward the whole project', () => {
    const onExpand = vi.fn();
    const rootOnly = tree({
      '': {
        path: '',
        status: 'loaded',
        entries: [
          { name: 'src', kind: 'dir', size: 0 },
          { name: 'docs', kind: 'dir', size: 0 },
        ],
      },
    });
    render(FileReferencePicker, {
      props: { open: true, tree: rootOnly, onExpand, onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(onExpand).toHaveBeenCalledWith('src');
    expect(onExpand).toHaveBeenCalledWith('docs');
  });

  it('does not auto-expand a directory already present in the tree (loading, loaded, or errored)', () => {
    const onExpand = vi.fn();
    const alreadyKnown = tree({
      '': {
        path: '',
        status: 'loaded',
        entries: [{ name: 'src', kind: 'dir', size: 0 }],
      },
      src: { path: 'src', status: 'loading', entries: [] },
    });
    render(FileReferencePicker, {
      props: { open: true, tree: alreadyKnown, onExpand, onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('does not auto-expand anything while closed', () => {
    const onExpand = vi.fn();
    const rootOnly = tree({
      '': { path: '', status: 'loaded', entries: [{ name: 'src', kind: 'dir', size: 0 }] },
    });
    render(FileReferencePicker, {
      props: { open: false, tree: rootOnly, onExpand, onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(onExpand).not.toHaveBeenCalled();
  });
});
