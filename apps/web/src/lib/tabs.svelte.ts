/**
 * The canvas tab strip's own state (issue #737, settled pick B2-2 in
 * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §2): the
 * session transcript is a permanent, non-closable, non-reorderable tab
 * pinned first; anything opened from the Files panel tree, an `@`-mention
 * pill, or a diff card's own "open" affordance lands beside it as a real
 * closable tab, keyed by its project-relative path so opening the same
 * file twice activates the existing tab rather than duplicating it.
 *
 * Deliberately a plain reactive class, not a component (mirrors
 * `dock-panel.svelte.ts`'s own doc comment for the same reasoning): a tab
 * strip's markup belongs to `CanvasTabStrip.svelte`, this owns only the
 * state every entry point mutates and every consumer (the strip, the
 * file viewer, the narrow-viewport picker) reads. One instance lives for
 * as long as a session is selected — `+page.svelte` calls {@link reset}
 * when `selectedSessionId` changes, the same "a new session starts clean"
 * convention `TranscriptTimeline`'s own `sessionKey` reset already uses.
 *
 * The dirty indicator ("the agent's own edit touched that file since you
 * last looked") is a transcript-position watermark per tab, not a
 * wall-clock timestamp — see {@link syncDirty}'s own doc comment for why.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { GitDiffFileV1, GitGraphCommitV1, GitHunkFileV1 } from '@loombox/protocol';
import type { TranscriptItem } from '@loombox/providers-core/browser';

/** A file tab's own content-loading state — set to `'loading'` the instant a tab opens, then resolved once the caller's `readFile` round trip (or a re-open) settles. `hash` (issue #205's integrated editor) is `fsReadResultV1`'s own optimistic-concurrency token: the editor forwards it back as `fs_write_request`'s `baseHash`, so a save can never land against stale content without the node noticing. */
export type FileTabViewerState =
  | { status: 'loading' }
  | { status: 'loaded'; content: string; truncated: boolean; hash: string }
  | { status: 'error'; message: string };

/** The working-tree diff tab's own content-loading state (issue #206) — the exact same "loading -> resolved" shape as {@link FileTabViewerState}, minus a `truncated` flag (`git_diff_response` never truncates the file LIST, only each file's own text, already handled node-side). */
export type DiffTabViewerState =
  | { status: 'loading' }
  | { status: 'loaded'; files: readonly GitDiffFileV1[] }
  | { status: 'error'; message: string };

/** The working-tree diff tab's own STAGING-mode content-loading state (SPEC §7.6; issue #232) — the exact same "loading -> resolved" shape as {@link DiffTabViewerState}, a per-hunk breakdown fetched separately from it (`git_hunk_diff_request`/`git_hunk_diff_response`, distinct from `git_diff_request`/`git_diff_response`) since the two views answer different questions ("what changed against HEAD" vs. "what's staged vs. unstaged, hunk by hunk"). */
export type HunkTabViewerState =
  | { status: 'loading' }
  | { status: 'loaded'; files: readonly GitHunkFileV1[] }
  | { status: 'error'; message: string };

/** The commit graph / branch tree tab's own content-loading state (SPEC §7.6; issue #231) — the exact same "loading -> resolved" shape as {@link DiffTabViewerState}. `commits` accumulates across pages (see `CanvasTabsState.appendGraphPage`) — this is the FULL list rendered so far, not just the latest page; `nextOffset` is `git_graph_response`'s own paging cursor, `null` once the walk reached the ref's root. */
export type GraphTabViewerState =
  | { status: 'loading' }
  | { status: 'loaded'; commits: readonly GitGraphCommitV1[]; nextOffset: number | null }
  | { status: 'error'; message: string };

/** The one permanent tab — pinned first, never closable, never reorderable (issue #737's own acceptance line). */
export interface TranscriptCanvasTab {
  readonly kind: 'transcript';
  readonly id: 'transcript';
}

/** A closable tab over one opened file's read-only content. `id` and `path` are the same string — a file's project-relative path is already a unique key, so opening it twice from two different entry points (e.g. the tree, then a diff card) activates this one tab rather than minting a second. */
export interface FileCanvasTab {
  readonly kind: 'file';
  readonly id: string;
  readonly path: string;
  readonly name: string;
}

