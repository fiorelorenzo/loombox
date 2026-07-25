<script lang="ts">
  /**
   * The interactive PTY terminal (SPEC §7.5; issues #172/#173/#174), the
   * counterpart to `TerminalOutput.svelte`'s read-only rendering: this one
   * owns a real xterm.js `Terminal`, opens a PTY on `sessionId`'s target via
   * `client.openTerminal`, writes decrypted output chunks straight into it,
   * and forwards every keystroke/resize back over `client` as encrypted
   * `terminal_input`/`terminal_resize` frames. Reachability parity (#174):
   * this is the ONE component used for both a `local` and an `ssh:` target
   * (the target kind is the node's concern, invisible here) and for both
   * desktop and a narrow/mobile viewport — there is no separate mobile
   * variant, only CSS (`.interactive-terminal`'s `min-width: 0` + the
   * container's own `overflow` below) adapting the same markup.
   *
   * `client` is `$lib/terminal.ts`'s narrow `TerminalClient` interface
   * (mirrors `RelayClient`'s terminal methods) rather than `RelayClient`
   * itself, so this component never depends on real crypto/WebSocket
   * machinery — a test injects a plain fake.
   *
   * ENVIRONMENT NOTE: xterm.js renders to a `<canvas>`; this component's
   * *data flow* (output -> `terminal.write`, keystroke -> encrypted send,
   * resize -> resize frame) is unit-tested with `@xterm/xterm` mocked, but
   * the actual visual rendering can only be verified in a real browser.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§6,
   * issue #437): this component now lives inside the Drawer's "Terminal"
   * tab (overlay below `--bp-wide`, pinnable alongside Targets above it —
   * that shell-level shuttle-in/shuttle-out transition already lives on
   * `+page.svelte`'s `.drawer` and is untouched here). This restyle only
   * covers the terminal's OWN chrome: a titlebar carrying a `StatusDot`
   * for the connected/connecting/error/closed state (`status-crossfade` on
   * change, thread-draw pulse while `opening`), a hand-styled danger
   * banner for the error status matching `ErrorNotice`'s visual language
   * (not the component itself — the existing status row's `terminal-status`
   * `data-testid` is load-bearing for this file's tests, and `ErrorNotice`
   * hardcodes its own `ui-error-notice` testid with no override), a
   * `--color-focus-ring` highlight while the PTY has DOM focus (never
   * accent — accent stays reserved for meaning per the brief), and the
   * xterm.js canvas itself re-themed from the same design tokens so it
   * reads as part of the same surface rather than a bare default-black
   * box. None of this touches the data flow above: no prop contract, no
   * status-transition logic, no I/O path changed.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import type { TerminalClient } from '$lib/terminal';
  import type { TerminalClientState } from '$lib/relay-client';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';

  interface Props {
    sessionId: string;
    client: TerminalClient;
    /** Initial PTY size before xterm.js's own layout can report real dimensions; a later `terminal.onResize` corrects this once it knows the container's actual size. */
    cols?: number;
    rows?: number;
  }

  const { sessionId, client, cols = 80, rows = 24 }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let status = $state<TerminalClientState['status']>('opening');
  let errorMessage = $state<string | undefined>();
  /** DOM-focus tracking only, for the focused-state border (chrome, not I/O) — xterm.js mounts a hidden textarea inside `container` to capture keystrokes, so a bubbling `focusin`/`focusout` pair on the container is enough to know the PTY has focus. */
  let focused = $state(false);

  let terminal: Terminal | undefined;
  let terminalId: string | undefined;
  let unsubscribeOutput: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;

  const statusTone = $derived<StatusTone>(
    status === 'open'
      ? 'success'
      : status === 'error'
        ? 'danger'
        : status === 'closed'
          ? 'neutral'
          : 'info',
  );

  const statusLabel = $derived(
    status === 'open'
      ? 'Terminal connected'
      : status === 'opening'
        ? 'Terminal connecting'
        : status === 'error'
          ? `Terminal error: ${errorMessage ?? 'unknown error'}`
          : 'Terminal closed',
  );

  /** Reads a design token off `:root` at mount time so the xterm.js canvas (which cannot see CSS custom properties) draws from the same palette as everything around it, falling back to the dark/ink default for environments with no stylesheet (e.g. this file's jsdom tests). */
  function readToken(name: string, fallback: string): string {
    if (typeof getComputedStyle !== 'function') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  onMount(() => {
    unsubscribeState = client.terminalsFor(sessionId).subscribe((map) => {
      if (!terminalId) return;
      const state = map.get(terminalId);
      if (!state) return;
      status = state.status;
      errorMessage = state.error;
    });

    terminal = new Terminal({
      cols,
      rows,
      fontFamily: readToken('--font-mono', 'ui-monospace, monospace'),
      fontSize: 13,
      theme: {
        background: readToken('--color-bg', '#0b0d10'),
        foreground: readToken('--color-text-primary', '#eef0f2'),
        cursor: readToken('--color-accent', '#3b9df7'),
        cursorAccent: readToken('--color-bg', '#0b0d10'),
        selectionBackground: readToken('--color-accent-subtle', 'rgba(59, 157, 247, 0.35)'),
      },
    });
    if (container) terminal.open(container);

    terminalId = client.openTerminal(sessionId, terminal.cols, terminal.rows);
    const openedId = terminalId;

    unsubscribeOutput = client.onTerminalOutput(sessionId, openedId, (chunk) => {
      terminal?.write(chunk);
    });

    terminal.onData((data) => {
      client.sendTerminalInput(sessionId, openedId, data);
    });

    terminal.onResize(({ cols: newCols, rows: newRows }) => {
      client.resizeTerminal(sessionId, openedId, newCols, newRows);
    });
  });

  onDestroy(() => {
    unsubscribeOutput?.();
    unsubscribeState?.();
    if (terminalId) client.closeTerminal(sessionId, terminalId);
    terminal?.dispose();
  });
</script>

<div
  class="interactive-terminal"
  class:focused
  data-testid="interactive-terminal"
  data-status={status}
>
  <div class="terminal-titlebar">
    <StatusDot tone={statusTone} pulse={status === 'opening'} label={statusLabel} size="sm" />
    <span class="terminal-titlebar-label font-mono">Terminal</span>
  </div>

  {#if status !== 'open'}
    <div class="status" class:error={status === 'error'} data-testid="terminal-status">
      {#if status === 'opening'}
        Connecting…
      {:else if status === 'error'}
        {errorMessage ?? 'Terminal error'}
      {:else if status === 'closed'}
        Closed
      {/if}
    </div>
  {/if}

  <div
    class="xterm-container"
    bind:this={container}
    data-testid="xterm-container"
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  ></div>
</div>

<style>
  .interactive-terminal {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: var(--color-bg);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    overflow: hidden;
    /* Focused-state border (chrome only): a hairline shift to
       `--color-focus-ring`, never the accent — accent stays reserved for
       meaning, per the redesign brief's "accent-for-meaning" discipline. */
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .interactive-terminal.focused {
    border-color: var(--color-focus-ring);
  }

  .terminal-titlebar {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-shrink: 0;
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .terminal-titlebar-label {
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
    letter-spacing: 0.02em;
  }

  .status {
    padding: var(--space-xs) var(--space-sm);
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border-subtle);
    /* status-crossfade (redesign brief §2): a status change crossfades
       color/background, no snap. */
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      color var(--duration-fast) var(--ease-beat);
  }

  /* Hand-styled to `ErrorNotice`'s own danger-tinted "raised" visual
     language rather than importing that component: this row's
     `terminal-status` testid and plain-text content are load-bearing for
     this file's tests, and `ErrorNotice` hardcodes its own
     `ui-error-notice` testid with no override. */
  .status.error {
    color: var(--color-danger);
    background: var(--color-danger-subtle);
    border-bottom-color: var(--color-danger);
  }

  .xterm-container {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: var(--space-2xs);
    background: var(--color-bg);
    overflow: hidden;
  }
</style>
