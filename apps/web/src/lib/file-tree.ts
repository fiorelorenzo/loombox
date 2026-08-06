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
 * Every entry (file AND directory) across every directory the tree
 * currently has loaded, flattened with full relative paths — the `@`
 * mention picker's Files-tab search corpus (issue #742; supersedes the
 * files-only `@file` picker issue #160 shipped). Deliberately scoped to
 * what's already loaded rather than eagerly walking the whole project:
 * SPEC §7.4's lazy-expand contract already governs how much of the tree is
 * known at any point, and the picker searches exactly that, growing as the
 * user (or the picker itself, see `MentionPicker.svelte`) expands more of
 * it.
 */
export function flattenLoadedEntries(tree: Map<string, FileTreeDirectoryState>): FlatFileEntry[] {
  const rows: FlatFileEntry[] = [];
  for (const dir of tree.values()) {
    if (dir.status !== 'loaded') continue;
    for (const entry of dir.entries) {
      rows.push({ ...entry, path: joinTreePath(dir.path, entry.name) });
    }
  }
  return rows;
}

/** Every FILE (not directory) entry, the `flattenLoadedEntries` subset a files-only caller wants — {@link flattenLoadedEntries}'s own doc comment covers the shared "loaded only" scoping. */
export function flattenLoadedFiles(tree: Map<string, FileTreeDirectoryState>): FlatFileEntry[] {
  return flattenLoadedEntries(tree).filter((entry) => entry.kind === 'file');
}
