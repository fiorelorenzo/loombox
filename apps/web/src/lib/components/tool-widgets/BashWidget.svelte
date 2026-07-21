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
  .bash-widget {
    position: relative;
  }

  .copy-row {
    position: absolute;
    top: var(--space-2xs);
    right: var(--space-xs);
  }
</style>
