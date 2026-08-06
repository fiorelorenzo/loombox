<script lang="ts">
  /**
   * The `@` mention picker (issue #742, decisions doc C2-3) — the full
   * picker over four sources: files and directories (one "Files" tab, the
   * same file-tree corpus `FileTreePanel.svelte` renders,
   * `RelayClient.fileTreeFor`/`expandDirectory`, SPEC §7.4/§7.25), past
   * sessions in the same project searched by title, and tracker items in
   * the same project searched by id or title — the last two are something
   * Zed cannot do at all, since it has no built-in tracker. Supersedes the
   * files-only `FileReferencePicker.svelte` (issue #160): same fuzzy
   * matcher (`$lib/fuzzy.ts`), same arrow-key/Enter/Esc handling, same
   * `Dialog` chrome, now with a source-tab strip and two more searchable
   * lists.
   *
   * Picking a result never inserts text — it calls `onSelect` with a fully
   * resolved {@link MentionRef}; the caller (`+page.svelte`) turns that into
   * a removable pill above the composer, never characters in the draft
   * (issue #742's "pills ... survive editing the surrounding text": there
   * is no surrounding text to survive, the reference isn't inside it).
   *
   * Keyboard-first (issue #742's acceptance): typing filters the active
   * tab's results; ↑/↓ moves the active result; Enter picks it; Tab/
   * Shift+Tab (while the search input has focus) cycles the source tab
   * without ever leaving the input, since arrow keys are already spoken
   * for by result navigation; Esc closes without picking anything — same
   * stop-propagation note as `FileReferencePicker.svelte` carried: this
   * component owns Esc on its own input, ahead of `Overlay`'s own
   * Esc-closes-the-backdrop handling, so a single keypress doesn't fire
   * `onClose` twice.
   */
  import { fuzzyFilter } from '../fuzzy';
  import { flattenLoadedEntries, joinTreePath, type FlatFileEntry } from '../file-tree';
  import {
    directoryMention,
    fileMention,
    sessionMention,
    trackerMention,
    type MentionRef,
  } from '../mentions';
  import type {
    ClientSessionMeta,
    FileTreeDirectoryState,
    TrackerSnapshotState,
  } from '../relay-client';
  import {
    buildTrackerTypeRegistryV1,
    resolveRoleValue,
    type TrackerRecordV1,
  } from '@loombox/protocol';
  import { Icon, type IconName } from './icons';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';

  /** The narrow slice of `RelayClient` this picker needs — mirrors `TrackerPage.svelte`'s own `TrackerPageClient` narrowing so a test injects a plain fake with no crypto/WebSocket machinery. */
  export interface MentionPickerClient {
    trackerSnapshotFor: (
      nodeId: string,
      projectPath: string,
    ) => import('svelte/store').Readable<TrackerSnapshotState>;
  }

  type SourceTab = 'files' | 'sessions' | 'tracker';

  const TABS: { id: SourceTab; label: string }[] = [
    { id: 'files', label: 'Files' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'tracker', label: 'Tracker' },
  ];

  interface Props {
    open: boolean;
    tree: Map<string, FileTreeDirectoryState>;
    onExpand: (path: string) => void;
    /** Every session this account currently knows about; filtered down to the current project (minus the current session itself) below. */
    sessions: ClientSessionMeta[];
    currentSessionId: string | undefined;
    /** The current session's project — undefined disables the Sessions/Tracker tabs (nothing to scope them to yet). */
    projectContext: { nodeId: string; projectPath: string } | undefined;
    client: MentionPickerClient;
    onSelect: (mention: MentionRef) => void;
    onClose: () => void;
  }

  const {
    open,
    tree,
    onExpand,
    sessions,
    currentSessionId,
    projectContext,
    client,
    onSelect,
    onClose,
  }: Props = $props();

  /** Per-open cap on how many not-yet-loaded directories this picker will auto-expand — see this component's own doc comment (mirrors `FileReferencePicker.svelte`'s identical cap/rationale). */
  const MAX_AUTO_EXPAND = 200;

  let activeTab = $state<SourceTab>('files');
  let query = $state('');
  let activeIndex = $state(0);
  let autoExpandedCount = 0;
  let trackerSnapshot = $state<TrackerSnapshotState>({ status: 'loaded', records: [], types: [] });

  $effect(() => {
    if (!open || !projectContext) return;
    const unsubscribe = client
      .trackerSnapshotFor(projectContext.nodeId, projectContext.projectPath)
      .subscribe((value) => (trackerSnapshot = value));
    return unsubscribe;
  });

  const fileEntries = $derived(flattenLoadedEntries(tree));
  const fileResults = $derived(fuzzyFilter(fileEntries, query, (entry) => entry.path));

  const projectSessions = $derived(
    projectContext
      ? sessions.filter(
          (session) =>
            session.id !== currentSessionId && session.projectPath === projectContext.projectPath,
        )
      : [],
  );
  const sessionResults = $derived(fuzzyFilter(projectSessions, query, (session) => session.title));

  interface TrackerCandidate {
    record: TrackerRecordV1;
    label: string;
  }
  const trackerRegistry = $derived(buildTrackerTypeRegistryV1(trackerSnapshot.types));
  const trackerCandidates = $derived<TrackerCandidate[]>(
    trackerSnapshot.records
      .filter((record) => !record.archived)
      .map((record) => {
        const titleValue = resolveRoleValue(record, trackerRegistry, 'title');
        const title =
          typeof titleValue === 'string' && titleValue.length > 0 ? titleValue : undefined;
        return {
          record,
          label: title ? `#${record.issueNumber} ${title}` : `#${record.issueNumber}`,
        };
      }),
  );
  const trackerResults = $derived(
    fuzzyFilter(trackerCandidates, query, (candidate) => candidate.label),
  );

  const activeResultsLength = $derived(
    activeTab === 'files'
      ? fileResults.length
      : activeTab === 'sessions'
        ? sessionResults.length
        : trackerResults.length,
  );

  $effect(() => {
    if (activeIndex >= activeResultsLength) activeIndex = Math.max(0, activeResultsLength - 1);
  });

  $effect(() => {
    if (open) {
      query = '';
      activeIndex = 0;
      autoExpandedCount = 0;
      activeTab = 'files';
    }
  });

  // The opportunistic "walk what's reachable" pass `FileReferencePicker.svelte`
  // originated — reruns whenever `tree` gains a newly-loaded directory (a
  // fresh Map reference from `RelayClient`), so each wave of loads can
  // reveal, and then queue, the next one, until everything reachable (or
  // the cap) is hit.
  $effect(() => {
    if (!open) return;
    for (const dir of tree.values()) {
      if (dir.status !== 'loaded') continue;
      for (const entry of dir.entries) {
        if (entry.kind !== 'dir') continue;
        const path = joinTreePath(dir.path, entry.name);
        if (tree.has(path)) continue;
        if (autoExpandedCount >= MAX_AUTO_EXPAND) return;
        autoExpandedCount += 1;
        onExpand(path);
      }
    }
  });

  function iconFor(entry: FlatFileEntry): IconName {
    return entry.kind === 'dir' ? 'folder' : 'file';
  }

  function activateFile(entry: FlatFileEntry): void {
    onSelect(entry.kind === 'dir' ? directoryMention(entry.path) : fileMention(entry.path));
    onClose();
  }

  function activateSession(session: ClientSessionMeta): void {
    onSelect(sessionMention(session.id, session.title));
    onClose();
  }

  function activateTracker(candidate: TrackerCandidate): void {
    if (!projectContext) return;
    onSelect(
      trackerMention(
        projectContext.nodeId,
        projectContext.projectPath,
        candidate.record.id,
        candidate.label,
      ),
    );
    onClose();
  }

  function activateAt(index: number): void {
    if (activeTab === 'files') {
      const entry = fileResults[index];
      if (entry) activateFile(entry);
    } else if (activeTab === 'sessions') {
      const session = sessionResults[index];
      if (session) activateSession(session);
    } else {
      const candidate = trackerResults[index];
      if (candidate) activateTracker(candidate);
    }
  }

  function cycleTab(direction: 1 | -1): void {
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    const next = TABS[(index + direction + TABS.length) % TABS.length];
    if (next) {
      activeTab = next.id;
      activeIndex = 0;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Stop here rather than let it bubble to Overlay's own Esc handler —
      // both would otherwise call onClose for the same keypress (see this
      // component's own doc comment).
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = activeResultsLength === 0 ? 0 : (activeIndex + 1) % activeResultsLength;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex =
        activeResultsLength === 0
          ? 0
          : (activeIndex - 1 + activeResultsLength) % activeResultsLength;
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateAt(activeIndex);
    }
  }
