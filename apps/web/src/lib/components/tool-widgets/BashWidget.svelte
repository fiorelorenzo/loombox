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
   * Warp Deck restyle (docs/design/redesign.md, issue #432): the widget
   * itself is the elevation ladder's "raised" tier (Card's own recipe,
   * hand-styled here so the bash-widget testid stays put) - a card frame
   * around TerminalOutput's own dark terminal-screen surface, which stays
   * untouched.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { bashCommand, toolCallOutputText } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';
  import TerminalOutput from '../TerminalOutput.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  const command = $derived(bashCommand(item));
  const output = $derived(toolCallOutputText(item.content));
  const copyText = $derived(output ? `$ ${command}\n${output}` : `$ ${command}`);
</script>

<div class="bash-widget" data-testid="bash-widget">
  <TerminalOutput {command} content={output} status={item.status} />
  <div class="copy-row">
    <CopyButton text={copyText} label="Copy command and output" />
  </div>
</div>

<style>
  /* raised tier (elevation ladder §3): a card frame around
     TerminalOutput's own "screen" surface. */
  .bash-widget {
    position: relative;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-xs);
  }

  .copy-row {
    position: absolute;
    top: var(--space-sm);
    right: var(--space-sm);
  }
</style>
