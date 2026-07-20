import type { FsEntryV1 } from '@loombox/protocol';
import type { FileTreeDirectoryState } from './relay-client';

/**
 * Pure helpers over `RelayClient.fileTreeFor`'s `Map<path, FileTreeDirectoryState>`
 * (SPEC §7.4's file-tree panel, issue #171; SPEC §7.25's `@file` picker,
 * issue #160) — kept framework-free so both `FileTreePanel.svelte` (renders
 * one level at a time, recursively) and `FileReferencePicker.svelte` (needs
 * a flat, searchable list) share one notion of "what's currently known"
 * rather than each re-deriving it.
 */

/** Joins a parent directory path (`''` for the project root) with a bare entry name into a path relative to the project root. */
export function joinTreePath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/** Directories sort before files, then alphabetically within each group — the conventional file-tree ordering. */
export function sortEntries(a: FsEntryV1, b: FsEntryV1): number {
  if (a.kind === 'dir' && b.kind !== 'dir') return -1;
  if (a.kind !== 'dir' && b.kind === 'dir') return 1;
  return a.name.localeCompare(b.name);
}

/** One file entry, flattened with its full path relative to the project root — {@link flattenLoadedFiles}'s row shape. */
export interface FlatFileEntry extends FsEntryV1 {
  path: string;
}

/**
 * Every FILE (not directory) entry across every directory the tree currently
 * has loaded, flattened with full relative paths — the `@file` picker's
 * search corpus (SPEC §7.25; issue #160). Deliberately scoped to what's
 * already loaded rather than eagerly walking the whole project: SPEC §7.4's
 * lazy-expand contract already governs how much of the tree is known at any
 * point, and the picker searches exactly that, growing as the user (or the
 * picker itself, see `FileReferencePicker.svelte`) expands more of it.
 */
export function flattenLoadedFiles(tree: Map<string, FileTreeDirectoryState>): FlatFileEntry[] {
  const rows: FlatFileEntry[] = [];
  for (const dir of tree.values()) {
    if (dir.status !== 'loaded') continue;
    for (const entry of dir.entries) {
      if (entry.kind !== 'file') continue;
      rows.push({ ...entry, path: joinTreePath(dir.path, entry.name) });
    }
  }
  return rows;
}