/** The working-tree diff tab (SPEC §7.4; issue #206): closable like a file tab, but a singleton — there is only ever one "the session's own current diff", never one per file, so `id` is a constant rather than path-keyed. */
export interface DiffCanvasTab {
  readonly kind: 'diff';
  readonly id: 'diff';
}

/** The commit graph / branch tree tab (SPEC §7.6; issue #231): closable like a file tab, but a singleton — same "one, not one per file" shape as {@link DiffCanvasTab}. */
export interface GraphCanvasTab {
  readonly kind: 'graph';
  readonly id: 'graph';
}

export type CanvasTab = TranscriptCanvasTab | FileCanvasTab | DiffCanvasTab | GraphCanvasTab;

const DIFF_TAB: DiffCanvasTab = { kind: 'diff', id: 'diff' };

const GRAPH_TAB: GraphCanvasTab = { kind: 'graph', id: 'graph' };

const TRANSCRIPT_TAB: TranscriptCanvasTab = { kind: 'transcript', id: 'transcript' };

export class CanvasTabsState {
  #tabs = $state<CanvasTab[]>([TRANSCRIPT_TAB]);
  #activeId = $state<string>(TRANSCRIPT_TAB.id);
  /** Path -> that file tab's own content state, kept separate from `#tabs` (issue #737's viewer is a snapshot fetched once per open, not part of the tab's own identity). */
  readonly #viewers = new SvelteMap<string, FileTabViewerState>();
  /** Paths currently flagged dirty — a `SvelteSet` (not a plain field) so a template reading {@link isDirty} re-renders the instant `syncDirty` adds to it. */
  readonly #dirty = new SvelteSet<string>();
  /** Path -> the transcript item-count watermark as of that tab's last activation — see {@link syncDirty}. */
  readonly #viewedUntil = new SvelteMap<string, number>();
  /** The working-tree diff tab's own content (issue #206) — `undefined` until {@link openDiff} first opens it, mirroring `#viewers`' "no entry yet" state but as a single field rather than a map, since there is only ever one diff tab. */
  #diffViewer = $state<DiffTabViewerState | undefined>(undefined);
  /** The working-tree diff tab's own STAGING-mode content (issue #232) — same "no entry until first opened" shape as {@link #diffViewer}, kept as a separate field since it's fetched via a separate wire pair on its own refresh cadence (every hunk action re-fetches only this, never {@link #diffViewer}). */
  #hunkViewer = $state<HunkTabViewerState | undefined>(undefined);
  /** The commit graph tab's own content (SPEC §7.6; issue #231) — same "no entry until first opened" shape as {@link #diffViewer}. */
  #graphViewer = $state<GraphTabViewerState | undefined>(undefined);
  /** Whether a "Load more" page fetch is in flight for the commit graph tab — kept separate from `#graphViewer.status` so paging further in never flips an already-`'loaded'` list back to a bare loading spinner and discards what is already rendered. */
  #graphLoadingMore = $state(false);

  get tabs(): readonly CanvasTab[] {
    return this.#tabs;
  }

  get activeId(): string {
    return this.#activeId;
  }

  get activeTab(): CanvasTab {
    return this.#tabs.find((tab) => tab.id === this.#activeId) ?? TRANSCRIPT_TAB;
  }

  /** Whether `path` already has an open tab — an entry point checks this before deciding "open" vs "activate", though {@link open} itself is idempotent either way. */
  has(path: string): boolean {
    return this.#tabs.some((tab) => tab.kind === 'file' && tab.path === path);
  }

  viewerFor(path: string): FileTabViewerState | undefined {
    return this.#viewers.get(path);
  }

  get diffViewer(): DiffTabViewerState | undefined {
    return this.#diffViewer;
  }

  get hunkViewer(): HunkTabViewerState | undefined {
    return this.#hunkViewer;
  }

  get graphViewer(): GraphTabViewerState | undefined {
    return this.#graphViewer;
  }

