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
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): a small header identifies the widget's tool-call type via the
   * shared `tool-bash` glyph, the same convention `EditWriteWidget`/
   * `TodoWidget` use — decorative, since the "Bash" label right next to it
   * already carries the meaning.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { bashCommand, toolCallOutputText } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';
  import TerminalOutput from '../TerminalOutput.svelte';
  import Icon from '../icons/Icon.svelte';

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
    <Icon name="tool-bash" class="type-icon" />
    <span class="title">Bash</span>
    <div class="copy-row">
      <CopyButton text={copyText} label="Copy command and output" />
    </div>
  </div>
  <TerminalOutput {command} content={output} status={item.status} />
</div>

<style>
  /* raised tier (elevation ladder §3): a card frame around
     TerminalOutput's own "screen" surface. */
  .bash-widget {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-xs);
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: 0 var(--space-2xs) var(--space-xs);
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .title {
    flex: 1;
  }

  :global(.type-icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .copy-row {
    flex-shrink: 0;
  }
</style>
