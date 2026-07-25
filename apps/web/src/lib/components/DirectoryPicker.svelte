<script lang="ts">
  /**
   * The directory picker (SPEC §7.25's directory-picker feature, design
   * spec §3.1; issue #474): replaces `NewSessionDialog`'s bare `projectPath`
   * text input with a real browse-and-pick widget, driven by
   * `RelayClient.browseDirectory()` (the target-scoped `target_fs_list_
   * request`/`target_fs_list_response` pair, sealed under a per-target key
   * — see `@loombox/protocol`'s `target-fs.ts` doc comment). One widget for
   * both a `local` and a remote `ssh:` target: this component has no idea
   * which kind it's browsing, exactly like `FileTreePanel`'s own
   * target-agnostic contract.
   *
   * Unlike `FileTreePanel`'s always-expanded nested tree (a read-only
   * browser over a session's whole project), this is a PICKER: only the
   * current directory's entries are shown at once, breadcrumb-navigable
   * (click a segment, or type/edit the path directly and submit) — closer
   * to a native OS folder chooser than a file tree. Every navigation lazily
   * fetches only that one directory (issue #474's "lazy tree expansion"
   * acceptance): the whole point of the target-scoped protocol pair is
   * browsing BEFORE any session/worktree exists, so there is nothing to
   * eagerly walk. Landing on a directory (by any of the three routes below)
   * both shows its contents and reports it via `onChange` — wherever you
   * browse to IS the current pick, mirroring the plain text input's own
   * "whatever's typed there is `projectPath`" semantics it replaces.
   *
   * `client`/`nodeId`/`targetId` undefined (no target picked yet, or not
   * connected) renders a quiet empty prompt rather than erroring — mirrors
   * `NewSessionDialog`'s own "undefined client renders closed for content"
   * convention.
   */
  import type { FsEntryV1, TargetFsListResponsePayloadV1 } from '@loombox/protocol';
  import { addRecentPath, loadRecentPaths } from '$lib/recent-paths';
  import { Icon } from './icons';
  import WovenLoader from './WovenLoader.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  export interface DirectoryPickerClient {
    browseDirectory: (
      options: { nodeId: string; targetId: string; path: string },
      timeoutMs?: number,
    ) => Promise<TargetFsListResponsePayloadV1>;
  }

  interface Props {
    client: DirectoryPickerClient | undefined;
    nodeId: string | undefined;
    targetId: string | undefined;
    /** The currently chosen project path (controlled, like a plain `<input>`'s `value`) — updated via `onChange` as the user browses. */
    value: string;
    onChange: (path: string) => void;
    /** Overrides the manual-entry input's own `data-testid`, so an existing call-site selector (e.g. `NewSessionDialog`'s `new-session-project-path`) keeps working unchanged. */
    inputTestId?: string;
  }

  const {
    client,
    nodeId,
    targetId,
    value,
    onChange,
    inputTestId = 'directory-picker-input',
  }: Props = $props();

  type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

  let currentDir = $state<string | undefined>(undefined);
  let entries = $state<FsEntryV1[]>([]);
  let status = $state<LoadStatus>('idle');
  let loadError = $state<string | undefined>(undefined);
  // Seeded from `value` ONCE, on purpose: this is the editable "go to path"
  // field, so after mount it is the user's text, not a mirror of the prop.
  // The component is mounted fresh each time the dialog opens, which is
  // where a new starting `value` actually arrives.
  // svelte-ignore state_referenced_locally
  let pathInputValue = $state(value);
  let recentPaths = $state<string[]>([]);

  const scopeKey = $derived(nodeId && targetId ? `${nodeId}:${targetId}` : undefined);

  /** Joins `parent` (an absolute path, or `''`/`'.'` for "let the node pick") with a bare child name, without ever producing a doubled `//`. */
  function joinAbsolute(parent: string, name: string): string {
    if (parent === '' || parent === '.') return name;
    return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;
  }

  /** The clickable ancestry segments for `currentDir` (SPEC §7.25's "editable breadcrumb") — `''` (not yet resolved) renders none. */
  function breadcrumbSegments(path: string | undefined): { label: string; path: string }[] {
    if (!path) return [];
    const isAbsolute = path.startsWith('/');
    const parts = path.split('/').filter((part) => part !== '');
    const segments: { label: string; path: string }[] = [];
    let acc = isAbsolute ? '' : undefined;
    for (const part of parts) {
      acc = acc === undefined ? part : joinAbsolute(acc, part);
      segments.push({ label: part, path: isAbsolute ? `/${acc}` : acc });
    }
    return segments;
  }

  // Fresh browse whenever the selected target actually changes (a new
  // `scopeKey`) — never on every unrelated re-render, since `scopeKey` is
  // this effect's only reactive read besides the one-time `client` gate.
  // `reportSelection: false` — this initial browse only shows a starting
  // point (the target's own resolved home directory when `value` is still
  // blank); it must never itself call `onChange` and clobber a value the
  // caller/user sets in the meantime (e.g. typing immediately after picking
  // a target, before this async round trip resolves — the race this
  // component's own tests caught).
  $effect(() => {
    if (!scopeKey || !client) return;
    currentDir = undefined;
    entries = [];
    status = 'idle';
    loadError = undefined;
    recentPaths = loadRecentPaths(scopeKey);
    void navigate(value.trim(), { reportSelection: false });
  });

  async function navigate(
    path: string,
    options: { reportSelection?: boolean } = {},
  ): Promise<void> {
    if (!client || !nodeId || !targetId) return;
    const reportSelection = options.reportSelection ?? true;
    status = 'loading';
    loadError = undefined;
    try {
      const result = await client.browseDirectory({ nodeId, targetId, path });
      if (result.outcome === 'error') {
        status = 'error';
        loadError = result.message;
        return;
      }
      currentDir = result.path;
      entries = result.entries;
      pathInputValue = result.path;
      status = 'loaded';
      if (reportSelection) {
        onChange(result.path);
        if (scopeKey) recentPaths = addRecentPath(scopeKey, result.path);
      }
    } catch (error) {
      status = 'error';
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * `Enter` navigates — not a real `<form>`/`onsubmit` (this component is
   * meant to sit inside a caller's own `<form>`, e.g. `NewSessionDialog`'s
   * `session-form`, and nested `<form>` elements are invalid HTML that
   * scrambles which submit button/handler a browser actually routes a
   * click to).
   */
  function handlePathKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void navigate(pathInputValue.trim());
  }

  /**
   * Every keystroke reports the raw typed value via `onChange` immediately
   * — mirroring the plain `<input>` this component replaces ("whatever's
   * typed there is `projectPath`"), so a caller's `canSubmit`/final
   * `createSession` call sees it right away. Browsing (refreshing the
   * breadcrumb/tree below) only happens on an explicit navigation action
   * (submitting this field, or clicking a breadcrumb/entry/recent-path),
   * never on every keystroke — typing a path is not itself a `browseDirectory`
   * round trip.
   */
  function handlePathInput(event: Event & { currentTarget: HTMLInputElement }): void {
    pathInputValue = event.currentTarget.value;
    onChange(pathInputValue);
  }

  function handleEntryClick(entry: FsEntryV1): void {
    if (entry.kind !== 'dir' || currentDir === undefined) return;
    void navigate(joinAbsolute(currentDir, entry.name));
  }
</script>

<div class="directory-picker" data-testid="directory-picker">
  {#if !client || !nodeId || !targetId}
    <p class="hint" data-testid="directory-picker-no-target">
      Pick a target to browse its folders.
    </p>
  {:else}
    <div class="path-form">
      <label for="directory-picker-path" class="visually-hidden">Project folder</label>
      <input
        id="directory-picker-path"
        type="text"
        placeholder="/home/you/project"
        value={pathInputValue}
        oninput={handlePathInput}
        onkeydown={handlePathKeydown}
        data-testid={inputTestId}
      />
    </div>

    {#if breadcrumbSegments(currentDir).length > 0}
      <nav class="breadcrumb" aria-label="Current folder" data-testid="directory-picker-breadcrumb">
        <button
          type="button"
          class="crumb crumb-root"
          onclick={() => navigate('/')}
          data-testid="directory-picker-breadcrumb-segment"
        >
          /
        </button>
        {#each breadcrumbSegments(currentDir) as segment (segment.path)}
          <span class="crumb-sep" aria-hidden="true">/</span>
          <button
            type="button"
            class="crumb"
            onclick={() => navigate(segment.path)}
            data-testid="directory-picker-breadcrumb-segment"
          >
            {segment.label}
          </button>
        {/each}
      </nav>
    {/if}

    {#if recentPaths.length > 0}
      <div class="recent" data-testid="directory-picker-recent">
        <span class="recent-label">Recent</span>
        {#each recentPaths as recentPath (recentPath)}
          <button
            type="button"
            class="recent-path"
            onclick={() => navigate(recentPath)}
            data-testid="directory-picker-recent-path"
          >
            {recentPath}
          </button>
        {/each}
      </div>
    {/if}

    <div class="entries" data-testid="directory-picker-entries">
      {#if status === 'loading'}
        <p class="status-line" data-testid="directory-picker-loading">
          <WovenLoader size="sm" label="Loading directory" />
          Loading…
        </p>
      {:else if status === 'error'}
        <ErrorNotice message={loadError ?? 'Failed to load this directory.'} />
      {:else if status === 'loaded' && entries.length === 0}
        <p class="hint" data-testid="directory-picker-empty">This folder is empty.</p>
      {:else if status === 'loaded'}
        <ul class="entry-list">
          {#each entries as entry (entry.name)}
            <li>
              {#if entry.kind === 'dir'}
                <button
                  type="button"
                  class="entry entry-dir"
                  onclick={() => handleEntryClick(entry)}
                  data-testid="directory-picker-entry"
                >
                  <span class="entry-icon" aria-hidden="true"
                    ><Icon name="folder" size="100%" /></span
                  >
                  <span class="entry-name">{entry.name}</span>
                </button>
              {:else}
                <span class="entry entry-file" data-testid="directory-picker-file">
                  <span class="entry-icon" aria-hidden="true"><Icon name="file" size="100%" /></span
                  >
                  <span class="entry-name">{entry.name}</span>
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .directory-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .hint {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .path-form input {
    width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: inherit;
    font-family: var(--font-mono);
    font-size: var(--text-body-size);
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .path-form input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .breadcrumb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3xs);
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
  }

  .crumb {
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: var(--space-3xs) var(--space-2xs);
    border-radius: var(--radius-sm);
    font: inherit;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .crumb:hover {
    background: var(--color-fill-subtle);
    color: var(--color-text-primary);
  }

  .crumb:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: -1px;
  }

  .crumb-sep {
    color: var(--color-text-muted);
  }

  .recent {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2xs);
    font-size: var(--text-small-size);
  }

  .recent-label {
    color: var(--color-text-muted);
  }

  .recent-path {
    border: 1px solid var(--color-border-subtle);
    background: var(--color-fill-subtle);
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: var(--space-3xs) var(--space-xs);
    border-radius: var(--radius-full);
    font: inherit;
    font-family: var(--font-mono);
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      color var(--duration-fast) var(--ease-beat);
  }

  .recent-path:hover {
    background: var(--color-fill-hover);
    color: var(--color-text-primary);
  }

  .recent-path:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: -1px;
  }

  .entries {
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-2xs);
  }

  .status-line {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .entry-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .entry {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    width: 100%;
    border: none;
    background: transparent;
    text-align: left;
    padding: var(--space-2xs) var(--space-xs);
    border-radius: var(--radius-sm);
    font: inherit;
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
  }

  .entry-dir {
    color: var(--color-text-primary);
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .entry-dir:hover {
    background: var(--color-fill-subtle);
  }

  .entry-dir:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: -2px;
  }

  .entry-file {
    color: var(--color-text-muted);
  }

  .entry-icon {
    display: inline-flex;
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
  }

  .entry-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
