<script lang="ts">
  /**
   * The ACP v1 Diff viewer (SPEC.md §7.24 "Diffs", issue #141): client-side
   * line diffing (`$lib/diff.ts`) with language-aware coloring, reused
   * as-is by both a tool-call diff (here) and the working-tree diff viewer
   * (§7.4, a later epic — this component takes no tool-call-specific props,
   * only `{path, oldText, newText}`, so it's already that shared component).
   * `oldText === null` (binary/symlink change, or a brand-new file) still
   * renders a real diff card — never a blank one — falling back to a
   * structural-only summary when there's no line text to diff at all.
   */
  import { computeLineDiff, languageForPath, type DiffLine } from '$lib/diff';
  import CopyButton from './CopyButton.svelte';

  interface Props {
    path: string;
    /** ACP v1's `Diff.oldText`: `null` means no previous content (new file, or unavailable for a binary/symlink change). */
    oldText: string | null;
    /** ACP v1's `Diff.newText` (always a string on the wire). Empty + `oldText === null` together mean "no patch text at all" — a binary/symlink change. */
    newText: string;
  }

  const { path, oldText, newText }: Props = $props();

  const lang = $derived(languageForPath(path));
  // Structural-only fallback: neither side carries any patch text at all —
  // ACP's shape for a binary/symlink change (SPEC.md §7.24). A genuinely
  // emptied text file (oldText non-null, newText === '') is still a real
  // diff (every old line renders as removed), not this fallback.
  const hasText = $derived(!(oldText === null && newText === ''));
  const lines: DiffLine[] = $derived(hasText ? computeLineDiff(oldText, newText) : []);
  const added = $derived(lines.filter((l) => l.kind === 'added').length);
  const removed = $derived(lines.filter((l) => l.kind === 'removed').length);
  const copyText = $derived(hasText ? newText : `${path} (binary/symlink change)`);
</script>

<div class="diff-viewer" data-lang={lang}>
  <div class="diff-header">
    <span class="diff-path">{path}</span>
    {#if hasText}
      <span class="diff-stats">
        <span class="added">+{added}</span>
        <span class="removed">-{removed}</span>
      </span>
    {/if}
    <CopyButton text={copyText} label={`Copy diff for ${path}`} />
  </div>

  {#if hasText}
    <ol class="diff-lines">
      {#each lines as line, index (index)}
        <li class={line.kind}>
          <span class="line-no old">{line.oldLineNumber ?? ''}</span>
          <span class="line-no new">{line.newLineNumber ?? ''}</span>
          <span class="marker"
            >{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span
          >
          <span class="text">{line.text}</span>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="structural-only" data-testid="structural-diff">
      Binary or symlink change — no line-level diff available for {path}.
    </p>
  {/if}
</div>

<style>
  .diff-viewer {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    font-size: var(--text-code-size);
  }

  .diff-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    font-family: var(--font-mono);
  }

  .diff-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diff-stats .added {
    color: var(--color-success);
  }

  .diff-stats .removed {
    color: var(--color-danger);
    margin-left: var(--space-xs);
  }

  .diff-lines {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: var(--font-mono);
    overflow-x: auto;
  }

  .diff-lines li {
    display: flex;
    white-space: pre;
    padding: 0 var(--space-sm);
  }

  .diff-lines li.added {
    background: var(--color-success-subtle);
  }

  .diff-lines li.removed {
    background: var(--color-danger-subtle);
  }

  .line-no {
    display: inline-block;
    width: 2.5rem;
    text-align: right;
    opacity: 0.45;
    flex-shrink: 0;
    padding-right: var(--space-sm);
    user-select: none;
  }

  .marker {
    width: 1rem;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .structural-only {
    padding: var(--space-sm);
    opacity: 0.75;
    margin: 0;
  }
</style>