  get graphLoadingMore(): boolean {
    return this.#graphLoadingMore;
  }

  isDirty(path: string): boolean {
    return this.#dirty.has(path);
  }

  /**
   * Opens a file tab for `path` (or, if one is already open, just
   * activates it — never a duplicate) and marks it viewed as of `items`'
   * current length. `items` is the caller's live `transcript.items` —
   * every entry point (`+page.svelte`'s Files-panel/mention-pill/diff-card
   * wiring) already holds it, so nothing here reaches for a store itself.
   * A freshly opened tab's viewer starts `'loading'`; the caller is
   * responsible for calling {@link setViewer} once its own `readFile`
   * round trip settles (this class has no `RelayClient` of its own — see
   * the module doc comment on why it stays a plain state class).
   */
  open(path: string, items: readonly TranscriptItem[]): void {
    if (!this.has(path)) {
      const name = path.split('/').pop() || path;
      this.#tabs = [...this.#tabs, { kind: 'file', id: path, path, name }];
      this.#viewers.set(path, { status: 'loading' });
    }
    this.activate(path, items);
  }

  /**
   * Opens the working-tree diff tab (or, if already open, just activates
   * it — never a duplicate), issue #206. `items` mirrors {@link open}'s
   * own parameter (every entry point already holds it); the diff tab has
   * no per-file dirty/watermark tracking, so `activate` merely reuses it
   * as the general activation entry point. A freshly opened tab's viewer
   * starts `'loading'`; the caller is responsible for calling
   * {@link setDiffViewer} once its own `requestWorktreeDiff` round trip
   * settles, exactly like {@link open}'s `setViewer` contract.
   */
  openDiff(items: readonly TranscriptItem[]): void {
    if (!this.#tabs.some((tab) => tab.id === DIFF_TAB.id)) {
      this.#tabs = [...this.#tabs, DIFF_TAB];
      this.#diffViewer = { status: 'loading' };
      this.#hunkViewer = { status: 'loading' };
    }
    this.activate(DIFF_TAB.id, items);
  }

  /**
   * Opens the commit graph tab (or, if already open, just activates it —
   * never a duplicate), SPEC §7.6, issue #231. `items` mirrors {@link
   * openDiff}'s own parameter. A freshly opened tab's viewer starts
   * `'loading'`; the caller is responsible for calling {@link
   * setGraphViewer} once its own `requestCommitGraph` round trip
   * settles, exactly like {@link openDiff}'s `setDiffViewer` contract.
   * Re-opening an already-open graph tab does NOT reset an already-
   * loaded viewer back to `'loading'` — same "switching back shows what
   * was already fetched, not a fresh spinner" contract {@link openDiff}
   * itself follows for its own diff viewer.
   */
  openGraph(items: readonly TranscriptItem[]): void {
    if (!this.#tabs.some((tab) => tab.id === GRAPH_TAB.id)) {
      this.#tabs = [...this.#tabs, GRAPH_TAB];
      this.#graphViewer = { status: 'loading' };
    }
    this.activate(GRAPH_TAB.id, items);
  }

  /** Activates an already-open tab by id (a no-op for an id that isn't open) and, for a file tab, clears its dirty flag and re-arms its watermark — "you looked" happens exactly on activation, never merely on staying mounted. */
  activate(id: string, items: readonly TranscriptItem[]): void {
    const tab = this.#tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    this.#activeId = id;
    if (tab.kind === 'file') {
      this.#dirty.delete(tab.path);
      this.#viewedUntil.set(tab.path, items.length);
    }
  }