</script>

{#snippet pickerHeader()}
  <div class="picker-tabs" role="tablist" aria-label="Reference kind">
    {#each TABS as tab (tab.id)}
      <button
        type="button"
        class="picker-tab"
        class:active={activeTab === tab.id}
        role="tab"
        aria-selected={activeTab === tab.id}
        tabindex={-1}
        onclick={() => {
          activeTab = tab.id;
          activeIndex = 0;
        }}
        data-testid={`mention-picker-tab-${tab.id}`}
      >
        {tab.label}
      </button>
    {/each}
  </div>
  <input
    type="text"
    class="picker-input"
    placeholder={activeTab === 'files'
      ? 'Reference a file or directory…'
      : activeTab === 'sessions'
        ? 'Search past sessions by title…'
        : 'Search tracker items by id or title…'}
    aria-label="Mention search"
    bind:value={query}
    onkeydown={handleKeydown}
    data-testid="mention-picker-input"
  />
{/snippet}

{#snippet pickerBody()}
  {#if activeTab === 'files'}
    {#if fileResults.length === 0}
      <EmptyState message="No matching files or directories." />
    {:else}
      <ul class="picker-results" role="listbox">
        {#each fileResults as entry, index (entry.path)}
          <li>
            <button
              type="button"
              class="picker-item"
              class:active={index === activeIndex}
              role="option"
              aria-selected={index === activeIndex}
              onmouseenter={() => (activeIndex = index)}
              onclick={() => activateFile(entry)}
              data-testid="mention-picker-item"
            >
              <span class="entry-icon" aria-hidden="true">
                <Icon name={iconFor(entry)} size="100%" />
              </span>
              <span class="entry-label">{entry.path}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if activeTab === 'sessions'}
    {#if !projectContext}
      <EmptyState message="No project to search sessions in yet." />
    {:else if sessionResults.length === 0}
      <EmptyState message="No matching sessions in this project." />
    {:else}
      <ul class="picker-results" role="listbox">
        {#each sessionResults as session, index (session.id)}
          <li>
            <button
              type="button"
              class="picker-item"
              class:active={index === activeIndex}
              role="option"
              aria-selected={index === activeIndex}
              onmouseenter={() => (activeIndex = index)}
              onclick={() => activateSession(session)}
              data-testid="mention-picker-item"
            >
              <span class="entry-icon" aria-hidden="true">
                <Icon name="sessions" size="100%" />
              </span>
              <span class="entry-label">{session.title}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if !projectContext}
    <EmptyState message="No project to search the tracker in yet." />
  {:else if trackerSnapshot.status === 'loading'}
    <EmptyState message="Loading the tracker…" />
  {:else if trackerResults.length === 0}
    <EmptyState message="No matching tracker items." />
  {:else}
    <ul class="picker-results" role="listbox">
      {#each trackerResults as candidate, index (candidate.record.id)}
        <li>
          <button
            type="button"
            class="picker-item"
            class:active={index === activeIndex}
            role="option"
            aria-selected={index === activeIndex}
            onmouseenter={() => (activeIndex = index)}
            onclick={() => activateTracker(candidate)}
            data-testid="mention-picker-item"
          >
            <span class="entry-icon" aria-hidden="true">
              <Icon name="tracker" size="100%" />
            </span>
            <span class="entry-label">{candidate.label}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet pickerFooter()}
  <div class="picker-hints">
    <span>↑↓ navigate</span>
    <span>Tab switch source</span>
    <span>Enter attach</span>
    <span>Esc close</span>
  </div>
{/snippet}

<Dialog
  {open}
  label="Reference a file, directory, session, or tracker item"
  {onClose}
  size="md"
  class="mention-picker-panel"
  header={pickerHeader}
  children={pickerBody}
  footer={pickerFooter}
/>

<style>
  :global(.mention-picker-panel) {
    width: min(30rem, 92vw);
    max-height: 60vh;
  }

  .picker-tabs {
    display: flex;
    gap: var(--space-3xs);
    padding: var(--space-3xs) var(--space-3xs) 0;
  }

  .picker-tab {
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    font-size: var(--text-small-size);
    cursor: pointer;
  }

  .picker-tab.active {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border-subtle);
    color: var(--color-text-primary);
  }

  .picker-input {
    padding: var(--space-sm) var(--space-3xs);
    border: none;
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-body-size);
    background: transparent;
    color: inherit;
    font-family: inherit;
  }

  .picker-input::placeholder {
    color: var(--color-text-muted);
  }

  .picker-input:focus {
    outline: none;
  }

  .picker-results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
  }

  .picker-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    text-align: left;
    border: none;
    border-left: 2px solid transparent;
    background: transparent;
    color: inherit;
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--text-small-size);
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat);
  }

  .picker-item:not(:disabled):active {
    transform: scale(0.995);
  }

  .picker-item.active {
    background: var(--color-accent-subtle);
    border-left-color: var(--color-accent);
  }

  .entry-icon {
    flex-shrink: 0;
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    color: var(--color-text-secondary);
  }

  .picker-item.active .entry-icon {
    color: var(--color-accent);
  }

  .entry-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .picker-hints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
  }
</style>
