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
   * that later component exists) would hand in - both paths render through
   * the exact same decode/strip pipeline (`$lib/terminal.ts`'s
   * `TerminalChunkDecoder`), so there is one source of truth for "how a
   * terminal's bytes become displayed text," not a fork per caller.
   *
   * Warp Deck restyle (docs/design/redesign.md, issue #432): deliberately
   * keeps its own dark "terminal screen" look (background `--color-bg`,
   * not the raised-tier surface) rather than becoming another card - it's
   * the one place in the transcript meant to read as an actual console,
   * usually framed by a raised-tier card at the call site (`BashWidget`).
   * A hairline border gives it definition against that frame.
   *
   * Deck migration (redesign v2 design spec §2, issue #470): the header's
   * prompt glyph was a bare `$` character — exactly the kind of unicode
   * placeholder the bespoke icon set (issue #457) exists to replace — so it
   * now draws through the shared `Icon` component (`tool-bash`, the same
   * "terminal frame + prompt caret" glyph the tool-call widgets use) instead
   * of a hardcoded character. Still decorative (`aria-hidden`, no `label`):
   * the command text right next to it already carries the meaning. There is
   * no other non-xterm UI here to route through `Button`/`IconButton` — this
   * component has no interactive controls of its own (the copy affordance
   * lives one level up, in `BashWidget`).
   */
  import { decodeTerminalChunks } from '$lib/terminal';
  import { Icon } from './icons';

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
      <Icon name="tool-bash" class="prompt" />
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
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
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
    border-bottom: 1px solid var(--color-border-subtle);
  }

  /* `:global` — this class lands on `Icon`'s own root `<svg>`, one
     component down, so Svelte's scoped-CSS hash on this file's stylesheet
     never reaches it without the escape hatch. */
  :global(.prompt) {
    color: var(--color-text-muted);
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
