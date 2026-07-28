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
   *
   * IA v4 (design spec §3.4; issue #507): `NewSessionDialog` dropped this
   * component entirely: a project's folder is now picked once, in
   * `AddProjectDialog`, and every session after that just inherits it.
   * `onChange`'s second argument (`isGitRepo`) is what that dialog reads to
   * fill in `NewProject.isGitRepo`; the "Git repository" marker below is
   * the same signal shown inline, since it's what decides whether SPEC
   * §7.1's worktree choice appears later. Both read `targetFsListResultV1
   * .gitRepo` (`@loombox/protocol`), optional so an older node simply
   * omits it: treated as "unknown", never as "not a repo".
   *
   * A transport failure (a timed-out `browseDirectory`, no open connection,
   * ...) gets a human, retryable `ErrorNotice` rather than that rejected
   * promise's own wire-phrased `Error#message` (issue #505); see
   * `navigate`'s `catch` block for the reasoning.
   *
   * Coherence v5 migration (design spec §1, issue #508): the manual "go to
   * path" field now composes the shared `ui/Input` primitive instead of a
   * hand-rolled `<input>` (its own visually-hidden `<label for>` stays —
   * `Field` isn't used here since `AddProjectDialog`, this component's only
   * caller, already renders a visible grouped label around the whole
   * widget). Also fixes `.recent-path:hover`'s reference to the
   * never-defined `--color-fill-hover` (issue #508's §5 token-hygiene
   * finding) by switching to `--color-fill-subtle`, matching every sibling
   * hover rule in this file.
   */
  import type { FsEntryV1, TargetFsListResponsePayloadV1 } from '@loombox/protocol';
  import { untrack } from 'svelte';
  import { addRecentPath, loadRecentPaths } from '$lib/recent-paths';
  import { Icon } from './icons';
  import WovenLoader from './WovenLoader.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Input from './ui/Input.svelte';

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
    /**
     * Reports the path (mirrors a plain `<input>`'s `value` contract: fires
     * on every keystroke too, not only a real navigation) plus, when known,
     * whether IT sits inside a git work tree, `AddProjectDialog`'s only
     * source for `NewProject.isGitRepo` (design spec §3.4; issue #507). The
     * second argument is only ever passed after a real `browseDirectory`
     * round trip resolves (a typed-but-unbrowsed path has no known git
     * status yet); omitted entirely rather than passed as an explicit
     * `undefined` on those keystroke calls, so a caller that only ever
     * cared about the path (this component's own pre-#507 contract) keeps
     * working unchanged.
     */
    onChange: (path: string, isGitRepo?: boolean) => void;
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
  /**
   * Whether the CURRENTLY DISPLAYED directory (`currentDir`) sits inside a
   * git work tree: set from every successful listing, including the
   * passive initial landing (unlike `onChange`, which only fires on a real
   * pick; see that prop's own doc comment), since the "Git repository"
   * marker below describes whatever's on screen right now, not only an
   * explicit choice. `undefined` before the first listing, on error, or
   * when a node too old to report the field answers anyway.
   */
  let gitRepo = $state<boolean | undefined>(undefined);
  /** `true` only for a caught transport failure (issue #505): a structured `{outcome:'error'}` reply already carries its own human `message` and never gets a Retry (retrying an unreadable/nonexistent directory wouldn't help). */
  let loadErrorRetryable = $state(false);
  /** The most recent `navigate()` call's own arguments, so Retry can re-attempt the SAME one rather than reloading `currentDir` (which, on a failed navigation, is still the previous, successful, directory, not the one that just failed). Plain, not `$state`: read only from `retryLoad`'s own event handler, never from the template. */
  let lastAttempt: { path: string; reportSelection: boolean } | undefined;

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
  // `scopeKey`). Never on every unrelated re-render: `scopeKey`/`client`
  // are this effect's only REACTIVE reads; `value` is read once via
  // `untrack` below (issue #507's `AddProjectDialog`, the first caller
  // that reactively binds `value` back to its own state on every
  // keystroke, is what surfaced why that matters: without `untrack` this
  // effect would re-fire, and passively re-browse, on every keystroke,
  // not only a real target change). `reportSelection: false`: this
  // initial browse only shows a starting point (the target's own resolved
  // home directory when `value` is still blank); it must never itself
  // call `onChange` and clobber a value the caller/user sets in the
  // meantime (e.g. typing immediately after picking a target, before this
  // async round trip resolves; the race this component's own tests
  // caught).
  $effect(() => {
    if (!scopeKey || !client) return;
    currentDir = undefined;
    entries = [];
    status = 'idle';
    loadError = undefined;
    loadErrorRetryable = false;
    gitRepo = undefined;
    recentPaths = loadRecentPaths(scopeKey);
    void navigate(untrack(() => value).trim(), { reportSelection: false });
  });

  async function navigate(
    path: string,
    options: { reportSelection?: boolean } = {},
  ): Promise<void> {
    if (!client || !nodeId || !targetId) return;
    const reportSelection = options.reportSelection ?? true;
    lastAttempt = { path, reportSelection };
    status = 'loading';
    loadError = undefined;
    loadErrorRetryable = false;
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
      gitRepo = result.gitRepo;
      status = 'loaded';
      if (reportSelection) {
        onChange(result.path, result.gitRepo);
        if (scopeKey) recentPaths = addRecentPath(scopeKey, result.path);
      }
    } catch (error) {
      // A rejected `browseDirectory` (a timed-out request, no open
      // connection, ...) is a transport failure the node never got to
      // answer at all: its `Error#message` is wire/internal phrasing
      // (e.g. "RelayClient: timed out waiting for target_fs_list_response",
      // issue #505) written for a developer console, not this screen. A
      // sleeping laptop, a dropped node, or a relay too old to answer are
      // all normal here, so this gets a real, retryable state instead of
      // leaking that identifier: the real message still reaches a
      // developer via `console.warn`.
      console.warn('DirectoryPicker: browseDirectory failed', error);
      status = 'error';
      loadError =
        "This folder didn't respond in time. The node may be asleep, offline, or on an older relay.";
      loadErrorRetryable = true;
    }
  }

  /** Re-attempts the exact navigation that just failed (issue #505), not simply re-reading `currentDir`, which on a failed navigation is still the previous, successful directory (`navigate` never overwrites it on error), not the one that actually needs retrying. */
  function retryLoad(): void {
    if (!lastAttempt) return;
    void navigate(lastAttempt.path, { reportSelection: lastAttempt.reportSelection });
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
      <Input
        id="directory-picker-path"
        monospace
        value={pathInputValue}
        oninput={handlePathInput}
        onkeydown={handlePathKeydown}
        placeholder="/home/you/project"
        dataTestId={inputTestId}
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

    {#if status === 'loaded' && gitRepo === true}
      <p class="git-marker" data-testid="directory-picker-git-badge">
        <Icon name="check" size="0.85em" />
        Git repository
      </p>
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
        <ErrorNotice
          message={loadError ?? 'Failed to load this directory.'}
          retryable={loadErrorRetryable}
          onRetry={retryLoad}
        />
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

  .git-marker {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
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
    background: var(--color-fill-subtle);
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
