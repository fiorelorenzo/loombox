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
   * Redesign v3 (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md`
   * §3.4 "One tool-call anatomy"): the outer frame is now the same
   * gutter-plus-content row every tool-call widget uses (`GenericToolRow`
   * / `EditWriteWidget` / `TodoWidget`) rather than its own raised card —
   * `TerminalOutput`'s own dark terminal-screen surface (untouched) is the
   * one thing here that still reads as a boxed surface, on purpose (it's
   * meant to look like an actual console). Status is a `StatusDot` + short
   * label, never the raw enum. The header toggles the terminal body's
   * expand/collapse, defaulting open.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): a small header identifies the widget's tool-call type via the
   * shared `tool-bash` glyph, the same convention `EditWriteWidget`/
   * `TodoWidget` use — decorative, since the "Bash" label right next to it
   * already carries the meaning.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import {
    bashCommand,
    toolCallOutputText,
    TOOL_CALL_STATUS_LABELS,
    TOOL_CALL_STATUS_TONES,
  } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';
  import TerminalOutput from '../TerminalOutput.svelte';
  import Icon from '../icons/Icon.svelte';
  import StatusDot from '../ui/StatusDot.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  const command = $derived(bashCommand(item));
  const output = $derived(toolCallOutputText(item.content));
  const copyText = $derived(output ? `$ ${command}\n${output}` : `$ ${command}`);

  let expanded = $state(true);
  const statusTone = $derived(item.status ? TOOL_CALL_STATUS_TONES[item.status] : undefined);
  const statusLabel = $derived(item.status ? TOOL_CALL_STATUS_LABELS[item.status] : undefined);
</script>

<div class="bash-widget" data-testid="bash-widget">
  <div class="gutter" aria-hidden="true">
    <Icon name="tool-bash" class="type-icon" />
  </div>
  <div class="content">
    <div class="header-line">
      <button
        type="button"
        class="row-header"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
      >
        <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
        <span class="title">Bash</span>
        {#if statusTone && statusLabel}
          <span class="status">
            <StatusDot tone={statusTone} label={statusLabel} size="sm" />
            <span class="status-label" aria-hidden="true">{statusLabel}</span>
          </span>
        {/if}
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
  </div>
</div>

<style>
  .bash-widget {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
  }

  .gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    justify-content: center;
    padding-top: var(--space-2xs);
  }

  .content {
    flex: 1;
    min-width: 0;
    padding: var(--space-2xs) 0;
  }

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

  .title {
    flex: 1;
  }

  :global(.type-icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
    font-weight: 400;
  }

  .status-label {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
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
</style>
