<script lang="ts">
  /**
   * The ACP v1 Diff viewer (SPEC.md §7.24 "Diffs", issue #141): client-side
   * line diffing (`$lib/diff.ts`), reused as-is by both a tool-call diff
   * (here) and the working-tree diff viewer (§7.4, a later epic — this
   * component takes no tool-call-specific props, only
   * `{path, oldText, newText}`, so it's already that shared component).
   * `oldText === null` (binary/symlink change, or a brand-new file) still
   * renders a real diff card - never a blank one - falling back to a
   * structural-only summary when there's no line text to diff at all.
   * (Language-aware syntax coloring is future work — v6 design spec §3.4;
   * this view's own `data-lang={languageForPath(path)}` was never wired to
   * any styling and is dropped as of issue #579's `Card` migration below,
   * rather than carried along as dead code — `languageForPath` itself
   * stays in `$lib/diff.ts`, tested there, for whenever that work lands.)
   *
   * Warp Deck restyle (docs/design/redesign.md, issue #432): the card
   * itself adopts the elevation ladder's "raised" tier; the header keeps
   * its own slightly-darker fill as a toolbar strip for path/stats/copy,
   * legible against either surrounding surface.
   *
   * Redesign v3 (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md`
   * §3.4 "Canvas and transcript"): capped at `--measure-wide` on a wide
   * viewport rather than stretching edge-to-edge, and `min-width: 0` so it
   * can actually shrink inside a flex-column ancestor (`EditWriteWidget`'s
   * `.content`) instead of forcing the whole row wider than the viewport —
   * the card scrolls its own long lines horizontally (`.diff-lines`'s
   * `overflow-x: auto`) rather than overflowing the page on a narrow one.
   */
  import { diffStats } from '$lib/diff';
  import Card from './ui/Card.svelte';
  import CopyButton from './CopyButton.svelte';
  import Icon from './icons/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    path: string;
    /** ACP v1's `Diff.oldText`: `null` means no previous content (new file, or unavailable for a binary/symlink change). */
    oldText: string | null;
    /** ACP v1's `Diff.newText` (always a string on the wire). Empty + `oldText === null` together mean "no patch text at all" — a binary/symlink change. */
    newText: string;
    /** Opens `path` in the canvas tab strip's read-only file viewer (issue #737). Omitted renders no "Open" affordance — `ReviewChangesDialog` wires this the same way `EditWriteWidget` does, one shared button on this shared component rather than two call sites each growing their own. */
    onOpen?: () => void;
  }

  const { path, oldText, newText, onOpen }: Props = $props();

  // Structural-only fallback: neither side carries any patch text at all —
  // ACP's shape for a binary/symlink change (SPEC.md §7.24). A genuinely
  // emptied text file (oldText non-null, newText === '') is still a real
  // diff (every old line renders as removed), not this fallback.
  //
  // `diffStats` (issue #740) is the one place this hasText/lines/added/
  // removed derivation happens — `$lib/transcript/turn-review.ts`'s
  // per-turn aggregator calls the same function, so this card's own stat
  // line and the turn summary bar's total can never drift apart.
  const stats = $derived(diffStats(oldText, newText));
  const hasText = $derived(stats.hasText);
  const lines = $derived(stats.lines);
  const added = $derived(stats.added);
  const removed = $derived(stats.removed);
  const copyText = $derived(hasText ? newText : `${path} (binary/symlink change)`);
</script>

<Card elevation="raised" padding="none" class="diff-viewer">
  <div class="diff-header">
    <span class="diff-path font-mono">{path}</span>
    {#if hasText}
      <span class="diff-stats font-mono">
        <span class="added">+{added}</span>
        <span class="removed">-{removed}</span>
      </span>
    {/if}
    {#if onOpen}
      <IconButton
        label={`Open ${path}`}
        size="sm"
        onclick={onOpen}
        class="copy-button-reveal"
        dataTestId="diff-viewer-open"
      >
        <Icon name="file" />
      </IconButton>
    {/if}
    <CopyButton text={copyText} label={`Copy diff for ${path}`} revealOnHover />
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
      Binary or symlink change — no line-level diff available for
      <span class="font-mono">{path}</span>.
    </p>
  {/if}
</Card>

<style>
  /* `Card` (`elevation="raised"`) supplies the background/border/radius/
     shadow now (issue #579) — this is only the sizing this surface still
     needs on top of it. Capped at --measure-wide (redesign v3 §3.4) and
     always allowed to shrink below its content's intrinsic width inside a
     flex/grid ancestor, so a long monospace line scrolls within
     `.diff-lines` instead of pushing the card past the viewport.
     `:global()` because `Card` renders its own root in its own component
     scope. */
  :global(.diff-viewer) {
    overflow: hidden;
    font-size: var(--text-code-size);
    width: 100%;
    max-width: var(--measure-wide);
    min-width: 0;
  }

  .diff-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    border-bottom: 1px solid var(--color-border-subtle);
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
    max-width: 100%;
  }

  .diff-lines li {
    display: flex;
    width: fit-content;
    min-width: 100%;
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

  /* Copy affordance reveals on card hover/focus-within (redesign v3 §3.4
     "Copy affordances"); see CopyButton.svelte's `revealOnHover` doc
     comment for why this lives here rather than in the shared button. */
  :global(.diff-viewer:hover .copy-button-reveal),
  :global(.diff-viewer:focus-within .copy-button-reveal) {
    opacity: 1;
  }
</style>
