<script lang="ts">
  /**
   * The canvas tab strip's file viewer AND light quick-edit surface
   * (issue #205; SPEC §7.4's "integrated editor with syntax highlighting
   * and light quick-edit" — explicitly not a full IDE, SPEC §11: no
   * LSP, no multi-file refactor). Started life as issue #737's
   * read-only `FileViewer`; this issue adds the edit half on top of the
   * exact same rendering pipeline, never a second one.
   *
   * View mode (default) renders exactly like the former read-only
   * viewer did — `$lib/file-viewer.ts`'s `fenceWrapFileContent` (built
   * on `$lib/diff.ts`'s `languageForPath`, the same language guess
   * `DiffViewer` already derives for its own per-line coloring class)
   * feeds `$lib/markdown.ts`'s `renderMarkdownToHtml`/
   * `highlightMarkdownToHtml` pipeline, the exact lazy-loaded
   * highlighter #600 built for a transcript's own fenced code blocks.
   * Edit mode swaps that highlighted read view for a plain monospace
   * `TextArea` — no live syntax highlighting while typing (SPEC §11's
   * "not a full IDE" boundary), matching `AgentInstructionsPanel`'s own
   * "a single free-text editor, not a rich one" shape.
   *
   * Save is conflict-safe, never last-write-wins (issue #205's own "an
   * editor that silently loses a write is worse than a read-only
   * viewer" acceptance): `baseHash` is the hash `viewer.content` was
   * loaded at (`fsReadResultV1`'s own `hash`), sent back on save exactly
   * like `AgentInstructionsPanel`'s `setAgentInstructions` call. A save
   * that lands after the file changed underneath — another device, a
   * human editing on disk, or the session's own agent mid-turn — comes
   * back `outcome: 'conflict'`; this component NEVER retries with the
   * new hash on its own, it shows what's actually on disk now and
   * requires an explicit "Reload latest version" click (reusing the
   * same `onRetry` the read-only viewer already used for a failed load)
   * before saving again.
   *
   * `stale` (issue #737's own agent-edit dirty tracking,
   * `CanvasTabsState.isDirty`) is a PROACTIVE warning only, reused
   * rather than reinvented — it can miss a change that happened while
   * this tab wasn't the active one. The `baseHash` conflict check above
   * is the actual "never overwrite blindly" guarantee, regardless of
   * whether this flag caught it first; this is deliberate, not a gap:
   * the same mechanism covers a stranger's edit, a human editing on
   * disk, and the session's own agent uniformly, with no special case
   * for who made the change.
   *
   * A file the node reported `truncated: true` for cannot be edited —
   * the editor never has the file's real full text to save back, so
   * editing it would silently drop everything past the viewer's own
   * byte cap the moment "Save" clobbered the untruncated remainder.
   * That file stays view-only, same as before this issue.
   *
   * Switching away from this tab (or the session) discards an unsaved
   * draft without confirmation — the same explicitly-accepted
   * limitation `AgentInstructionsPanel`'s own doc comment already
   * documents for the identical reason (a single free-text editor, not
   * a form with autosave/an "unsaved changes" guard); out of scope here
   * too. Not a full IDE (SPEC §11): no create-new-file flow, no
   * rename/delete, no line-level conflict merge UI — a conflict shows
   * what's on disk now and asks the user to reload and re-apply by
   * hand.
   */
  import { fenceWrapFileContent } from '$lib/file-viewer';
  import { highlightMarkdownToHtml, renderMarkdownToHtml } from '$lib/markdown';
  import type { FileTabViewerState } from '$lib/tabs.svelte';
  import type { FsWriteResponsePayloadV1 } from '@loombox/protocol';
  import CopyButton from './CopyButton.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import Button from './ui/Button.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import TextArea from './ui/TextArea.svelte';

  interface Props {
    path: string;
    name: string;
    viewer: FileTabViewerState;
    /** Re-runs the same `readFile` this tab opened with — a failed load's only recovery action, and a conflict's own "discard my draft, show me what's actually there now" action. */
    onRetry: () => void;
    /** Whether the session's agent has edited this file since the tab was last activated (issue #737's `CanvasTabsState.isDirty`) — a proactive "reload before you save" warning; see the file doc comment for why this is advisory, not the enforcement. */
    stale: boolean;
    /** Saves `content` back to the node if `baseHash` still matches what's on disk (issue #205). */
    onSave: (path: string, content: string, baseHash: string) => Promise<FsWriteResponsePayloadV1>;
  }

  const { path, name, viewer, onRetry, stale, onSave }: Props = $props();

  // ---- view-mode rendering (unchanged from issue #737's FileViewer) ----
  // The same sync-plain-then-async-highlighted split `MessageItem.svelte`'s
  // `rendered` derivation uses (see that component's own doc comment):
  // `renderMarkdownToHtml` is synchronous and never highlights, so it is
  // always ready the instant `viewer.content` changes; `highlightMarkdownToHtml`
  // is the async upgrade that lands once its dynamic `import()`s resolve.
  // `destroyed` guards a highlight request that resolves after this
  // instance unmounts (e.g. the tab was closed) from writing into
  // `highlightedHtml` after the fact.
  let lastSource = '';
  let plainHtml = '';
  let highlightedForSource = '';
  let highlightedHtml = $state('');
  let destroyed = false;

  function requestHighlight(source: string): void {
    void highlightMarkdownToHtml(source).then((html) => {
      if (html === null || destroyed || source !== lastSource) return;
      highlightedForSource = source;
      highlightedHtml = html;
    });
  }

  const rendered = $derived.by(() => {
    if (viewer.status !== 'loaded') return '';
    const source = fenceWrapFileContent(path, viewer.content);
    if (source !== lastSource) {
      lastSource = source;
      plainHtml = renderMarkdownToHtml(source);
      requestHighlight(source);
    }
    // Read unconditionally, before the branch that decides whether to use
    // it — see `MessageItem.svelte`'s identical `rendered` derivation for
    // why: Svelte only subscribes to the `$state` a derivation actually
    // reads on a given run, and a ternary short-circuits its untaken
    // branch, so gating this read behind the `highlightedForSource`
    // check below would mean `rendered` never re-runs the first time
    // highlighting actually lands (its own write happens on a run where
    // the check was still false, so nothing ever subscribed).
    const upgraded = highlightedHtml;
    return highlightedForSource === lastSource ? upgraded : plainHtml;
  });

  $effect(() => {
    return () => {
      destroyed = true;
    };
  });

  // ---- edit-mode state (issue #205) ----
  let mode = $state<'view' | 'edit'>('view');
  let draft = $state('');
  let baseHash = $state('');
  let saving = $state(false);
  let saveError = $state<string | undefined>(undefined);
  /** `undefined`: no conflict. `null`: the file was deleted underneath the last save attempt. Otherwise what's actually on disk now (`fsWriteConflictV1`'s own `current`). */
  let conflict = $state<{ content: string; hash: string; truncated: boolean } | null | undefined>(
    undefined,
  );

  // A fresh load landing for THIS path (a first open, or an explicit
  // reload/retry) resets the draft to it — but only then, never on an
  // unrelated re-render, so an in-progress edit is never clobbered
  // underneath the user. `openedFor` is a plain (non-reactive) local,
  // the same bookkeeping trick `lastSource` above already uses, rather
  // than folding this into a `$derived`: a derivation must stay pure,
  // and resetting several `$state` fields as a side effect belongs in
  // an `$effect`. Keyed on `path` AND `viewer.hash` together — reusing
  // this same mounted instance for a different open tab (no `{#key}`
  // wraps it; see the canvas host) changes `path` without necessarily
  // changing `hash`, and re-reading the SAME still-open tab changes
  // `hash` without changing `path`; either alone must reset the draft.
  let openedFor = '';
  $effect(() => {
    if (viewer.status !== 'loaded') return;
    const key = `${path}:${viewer.hash}`;
    if (key === openedFor) return;
    openedFor = key;
    mode = 'view';
    draft = viewer.content;
    baseHash = viewer.hash;
    saving = false;
    saveError = undefined;
    conflict = undefined;
  });

  function startEdit(): void {
    mode = 'edit';
  }

  function cancelEdit(): void {
    if (viewer.status === 'loaded') draft = viewer.content;
    mode = 'view';
    saveError = undefined;
    conflict = undefined;
  }

  async function handleSave(): Promise<void> {
    saving = true;
    saveError = undefined;
    conflict = undefined;
    try {
      const response = await onSave(path, draft, baseHash);
      if (response.outcome === 'ok') {
        baseHash = response.hash;
        mode = 'view';
      } else if (response.outcome === 'conflict') {
        conflict = response.current;
      } else {
        saveError = response.message;
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  /** Discards the stale draft and re-fetches from the node — the only way past a conflict, mirroring `AgentInstructionsPanel`'s identical "never silently clobber" contract. */
  function reloadLatest(): void {
    conflict = undefined;
    onRetry();
  }
</script>

<div class="file-editor" data-testid="file-editor">
  <div class="file-editor-header">
    <span class="file-editor-path font-mono" data-testid="file-editor-path">{path}</span>
    {#if viewer.status === 'loaded' && mode === 'view'}
      <CopyButton text={viewer.content} label={`Copy ${name}`} revealOnHover />
      {#if !viewer.truncated}
        <Button variant="secondary" size="sm" onclick={startEdit} dataTestId="file-editor-edit">
          Edit
        </Button>
      {/if}
    {/if}
  </div>

  {#if viewer.status === 'loading'}
    <div class="file-editor-loading" data-testid="file-editor-loading">
      <WovenLoader size="md" label={`Loading ${name}`} />
    </div>
  {:else if viewer.status === 'error'}
    <div class="file-editor-error">
      <ErrorNotice message={viewer.message} retryable {onRetry} />
    </div>
  {:else if mode === 'view'}
    {#if viewer.truncated}
      <p class="file-editor-truncated" data-testid="file-editor-truncated">
        Truncated — this file is larger than the viewer shows, so it can't be edited here.
      </p>
    {/if}
    <!-- `rendered` is our own $lib/markdown pipeline's sanitised output
       (rehype-sanitize + the fixed rehype-highlight/target-blank plugin
       chain — see that module's doc comment), never raw file text. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="file-editor-body md-body" data-testid="file-editor-body">{@html rendered}</div>
  {:else}
    {#if stale}
      <ErrorNotice
        message={`${name} changed since you opened it. Saving may report a conflict — reload first if you want the latest content.`}
      />
    {/if}
    {#if conflict !== undefined}
      <ErrorNotice
        message={conflict === null
          ? `${name} was deleted on disk since you started editing — your draft below was NOT saved.`
          : `${name} changed on disk since you started editing — your draft below was NOT saved.`}
      />
      <Button variant="secondary" size="sm" onclick={reloadLatest} dataTestId="file-editor-reload">
        Reload latest version
      </Button>
    {/if}
    {#if saveError}
      <ErrorNotice message={`Could not save ${name}: ${saveError}`} />
    {/if}
    <TextArea
      bind:value={draft}
      monospace
      rows={16}
      ariaLabel={`Edit ${name}`}
      dataTestId="file-editor-textarea"
    />
    <div class="file-editor-actions">
      <Button
        size="sm"
        loading={saving}
        disabled={saving}
        onclick={() => void handleSave()}
        dataTestId="file-editor-save"
      >
        Save
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={saving}
        onclick={cancelEdit}
        dataTestId="file-editor-cancel"
      >
        Cancel
      </Button>
    </div>
  {/if}
</div>

<style>
  .file-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-md);
    gap: var(--space-sm);
  }

  .file-editor-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding-bottom: var(--space-xs);
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .file-editor-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .file-editor-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-2xl) 0;
  }

  .file-editor-error {
    padding: var(--space-sm) 0;
  }

  .file-editor-truncated {
    margin: 0;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .file-editor-body {
    max-width: var(--measure-wide);
  }

  .file-editor-actions {
    display: flex;
    gap: var(--space-sm);
  }

  :global(.file-editor-body:hover .copy-button-reveal),
  :global(.file-editor-body:focus-within .copy-button-reveal) {
    opacity: 1;
  }

  :global(.file-editor-header:hover .copy-button-reveal),
  :global(.file-editor-header:focus-within .copy-button-reveal) {
    opacity: 1;
  }
</style>
