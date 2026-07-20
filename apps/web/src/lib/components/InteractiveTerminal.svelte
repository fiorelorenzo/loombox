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
   */
  import { onDestroy, onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import type { TerminalClient } from '$lib/terminal';
  import type { TerminalClientState } from '$lib/relay-client';

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

  let terminal: Terminal | undefined;
  let terminalId: string | undefined;
  let unsubscribeOutput: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;

  onMount(() => {
    unsubscribeState = client.terminalsFor(sessionId).subscribe((map) => {
      if (!terminalId) return;
      const state = map.get(terminalId);
      if (!state) return;
      status = state.status;
      errorMessage = state.error;
    });

    terminal = new Terminal({ cols, rows });
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

<div class="interactive-terminal" data-testid="interactive-terminal">
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
  <div class="xterm-container" bind:this={container} data-testid="xterm-container"></div>
</div>

<style>
  .interactive-terminal {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: #0b0b12;
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .status {
    padding: 0.4rem 0.6rem;
    font-family: monospace;
    font-size: 0.8rem;
    color: #9ca3af;
  }

  .status.error {
    color: #f87171;
  }

  .xterm-container {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
</style>
