<script lang="ts">
  /**
   * The canvas tab strip's read-only file viewer (issue #737, settled
   * pick B2-2 in
   * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §2).
   * Renders whatever a file tab's own `$lib/tabs.svelte.ts` `viewer`
   * state currently holds — loading, a real error from the node (a
   * missing/binary/traversal-refused path), or the file's content.
   *
   * Editing stays out of scope on purpose (#205 is that work): there is
   * no way to type into this view, and its only interactive control is
   * `CopyButton`.
   *
   * Reuses, never duplicates: `$lib/file-viewer.ts`'s
   * `fenceWrapFileContent` (itself built on `$lib/diff.ts`'s
   * `languageForPath` — the same language guess `DiffViewer` already
   * derives for its own per-line coloring class) feeds the content
   * through `$lib/markdown.ts`'s `renderMarkdownToHtml`/
   * `highlightMarkdownToHtml` pipeline — the exact lazy-loaded
   * highlighter #600 built for a transcript's own fenced code blocks,
   * driven with the same sync-then-async-highlighted two-step split
   * `MessageItem.svelte`'s own `rendered` derivation already uses, so a
   * freshly opened file renders instantly in plain monospace and
   * upgrades to full syntax color the moment the relevant grammar
   * finishes loading. `.md-body`'s styling (defined once, globally, in
   * `MessageItem.svelte`'s own style block) is reused as-is rather than
   * a second prose/code stylesheet.
   */
  import { fenceWrapFileContent } from '$lib/file-viewer';
  import { highlightMarkdownToHtml, renderMarkdownToHtml } from '$lib/markdown';
  import type { FileTabViewerState } from '$lib/tabs.svelte';
  import CopyButton from './CopyButton.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  interface Props {
    path: string;
    name: string;
    viewer: FileTabViewerState;
    /** Re-runs the same `readFile` this tab opened with — the only recovery action a read-only viewer offers for a failed load. */
    onRetry: () => void;
  }

  const { path, name, viewer, onRetry }: Props = $props();

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
</script>

<div class="file-viewer" data-testid="file-viewer">
  <div class="file-viewer-header">
    <span class="file-viewer-path font-mono" data-testid="file-viewer-path">{path}</span>
    {#if viewer.status === 'loaded'}
      <CopyButton text={viewer.content} label={`Copy ${name}`} revealOnHover />
    {/if}
  </div>

  {#if viewer.status === 'loading'}
    <div class="file-viewer-loading" data-testid="file-viewer-loading">
      <WovenLoader size="md" label={`Loading ${name}`} />
    </div>
  {:else if viewer.status === 'error'}
    <div class="file-viewer-error">
      <ErrorNotice message={viewer.message} retryable {onRetry} />
    </div>
  {:else}
    {#if viewer.truncated}
      <p class="file-viewer-truncated" data-testid="file-viewer-truncated">
        Truncated — this file is larger than the viewer shows.
      </p>
    {/if}
    <!-- `rendered` is our own $lib/markdown pipeline's sanitised output
       (rehype-sanitize + the fixed rehype-highlight/target-blank plugin
       chain — see that module's doc comment), never raw file text. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="file-viewer-body md-body" data-testid="file-viewer-body">{@html rendered}</div>
  {/if}
</div>

<style>
  .file-viewer {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-md);
    gap: var(--space-sm);
  }

  .file-viewer-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding-bottom: var(--space-xs);
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .file-viewer-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .file-viewer-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-2xl) 0;
  }

  .file-viewer-error {
    padding: var(--space-sm) 0;
  }

  .file-viewer-truncated {
    margin: 0;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .file-viewer-body {
    max-width: var(--measure-wide);
  }

  :global(.file-viewer-body:hover .copy-button-reveal),
  :global(.file-viewer-body:focus-within .copy-button-reveal) {
    opacity: 1;
  }

  :global(.file-viewer-header:hover .copy-button-reveal),
  :global(.file-viewer-header:focus-within .copy-button-reveal) {
    opacity: 1;
  }
</style>
