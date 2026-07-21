<script lang="ts">
  /**
   * The display-only tool-call terminal (SPEC.md §7.24 "Display-only
   * terminals": "a tool call's terminal content ... reuses the same
   * terminal component ... buffering partial UTF-8/ANSI escape sequences
   * across output chunks rather than decoding chunk-by-chunk"; issue
   * #142). Read-only rendering: no input, no PTY, just a command line plus
   * its accumulated output — as opposed to the *interactive* terminals of
   * §7.5, which this component is deliberately structured to share its
   * rendering with rather than fork: `content` accepts either a plain,
   * already-materialized string (the common v1 case — a settled tool
   * call's output already lives as one string in `TranscriptToolCallItem`)
   * or the raw `Uint8Array[]` chunk list a live byte stream (this same
   * tool call while still running, or a real interactive terminal, once
   * that later component exists) would hand in — both paths render through
   * the exact same decode/strip pipeline (`$lib/terminal.ts`'s
   * `TerminalChunkDecoder`), so there is one source of truth for "how a
   * terminal's bytes become displayed text," not a fork per caller.
   */
  import { decodeTerminalChunks } from '$lib/terminal';

  interface Props {
    /** The command line shown on the prompt row, if any (a tool call with no discrete "command", e.g. raw stdout replay, can omit it). */
    command?: string;
    /** Either the already-decoded output text, or the raw byte chunks to decode chunk-boundary-safely (issue #142). */
    content: string | readonly Uint8Array[];
    status?: string;
  }

  const { command, content, status }: Props = $props();

  const output = $derived(typeof content === 'string' ? content : decodeTerminalChunks(content));
</script>

<div class="terminal-output" data-testid="terminal-output">
  {#if command !== undefined}
    <div class="header">
      <span class="prompt" aria-hidden="true">$</span>
      <code class="command" data-testid="terminal-command">{command}</code>
      {#if status}<span class="status">{status}</span>{/if}
    </div>
  {/if}
  {#if output}
    <pre class="body" data-testid="terminal-body">{output}</pre>
  {/if}
</div>

<style>
  .terminal-output {
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--color-bg);
    color: var(--color-text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-code-size);
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    padding: var(--space-xs) var(--space-sm);
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
    font-size: var(--text-small-size);
  }

  .body {
    margin: 0;
    padding: var(--space-sm) var(--space-sm);
    white-space: pre-wrap;
    overflow-x: auto;
    /* A read-only rendering — never focusable/editable, only selectable for copy. */
    user-select: text;
  }
</style>