  /**
   * Closes a file or diff tab. The transcript tab is permanent — a
   * `'transcript'` id (or any id that isn't currently open) is a no-op,
   * never a throw, matching this class's contract elsewhere. Closing the
   * active tab falls back to its nearest remaining neighbor, or the
   * transcript tab if it was the last one open — never leaves `activeId`
   * pointing at a tab that no longer exists.
   */
  close(id: string): void {
    if (id === TRANSCRIPT_TAB.id) return;
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const closing = this.#tabs[index]!;
    const wasActive = this.#activeId === id;
    this.#tabs = this.#tabs.filter((tab) => tab.id !== id);
    if (closing.kind === 'file') {
      this.#viewers.delete(closing.path);
      this.#dirty.delete(closing.path);
      this.#viewedUntil.delete(closing.path);
    } else if (closing.kind === 'diff') {
      this.#diffViewer = undefined;
      this.#hunkViewer = undefined;
    } else if (closing.kind === 'graph') {
      this.#graphViewer = undefined;
      this.#graphLoadingMore = false;
    }
    if (wasActive) {
      this.#activeId = (this.#tabs[Math.min(index, this.#tabs.length - 1)] ?? TRANSCRIPT_TAB).id;
    }
  }

  setViewer(path: string, state: FileTabViewerState): void {
    this.#viewers.set(path, state);
  }

  setDiffViewer(state: DiffTabViewerState): void {
    this.#diffViewer = state;
  }

  setHunkViewer(state: HunkTabViewerState): void {
    this.#hunkViewer = state;
  }

  setGraphViewer(state: GraphTabViewerState): void {
    this.#graphViewer = state;
  }

  setGraphLoadingMore(loading: boolean): void {
    this.#graphLoadingMore = loading;
  }

  /**
   * Appends one more page onto the commit graph tab's already-loaded
   * commits (issue #231's own paging contract — `computeCommitGraph`'s
   * `offset`/`nextOffset`), rather than replacing the list the way
   * {@link setGraphViewer} does for the FIRST page. A no-op page (called
   * before {@link openGraph} ever ran, or after the tab was closed) is
   * tolerated by starting from an empty list rather than throwing —
   * this method's own caller only ever reaches it from an in-flight
   * "Load more" click on an already-`'loaded'` viewer, but nothing here
   * assumes that stays true.
   */
  appendGraphPage(commits: readonly GitGraphCommitV1[], nextOffset: number | null): void {
    const existing = this.#graphViewer?.status === 'loaded' ? this.#graphViewer.commits : [];
    this.#graphViewer = { status: 'loaded', commits: [...existing, ...commits], nextOffset };
    this.#graphLoadingMore = false;
  }

  /**
   * Marks a file tab dirty once an agent edit lands on its path — "the
   * agent's own edit touched that file since you last looked" (issue
   * #737's own wording), where "since you last looked" is `items`'
   * length at that tab's last {@link activate} call (`#viewedUntil`), not
   * a wall-clock timestamp: two edits landing in the same millisecond,
   * or a resumed session whose clock skipped entirely, are still ordered
   * correctly because transcript position is what's compared, not time.
   * A tab currently `'loading'`/still on its very first fetch is included
   * — an edit that completes before that fetch resolves still counts as
   * "since you last looked" (there is nothing to have looked at yet).
   *
   * Called reactively (a `$effect` in the caller) whenever `items`
   * changes; cheap even on a long transcript, since each open tab only
   * scans its own unseen tail (`#viewedUntil` onward), not the whole
   * array, and a tab already dirty is skipped outright.
   */
  syncDirty(items: readonly TranscriptItem[]): void {
    for (const tab of this.#tabs) {
      if (tab.kind !== 'file' || this.#dirty.has(tab.path)) continue;
      const from = this.#viewedUntil.get(tab.path) ?? 0;
      for (let i = from; i < items.length; i++) {
        const item = items[i];
        if (
          item.type === 'tool_call' &&
          item.status === 'completed' &&
          item.diff?.path === tab.path
        ) {
          this.#dirty.add(tab.path);
          break;
        }
      }
    }
  }

  /** Back to just the transcript tab — a new session is a different canvas (mirrors `TranscriptTimeline`'s own `sessionKey` reset). */
  reset(): void {
    this.#tabs = [TRANSCRIPT_TAB];
    this.#activeId = TRANSCRIPT_TAB.id;
    this.#viewers.clear();
    this.#dirty.clear();
    this.#viewedUntil.clear();
    this.#diffViewer = undefined;
    this.#hunkViewer = undefined;
    this.#graphViewer = undefined;
    this.#graphLoadingMore = false;
  }
}
