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
   * card. The header row (icon, "Bash", status, disclosure) stays plain
   * text directly above it. Status renders via the shared
   * `ToolCallStatus` (a failed run is louder than a completed one; see
   * that component's own doc comment). The header toggles the terminal
   * body's expand/collapse, defaulting open.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): a small header identifies the widget's tool-call type via the
   * shared `tool-bash` glyph, the same convention `EditWriteWidget`/
   * `TodoWidget` use — decorative, since the "Bash" label right next to it
   * already carries the meaning.
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

  let expanded = $state(true);
</script>

<div class="bash-widget" data-testid="bash-widget">
  <ToolCallGutter icon="tool-bash" />
  <ToolCard surface={false}>
    <div class="header-line">
      <button
        type="button"
        class="row-header"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
      >
        <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
        <span class="title">Bash</span>
        <ToolCallStatus status={item.status} />
      </button>
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

  /* `flex-shrink: 0` used to sit here too, but `Icon`'s own
     `.icon { flex-shrink: 0; }` scoped root rule already provides the
     identical value (issue #665's guard-test scan) — redundant dead CSS,
     dropped rather than kept. */
  :global(.disclosure-icon) {
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .row-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  .title {
    flex: 1;
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
