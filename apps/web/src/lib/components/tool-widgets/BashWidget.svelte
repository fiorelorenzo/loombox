<script lang="ts">
  /**
   * The bespoke Bash widget (SPEC.md §7.24 tier-1 + "Display-only
   * terminals", issue #139): Claude's Bash and Codex's bash both resolve
   * here (any `execute`-kind tool call). Shows the command and its output
   * in a terminal-styled block — the "display-only terminal" §7.24
   * describes reusing the terminal component's styling; full ANSI/partial-
   * UTF-8 buffering is the real §7.5 terminal component's job, out of
   * scope for this static block.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { bashCommand, toolCallOutputText } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  const command = $derived(bashCommand(item));
  const output = $derived(toolCallOutputText(item.content));
  const copyText = $derived(output ? `$ ${command}\n${output}` : `$ ${command}`);
</script>

<div class="bash-widget" data-testid="bash-widget">
  <div class="header">
    <span class="prompt">$</span>
    <code class="command">{command}</code>
    {#if item.status}<span class="status">{item.status}</span>{/if}
    <CopyButton text={copyText} label="Copy command and output" />
  </div>
  {#if output}
    <pre class="terminal-output">{output}</pre>
  {/if}
</div>

<style>
  .bash-widget {
    border-radius: 0.5rem;
    overflow: hidden;
    background: #0b0b12;
    color: #e5e7eb;
    font-family: monospace;
    font-size: 0.85rem;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
  }

  .prompt {
    opacity: 0.6;
  }

  .command {
    flex: 1;
    overflow-x: auto;
    white-space: pre;
  }

  .status {
    opacity: 0.6;
    font-size: 0.75rem;
  }

  .terminal-output {
    margin: 0;
    padding: 0 0.6rem 0.5rem;
    white-space: pre-wrap;
    overflow-x: auto;
  }
</style>
