<script lang="ts">
  /**
   * The bespoke Bash widget (SPEC.md §7.24 tier-1 + "Display-only
   * terminals", issues #139/#142): Claude's Bash and Codex's bash both
   * resolve here (any `execute`-kind tool call). Renders through
   * `TerminalOutput` — the same shared display-only terminal component
   * issue #142 builds — rather than its own ad hoc terminal-styled block,
   * so this widget and any other display-only tool-call terminal render
   * identically and share one chunk-boundary-safe decode path
   * (`$lib/terminal.ts`), not a fork per widget.
   *
   * One level of card chrome (design spec `2026-08-03-cockpit-v6-design.md`
   * §3.4, issue #576): `TerminalOutput`'s own dark terminal-screen surface
   * is deliberately the one thing here that reads as a boxed surface (it's
   * meant to look like an actual console) — `ToolCard` renders `surface=
   * {false}` so it no longer wraps that in a second, redundant bordered
   * card. The header row (icon, command, status, disclosure) stays plain
   * text directly above it. Status renders via the shared
   * `ToolCallStatus` (a failed run is louder than a completed one; see
   * that component's own doc comment).
   *
   * Resting state and its one override (v7 decisions §3, issue #668):
   * C1-1 — a completed call rests collapsed to this header's single line,
   * the actual command text (not the bare word "Bash") plus its outcome,
   * so `pwd` and a 13-line vitest tail cost the same row until asked for
   * more. C2-1 — a failed call always renders its terminal body in full,
   * uncapped, disclosure locked open (no button, just static text) so it
   * cannot be collapsed by accident — this overrides C1-1's resting
   * default rather than competing with it. A still-running call keeps
   * the old always-open behaviour so its live output stays visible.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): a small header identifies the widget's tool-call type via the
   * shared `tool-bash` glyph — decorative, since the command text right
   * next to it already carries the meaning.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
  import { bashCommand, toolCallOutputText } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';
  import TerminalOutput from '../TerminalOutput.svelte';
  import ToolCallGutter from '../ToolCallGutter.svelte';
  import ToolCallStatus from '../ToolCallStatus.svelte';
  import Icon from '../icons/Icon.svelte';
  import ToolCard from './ToolCard.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  const command = $derived(bashCommand(item));
  const output = $derived(toolCallOutputText(item.content));
  const copyText = $derived(output ? `$ ${command}\n${output}` : `$ ${command}`);

  // See the file doc comment's "Resting state and its one override" note.
  // Only the mount-time status matters here (a live status change never
  // auto-collapses/-expands an already-rendered row): `locked` picks up
  // `failed` reactively regardless.
  // svelte-ignore state_referenced_locally
  let expandedState = $state(item.status !== 'completed');
  const locked = $derived(item.status === 'failed');
  const expanded = $derived(locked || expandedState);
  function toggleExpanded() {
    if (locked) return;
    expandedState = !expandedState;
  }
</script>

<div class="bash-widget" data-testid="bash-widget">
  <ToolCallGutter icon="tool-bash" />
  <ToolCard surface={false}>
    <div class="header-line">
      {#snippet headerContent()}
        <code class="title">$ {command}</code>
        <ToolCallStatus status={item.status} />
      {/snippet}
      {#if locked}
        <div class="row-header row-header-static" data-testid="row-header">
          {@render headerContent()}
        </div>
      {:else}
        <button
          type="button"
          class="row-header"
          onclick={toggleExpanded}
          aria-expanded={expanded}
          data-testid="row-header"
        >
          <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
          {@render headerContent()}
        </button>
      {/if}
      <div class="copy-row">
        <CopyButton text={copyText} label="Copy command and output" revealOnHover />
      </div>
    </div>
    {#if expanded}
      <div class="body">
        <TerminalOutput {command} content={output} status={item.status} />
      </div>
    {/if}
  </ToolCard>
</div>

<style>
  .bash-widget {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
  }

  /* Pre-existing gap: `.header-line` (wrapping the disclosure button and
     the copy affordance) had no rule of its own, so the two fell back to
     default block/inline-block stacking — the copy button rendered on its
     own line below the command instead of beside it. Same
     display:flex/align/gap recipe as `GenericToolRow`/`TodoWidget`'s
     identical wrapper, caught while verifying C1-1's one-line resting
     claim in a real browser (issue #668). */
  .header-line {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .row-header:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-radius: var(--radius-sm);
  }

  :global(.disclosure-icon) {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .row-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  /* C2-1 (issue #668): the locked/failed header renders as plain text,
     not a button — there is nothing to disclose, so no click affordance
     (and no misleading focus outline) should suggest otherwise. */
  .row-header-static {
    cursor: default;
  }

  /* The command line (redesign v7 §3 C1-1): mono, truncated to one line
     so a long command doesn't push the outcome chip off the row. */
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-weight: 400;
  }

  .copy-row {
    flex-shrink: 0;
  }

  /* Copy affordances reveal on row hover/focus-within (redesign v3 §3.4
     "Copy affordances"); see CopyButton.svelte's `revealOnHover` doc
     comment for why this lives here rather than in the shared button. */
  .bash-widget:hover :global(.copy-button-reveal),
  .bash-widget:focus-within :global(.copy-button-reveal) {
    opacity: 1;
  }

  .body {
    margin-top: var(--space-xs);
    min-width: 0;
  }

  /* Below `--bp-mobile` the role column collapses, so this row stacks its
     `ToolCallGutter` caption above the card — see that component's own copy
     of this block, and `MessageItem`'s for the measurement. */
  @media (max-width: 479px) {
    .bash-widget {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
