import { describe, expect, it } from 'vitest';
import type { FileTreeDirectoryState } from './relay-client';
import { flattenLoadedFiles, joinTreePath, sortEntries } from './file-tree';

describe('joinTreePath', () => {
  it('returns the bare name at the project root', () => {
    expect(joinTreePath('', 'README.md')).toBe('README.md');
  });

  it('joins a nested parent with a slash', () => {
    expect(joinTreePath('src', 'index.ts')).toBe('src/index.ts');
    expect(joinTreePath('src/lib', 'foo.ts')).toBe('src/lib/foo.ts');
  });
});

describe('sortEntries', () => {
  it('sorts directories before files', () => {
    const entries = [
      { name: 'b.txt', kind: 'file' as const, size: 1 },
      { name: 'a-dir', kind: 'dir' as const, size: 0 },
    ];
    expect([...entries].sort(sortEntries).map((e) => e.name)).toEqual(['a-dir', 'b.txt']);
  });

  it('sorts alphabetically within the same kind', () => {
    const entries = [
      { name: 'zebra.ts', kind: 'file' as const, size: 1 },
      { name: 'apple.ts', kind: 'file' as const, size: 1 },
    ];
    expect([...entries].sort(sortEntries).map((e) => e.name)).toEqual(['apple.ts', 'zebra.ts']);
  });
});

describe('flattenLoadedFiles', () => {
  it('flattens files across every loaded directory with full relative paths', () => {
    const tree = new Map<string, FileTreeDirectoryState>([
      [
        '',
        {
          path: '',
          status: 'loaded',
          entries: [
            { name: 'README.md', kind: 'file', size: 4 },
            { name: 'src', kind: 'dir', size: 0 },
          ],
        },
      ],
      [
        'src',
        {
          path: 'src',
          status: 'loaded',
          entries: [{ name: 'index.ts', kind: 'file', size: 10 }],
        },
      ],
    ]);

    const files = flattenLoadedFiles(tree);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'src/index.ts']);
  });

  it('excludes directory entries themselves', () => {
    const tree = new Map<string, FileTreeDirectoryState>([
      ['', { path: '', status: 'loaded', entries: [{ name: 'src', kind: 'dir', size: 0 }] }],
    ]);
    expect(flattenLoadedFiles(tree)).toEqual([]);
  });

  it('excludes entries from a directory that is still loading or errored', () => {
    const tree = new Map<string, FileTreeDirectoryState>([
      ['', { path: '', status: 'loading', entries: [] }],
      ['other', { path: 'other', status: 'error', entries: [], error: 'nope' }],
    ]);
    expect(flattenLoadedFiles(tree)).toEqual([]);
  });

  it('includes a symlink entry only implicitly via its own kind (not treated as a directory)', () => {
    const tree = new Map<string, FileTreeDirectoryState>([
      [
        '',
        {
          path: '',
          status: 'loaded',
          entries: [{ name: 'link', kind: 'symlink', size: 0 }],
        },
      ],
    ]);
    // A symlink is neither a plain file nor a browsable directory in v1's
    // read-only model, so it is not offered as an @file target.
    expect(flattenLoadedFiles(tree)).toEqual([]);
  });
});
