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
   *
   * Deck migration (redesign v2 design spec §2, issue #470): the chrome
   * above already read Deck's `--color-*`/`--space-*`/`--radius-*` tokens
   * end to end (`deck.css` kept every name `tokens.css` used to own, see
   * that file's doc comment) — nothing here was hardcoded outside the
   * xterm.js theme object below, which cannot read CSS custom properties
   * and is exempt per this issue's acceptance criteria. The one real
   * change: the titlebar now carries the same bespoke `Icon` (`tool-bash`)
   * `TerminalOutput` adopted, so both terminal surfaces read as one family
   * instead of `StatusDot` and the "Terminal" text label standing alone.
   *
   * Bounded wait + retry (issue #582): `status = 'opening'` used to have no
   * ceiling — the v6 audit hit this against a node that never answers a
   * `terminal_open` and the titlebar just said "Terminal connecting"
   * forever. This component now owns its own bounded wait
   * (`OPEN_TIMEOUT_MS`) on top of `TerminalClientState['status']`, which
   * has no timeout of its own: a mount/retry still `'opening'` when its
   * timer fires shows a local, retryable `ErrorNotice` — worded, per
   * `NewSessionDialog`'s identical "the agent is taking a while" case
   * (issue #516), to say plainly that a timeout here does NOT mean the
   * request failed, only that this client stopped waiting; "the node may
   * be asleep, offline" reuses the exact phrasing `DirectoryPicker`/
   * `ArchiveSessionDialog` already settled on (issue #505), not a third
   * one. A real answer, however late, still clears it (`onTerminalOutput`'s
   * subscribe callback below). Retry (`retryTerminal`) asks the node to
   * close whichever attempt just timed out and opens a genuinely new one
   * (`RelayClient.openTerminal`'s own doc comment: calling it again opens
   * an ADDITIONAL terminal with its own id) — never just clears the flag.
   * This is a SEPARATE failure surface from the hand-rolled `.status.error`
   * banner below it: that one still renders verbatim node-reported errors
   * (e.g. "no shell available") under the load-bearing `terminal-status`
   * testid this file's other tests pin down; the new timeout state below
   * has no such legacy constraint, so it uses `ErrorNotice` directly.
   *
   * Bottom dock + real resize (issue #572): the terminal used to live in a
   * fixed-width vertical Drawer tab; it is a wide, short, drag-resizable
   * bottom dock now, and xterm.js's own layout does not react to a
   * container resize on its own. `onMount` below loads `@xterm/addon-fit`
   * and calls `fitAddon.fit()` (which calls `terminal.resize()`, which is
   * what actually fires `onResize` above) both right after `terminal.open`
   * and on every `ResizeObserver` notification for `container` — covering
   * the initial mount, a continuous height drag, AND becoming visible
   * again after the dock collapsed it to nothing (`display: none`) and
   * reopened, all through the one mechanism. `liveCols`/`liveRows` mirror
   * whatever `onResize` last reported as `data-cols`/`data-rows` on the
   * root element — a plain, real-browser-and-test-both observable proof
   * that a resize actually reflowed the terminal, not just its CSS box.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import type { TerminalClient } from '$lib/terminal';
  import type { TerminalClientState } from '$lib/relay-client';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import { Icon } from './icons';
  import ErrorNotice from './ui/ErrorNotice.svelte';

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
  let fitAddon: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  /** Mirrors of `terminal.cols`/`terminal.rows` as of the last `onResize` (see this file's own top doc comment) — rendered as `data-cols`/`data-rows` below so a resize (drag, initial fit, becoming visible again) is assertable by its REAL effect on the terminal, not just a CSS height change. Seeded from the constructed `terminal`'s own `cols`/`rows` in `onMount` below, not read directly from the `cols`/`rows` props here — reading a prop straight into a `$state` initializer only captures it once anyway (Svelte's own `state_referenced_locally` warning), so this reads the value from the one place that already needs to exist at that point regardless. */
  let liveCols = $state(0);
  let liveRows = $state(0);
  let terminalId: string | undefined;
  let unsubscribeOutput: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  /** Set once this mount/retry's own bounded wait on the PTY handshake elapses while `status` is still `'opening'` (issue #582) — `TerminalClientState['status']` has no such value of its own; this is purely local UI state, cleared the instant a real `'open'`/`'closed'`/`'error'` answer arrives, however late. */
  let timedOut = $state(false);
  let openTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const statusTone = $derived<StatusTone>(
    timedOut
      ? 'danger'
      : status === 'open'
        ? 'success'
        : status === 'error'
          ? 'danger'
          : status === 'closed'
            ? 'neutral'
            : 'info',
  );

  const statusLabel = $derived(
    timedOut
      ? 'Terminal timed out waiting to open'
      : status === 'open'
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

  /** How long a mount/retry's own PTY handshake may sit `'opening'` before this component gives up waiting on its own (issue #582) — `TerminalClientState` carries no timeout of its own. 10s matches every other request-shaped `RelayClient` default. */
  const OPEN_TIMEOUT_MS = 10_000;

  function clearOpenTimeout(): void {
    if (openTimeoutHandle === undefined) return;
    clearTimeout(openTimeoutHandle);
    openTimeoutHandle = undefined;
  }

  function armOpenTimeout(): void {
    clearOpenTimeout();
    openTimeoutHandle = setTimeout(() => {
      openTimeoutHandle = undefined;
      timedOut = true;
    }, OPEN_TIMEOUT_MS);
  }

  onMount(() => {
    unsubscribeState = client.terminalsFor(sessionId).subscribe((map) => {
      if (!terminalId) return;
      const state = map.get(terminalId);
      if (!state) return;
      status = state.status;
      errorMessage = state.error;
      // A real answer, however late, is the honest resolution of this
      // mount/retry's own bounded wait (issue #582's "a timeout does not
      // mean the request failed" only holds if a late answer still lands).
      if (state.status !== 'opening') {
        clearOpenTimeout();
        timedOut = false;
      }
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
    liveCols = terminal.cols;
    liveRows = terminal.rows;
    if (container) terminal.open(container);

    // Reads the CURRENT `terminalId` at send time rather than closing over
    // one captured at mount (issue #582's retry opens an ADDITIONAL
    // terminal with a new id — see `openNewTerminal` — and these two
    // listeners, registered once, must follow it there).
    terminal.onData((data) => {
      if (terminalId) client.sendTerminalInput(sessionId, terminalId, data);
    });

    terminal.onResize(({ cols: newCols, rows: newRows }) => {
      liveCols = newCols;
      liveRows = newRows;
      if (terminalId) client.resizeTerminal(sessionId, terminalId, newCols, newRows);
    });

    // See this file's own top doc comment ("Bottom dock + real resize",
    // issue #572) for why a `ResizeObserver`, not a `pointermove`
    // listener, is the coalescing mechanism: it fires at most once per
    // render frame no matter how many synchronous height writes happened
    // since the last one, so a continuous drag calls `fit()` (and the
    // real `resizeTerminal` it triggers) once per frame, not once per
    // pointermove. Guarded for `jsdom` (no `ResizeObserver`); the real
    // `@xterm/addon-fit` package runs unmocked against this file's own
    // `FakeTerminal` regardless — `proposeDimensions()` bails out on the
    // missing `terminal.element` a real `Terminal.open()` would have set,
    // so `fit()` is a safe no-op here and a real resize in a real browser.
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddon.fit();
    if (container && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => fitAddon?.fit());
      resizeObserver.observe(container);
    }

    openNewTerminal();
  });

  /** Opens a fresh PTY (mount, and issue #582's retry): arms this attempt's own bounded wait and re-subscribes `onTerminalOutput` to the new `terminalId` — never reused, per `RelayClient.openTerminal`'s own doc comment. */
  function openNewTerminal(): void {
    if (!terminal) return;
    unsubscribeOutput?.();
    status = 'opening';
    errorMessage = undefined;
    timedOut = false;
    terminalId = client.openTerminal(sessionId, terminal.cols, terminal.rows);
    const openedId = terminalId;
    unsubscribeOutput = client.onTerminalOutput(sessionId, openedId, (chunk) => {
      terminal?.write(chunk);
    });
    armOpenTimeout();
  }

  /** Retry (issue #582): asks the node to close whichever attempt just timed out, then opens a genuinely new one — never just clears the local flag. */
  function retryTerminal(): void {
    clearOpenTimeout();
    const staleId = terminalId;
    if (staleId) client.closeTerminal(sessionId, staleId);
    openNewTerminal();
  }

  onDestroy(() => {
    unsubscribeOutput?.();
    unsubscribeState?.();
    clearOpenTimeout();
    resizeObserver?.disconnect();
    if (terminalId) client.closeTerminal(sessionId, terminalId);
    terminal?.dispose();
  });
</script>

<div
  class="interactive-terminal"
  class:focused
  data-testid="interactive-terminal"
  data-status={status}
  data-cols={liveCols}
  data-rows={liveRows}
>
  <div class="terminal-titlebar">
    <Icon name="tool-bash" class="terminal-titlebar-icon" />
    <StatusDot
      tone={statusTone}
      pulse={status === 'opening' && !timedOut}
      label={statusLabel}
      size="sm"
    />
    <span class="terminal-titlebar-label font-mono">Terminal</span>
  </div>

  {#if timedOut}
    <div class="terminal-timeout" data-testid="terminal-timeout">
      <ErrorNotice
        message="The terminal hasn't opened yet. This isn't necessarily a failure, we simply stopped waiting: the node may be asleep, offline, or slow to start the shell."
        retryable
        onRetry={retryTerminal}
      />
    </div>
  {:else if status !== 'open'}
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

  /* `:global` — this class lands on `Icon`'s own root `<svg>`, one
     component down, so Svelte's scoped-CSS hash on this file's stylesheet
     never reaches it without the escape hatch. */
  :global(.terminal-titlebar-icon) {
    flex-shrink: 0;
    color: var(--color-text-muted);
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
     this file's tests (a node-reported failure, e.g. "no shell
     available"), and `ErrorNotice` hardcodes its own `ui-error-notice`
     testid with no override. The client-side bounded-wait timeout state
     (issue #582, `.terminal-timeout` below) has no such legacy testid to
     preserve, so IT does render through `ErrorNotice` directly. */
  .status.error {
    color: var(--color-danger);
    background: var(--color-danger-subtle);
    border-bottom-color: var(--color-danger);
  }

  .terminal-timeout {
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border-subtle);
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
