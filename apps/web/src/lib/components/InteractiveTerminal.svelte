<script lang="ts">
  /**
   * The interactive PTY terminal (SPEC §7.5; issues #172/#173/#174), the
   * counterpart to `TerminalOutput.svelte`'s read-only rendering: this one
   * owns real xterm.js `Terminal` instances, opens PTYs on `sessionId`'s
   * target via `client.openTerminal`, writes decrypted output chunks
   * straight into them, and forwards every keystroke/resize back over
   * `client` as encrypted `terminal_input`/`terminal_resize` frames.
   * Reachability parity (#174): this is the ONE component used for both a
   * `local` and an `ssh:` target (the target kind is the node's concern,
   * invisible here) and for both desktop and a narrow/mobile viewport —
   * there is no separate mobile variant, only CSS (`.interactive-terminal`'s
   * `min-width: 0` + the container's own `overflow` below) adapting the
   * same markup.
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
   * One thin bar, not a card with its own titlebar (design spec
   * `2026-08-04-cockpit-v7-decisions.md` §4 D1-2, issue #669): this
   * component used to draw its own bordered card with a titlebar saying
   * "Terminal" — a second frame nested inside the dock's OWN header and
   * border, and a second copy of a word the dock's own toggle already
   * says. Both are gone. What remains is one thin bar carrying the
   * session's own working directory, the shell running the active PTY,
   * live connection status, and a control to open another terminal —
   * information a user would otherwise have to open a file tree to find,
   * not a label they already know. `cwd`/`shell` are real values read off
   * `TerminalClientState` (`terminalOpenOkV1`'s own fields, sealed under
   * the session key exactly like every other terminal frame) — never a
   * client-side guess: an isolated-worktree session's actual PTY directory
   * differs from the session's plain `projectPath`, which is the whole
   * reason this data is worth showing at all. `shell` is absent for an
   * `ssh:` target (the remote login shell is never named ahead of time —
   * see `openTerminalForBridge`'s own doc comment on the node), and the
   * bar simply omits that segment rather than guessing.
   *
   * Multiple terminals per session were always a real capability of the
   * wire protocol and this client's own store (`terminalsFor` returns a
   * `Map`, `openTerminal` documents that calling it again "opens an
   * ADDITIONAL terminal with its own id" sharing the session's working
   * directory) — the UI never exposed it. The bar's new-tab control
   * finally does: each open terminal is a `TabView`/`TabRuntime` pair (the
   * former holds the plain reactive fields the bar and pane render off,
   * the latter holds the imperative xterm.js/FitAddon/ResizeObserver
   * handles a `$state` proxy has no business wrapping), keyed by a
   * locally-generated `tabId` that never changes even when a retry
   * (issue #582, below) swaps out the underlying `terminalId` — exactly
   * mirroring this file's own pre-#669 single-terminal split between a
   * stable component instance and a mutable `terminalId`. Only the active
   * tab's pane is laid out (`.terminal-pane-active`); every other tab's
   * pane stays mounted at `display: none` so its PTY and scrollback
   * survive switching away from it, the same "never unmount to hide"
   * discipline `+page.svelte`'s own terminal dock already applies one
   * level up (see that file's `.terminal-dock` doc comment) — a hidden
   * pane's `ResizeObserver` firing once it's shown again is what re-fits
   * it, not a special case here.
   *
   * D2-2 (same spec section): this component's own card border/radius are
   * gone too — the dock one level up now supplies the surface (moved to
   * `--color-rail`) and the seam against the canvas (a colour step, no
   * hairline). Nothing here draws a border of its own to compensate.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§6,
   * issue #437) / Deck migration (redesign v2 design spec §2, issue #470):
   * predate #669 and described the now-removed titlebar/card; superseded
   * by the doc comment above, not restated here.
   *
   * Bounded wait + retry (issue #582): `status = 'opening'` has no ceiling
   * of its own — a mount/retry against a node that never answers a
   * `terminal_open` would sit "Connecting…" forever otherwise. Each tab
   * owns its own bounded wait (`OPEN_TIMEOUT_MS`) on top of
   * `TerminalClientState['status']`, which has no timeout of its own: a
   * tab still `'opening'` when its timer fires shows a local, retryable
   * `ErrorNotice` — worded, per `NewSessionDialog`'s identical "the agent
   * is taking a while" case (issue #516), to say plainly that a timeout
   * here does NOT mean the request failed, only that this client stopped
   * waiting; "the node may be asleep, offline" reuses the exact phrasing
   * `DirectoryPicker`/`ArchiveSessionDialog` already settled on (issue
   * #505), not a third one. A real answer, however late, still clears it.
   * Retry closes whichever attempt just timed out and opens a genuinely
   * new one on the SAME tab (`RelayClient.openTerminal`'s own doc
   * comment: calling it again opens an ADDITIONAL terminal with its own
   * id) — never just clears the flag. This is a SEPARATE failure surface
   * from the hand-rolled `.status.error` banner: that one still renders
   * verbatim node-reported errors (e.g. "no shell available") under the
   * load-bearing `terminal-status` testid this file's other tests pin
   * down; the timeout state has no such legacy constraint, so it uses
   * `ErrorNotice` directly.
   *
   * Bottom dock + real resize (issue #572): `onMount` below loads
   * `@xterm/addon-fit` per tab and calls `fitAddon.fit()` (which calls
   * `terminal.resize()`, which is what actually fires `onResize`) both
   * right after that tab's `terminal.open` and on every `ResizeObserver`
   * notification for its own container — covering the initial mount, a
   * continuous height drag, AND becoming visible again after the dock
   * collapsed it to nothing or after switching tabs, all through the one
   * mechanism. `liveCols`/`liveRows` on the active tab mirror whatever
   * `onResize` last reported as `data-cols`/`data-rows` on the root
   * element — a plain, real-browser-and-test-both observable proof that a
   * resize actually reflowed the terminal, not just its CSS box.
   */
  import { onDestroy, onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import type { TerminalClient } from '$lib/terminal';
  import type { TerminalClientState } from '$lib/relay-client';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { Icon } from './icons';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  interface Props {
    sessionId: string;
    client: TerminalClient;
    /** Initial PTY size before xterm.js's own layout can report real dimensions; a later `terminal.onResize` corrects this once it knows the container's actual size. Applies to every tab opened by this component instance, not just the first. */
    cols?: number;
    rows?: number;
  }

  const { sessionId, client, cols = 80, rows = 24 }: Props = $props();

  /** One open terminal's plain reactive fields — everything the bar and its pane render off. Deliberately holds nothing imperative (xterm.js instances, timers, subscriptions): see `TabRuntime` for that half of the split. */
  interface TabView {
    /** Stable for this tab's whole lifetime, unlike `TabRuntime.terminalId` below — a retry (issue #582) swaps the underlying terminal without this id (or this tab's xterm.js instance/scrollback) changing. */
    id: string;
    status: TerminalClientState['status'];
    errorMessage?: string;
    /** See this file's own top doc comment ("Bounded wait + retry"). */
    timedOut: boolean;
    liveCols: number;
    liveRows: number;
    /** Set once `status` is `'open'` — real values off `TerminalClientState`, never guessed (see the top doc comment). */
    cwd?: string;
    shell?: string;
  }

  /** One open terminal's imperative handles — never placed in a `$state` array/object: `Terminal`/`FitAddon`/`ResizeObserver`/timer handles are opaque class instances a reactive proxy has no business wrapping, and mutating them should never itself trigger a re-render (only `TabView`'s plain fields should). Keyed by `tabId` in the module-level `runtimes` map below, mirroring `TabView.id`. */
  interface TabRuntime {
    terminal: Terminal;
    fitAddon?: FitAddon;
    resizeObserver?: ResizeObserver;
    /** The CURRENT terminal_open's id — reassigned on retry (issue #582), which is exactly why `onData`/`onResize` below read it through this mutable field rather than closing over a value captured at mount. */
    terminalId?: string;
    unsubscribeOutput?: () => void;
    unsubscribeResync?: () => void;
    openTimeoutHandle?: ReturnType<typeof setTimeout>;
  }

  let tabs = $state<TabView[]>([]);
  let activeTabId = $state<string | undefined>(undefined);
  /** DOM-focus tracking only, for the pane's focus-visible ring (chrome, not I/O) — xterm.js mounts a hidden textarea inside a pane's container to capture keystrokes, so a bubbling `focusin`/`focusout` pair on it is enough to know the active PTY has focus. Only the active pane can ever hold real DOM focus (every other pane's container is `display: none`), so one flag for the whole component is enough — no need to track it per tab. */
  let focused = $state(false);

  const runtimes = new SvelteMap<string, TabRuntime>();
  let nextTabSeq = 0;
  let unsubscribeState: (() => void) | undefined;

  const activeTab = $derived(tabs.find((tab) => tab.id === activeTabId));

  const statusTone = $derived<StatusTone>(
    !activeTab
      ? 'neutral'
      : activeTab.timedOut
        ? 'danger'
        : activeTab.status === 'open'
          ? 'success'
          : activeTab.status === 'error'
            ? 'danger'
            : activeTab.status === 'closed'
              ? 'neutral'
              : 'info',
  );

  /** The dot's accessible name — full sentence, unlike `statusWord` below (the bar's short VISIBLE text), mirroring the split `StatusDot` itself documents between a decorative dot and real meaning. */
  const statusLabel = $derived(
    !activeTab
      ? 'Terminal'
      : activeTab.timedOut
        ? 'Terminal timed out waiting to open'
        : activeTab.status === 'open'
          ? 'Terminal connected'
          : activeTab.status === 'opening'
            ? 'Terminal connecting'
            : activeTab.status === 'error'
              ? `Terminal error: ${activeTab.errorMessage ?? 'unknown error'}`
              : 'Terminal closed',
  );

  /** The bar's own short, VISIBLE connection-status word (issue #669's acceptance: "shows... connection status", not just an aria-label on a dot no sighted user reads). */
  const statusWord = $derived(
    !activeTab
      ? ''
      : activeTab.timedOut
        ? 'Timed out'
        : activeTab.status === 'open'
          ? 'Connected'
          : activeTab.status === 'opening'
            ? 'Connecting…'
            : activeTab.status === 'error'
              ? 'Error'
              : 'Closed',
  );

  /** The shell's own file name (`/bin/zsh` -> `zsh`) — the bar shows the short, readable form; the full path is still available as the segment's `title` tooltip. */
  const shellName = $derived(activeTab?.shell ? basename(activeTab.shell) : undefined);

  function basename(path: string): string {
    const index = path.lastIndexOf('/');
    return index === -1 ? path : path.slice(index + 1);
  }

  /** Reads a design token off `:root` at mount time so the xterm.js canvas (which cannot see CSS custom properties) draws from the same palette as everything around it, falling back to the dark/ink default for environments with no stylesheet (e.g. this file's jsdom tests). */
  function readToken(name: string, fallback: string): string {
    if (typeof getComputedStyle !== 'function') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  /** How long a tab's own PTY handshake may sit `'opening'` before this component gives up waiting on its own (issue #582) — `TerminalClientState` carries no timeout of its own. 10s matches every other request-shaped `RelayClient` default. */
  const OPEN_TIMEOUT_MS = 10_000;

  function clearTabOpenTimeout(tabId: string): void {
    const runtime = runtimes.get(tabId);
    if (!runtime || runtime.openTimeoutHandle === undefined) return;
    clearTimeout(runtime.openTimeoutHandle);
    runtime.openTimeoutHandle = undefined;
  }

  function armOpenTimeout(tabId: string): void {
    clearTabOpenTimeout(tabId);
    const runtime = runtimes.get(tabId);
    if (!runtime) return;
    runtime.openTimeoutHandle = setTimeout(() => {
      runtime.openTimeoutHandle = undefined;
      const view = tabs.find((tab) => tab.id === tabId);
      if (view) view.timedOut = true;
    }, OPEN_TIMEOUT_MS);
  }

  /** Opens a fresh PTY on `tabId` (first open, and issue #582's retry): arms this attempt's own bounded wait and re-subscribes `onTerminalOutput` to the new `terminalId` — never reused, per `RelayClient.openTerminal`'s own doc comment. */
  function openWireTerminal(tabId: string): void {
    const runtime = runtimes.get(tabId);
    const view = tabs.find((tab) => tab.id === tabId);
    if (!runtime || !view) return;
    view.status = 'opening';
    view.errorMessage = undefined;
    view.timedOut = false;
    runtime.unsubscribeOutput?.();
    runtime.unsubscribeResync?.();
    const terminalId = client.openTerminal(sessionId, runtime.terminal.cols, runtime.terminal.rows);
    runtime.terminalId = terminalId;
    runtime.unsubscribeOutput = client.onTerminalOutput(sessionId, terminalId, (chunk) => {
      runtime.terminal.write(chunk);
    });
    // SPEC §7.16/issue #207: a slow client's bounded terminal_output queue
    // drops the oldest chunks under a sustained burst rather than blocking
    // the pipe — this renders that drop VISIBLY (a dim, bracketed gap
    // notice) instead of the scrollback silently missing bytes with no
    // indication anything was lost.
    runtime.unsubscribeResync = client.onTerminalResync(sessionId, terminalId, () => {
      runtime.terminal.write(
        '\r\n\x1b[2m[--- output dropped: client too slow to keep up ---]\x1b[0m\r\n',
      );
    });
    armOpenTimeout(tabId);
  }

  /** Retry (issue #582): asks the node to close whichever attempt just timed out, then opens a genuinely new one on the SAME tab — never just clears the local flag. */
  function retryTab(tabId: string): void {
    clearTabOpenTimeout(tabId);
    const staleId = runtimes.get(tabId)?.terminalId;
    if (staleId) client.closeTerminal(sessionId, staleId);
    openWireTerminal(tabId);
  }

  /** The bar's new-tab control (design spec §4 D1-2): opens an ADDITIONAL terminal for this session (they already share `worktreePath` on the node — issue #173) and switches to it. */
  function addTab(): void {
    const tabId = `tab-${nextTabSeq++}`;
    const terminal = new Terminal({
      cols,
      rows,
      fontFamily: readToken('--font-mono', 'ui-monospace, monospace'),
      fontSize: 13,
      theme: {
        background: readToken('--color-bg', '#1a2732'),
        foreground: readToken('--color-text-primary', '#eef0f2'),
        cursor: readToken('--color-accent', '#64baff'),
        cursorAccent: readToken('--color-bg', '#1a2732'),
        selectionBackground: readToken('--color-accent-subtle', 'rgba(100, 186, 255, 0.35)'),
      },
    });
    runtimes.set(tabId, { terminal });
    tabs.push({
      id: tabId,
      status: 'opening',
      errorMessage: undefined,
      timedOut: false,
      liveCols: terminal.cols,
      liveRows: terminal.rows,
      cwd: undefined,
      shell: undefined,
    });
    activeTabId = tabId;
    openWireTerminal(tabId);
  }

  /** Closes one tab's terminal for good (never the last one — the bar always shows at least one, so the close control itself is hidden once only one remains). Removing the entry from `tabs` unmounts that tab's pane, whose `mountTerminalPane` action `destroy()` below does the actual PTY-close/dispose/unsubscribe work — one cleanup path shared with whole-component teardown, not two. */
  function closeTab(tabId: string): void {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    tabs.splice(index, 1);
    if (activeTabId === tabId) {
      activeTabId = (tabs[index] ?? tabs[index - 1] ?? tabs[0])?.id;
    }
  }

  /** The full teardown for one tab's terminal — shared by an explicit `closeTab` and by this component's own unmount (Svelte destroys every `{#each}` node, firing this same action `destroy()` for each remaining tab), exactly mirroring the pre-#669 single-terminal `onDestroy`. */
  function cleanupTab(tabId: string): void {
    const runtime = runtimes.get(tabId);
    if (!runtime) return;
    runtimes.delete(tabId);
    runtime.unsubscribeOutput?.();
    runtime.unsubscribeResync?.();
    clearTabOpenTimeout(tabId);
    runtime.resizeObserver?.disconnect();
    if (runtime.terminalId) client.closeTerminal(sessionId, runtime.terminalId);
    runtime.terminal.dispose();
  }

  /**
   * A Svelte action, not a `bind:this` + effect: it gives this exact pane's
   * container node the moment it enters the DOM (first render of a new
   * tab, or a tab reappearing after the whole component remounts — never
   * on a mere tab SWITCH, since an inactive pane stays mounted at
   * `display: none` rather than being torn down) and again the moment it
   * leaves, which is precisely the mount/unmount pairing this file's
   * pre-#669 single terminal got for free from `onMount`/`onDestroy`.
   */
  function mountTerminalPane(node: HTMLDivElement, tabId: string): { destroy(): void } {
    const runtime = runtimes.get(tabId);
    if (!runtime) return { destroy() {} };
    const { terminal } = runtime;
    terminal.open(node);

    // Reads the CURRENT `runtime.terminalId` at send time rather than
    // closing over one captured here — issue #582's retry opens an
    // ADDITIONAL terminal with a new id on this SAME tab, and these two
    // listeners, registered once, must follow it there.
    terminal.onData((data) => {
      if (runtime.terminalId) client.sendTerminalInput(sessionId, runtime.terminalId, data);
    });

    terminal.onResize(({ cols: newCols, rows: newRows }) => {
      const view = tabs.find((tab) => tab.id === tabId);
      if (view) {
        view.liveCols = newCols;
        view.liveRows = newRows;
      }
      if (runtime.terminalId)
        client.resizeTerminal(sessionId, runtime.terminalId, newCols, newRows);
    });

    // See this file's own top doc comment ("Bottom dock + real resize",
    // issue #572) for why a `ResizeObserver`, not a `pointermove` listener,
    // is the coalescing mechanism, and why it doubles as the "becoming
    // visible again" fit — here that covers a dock resize AND switching
    // back to this tab, through the one mechanism. Guarded for `jsdom` (no
    // `ResizeObserver`); the real `@xterm/addon-fit` package runs unmocked
    // against this file's own `FakeTerminal` regardless —
    // `proposeDimensions()` bails out on the missing `terminal.element` a
    // real `Terminal.open()` would have set, so `fit()` is a safe no-op
    // here and a real resize in a real browser.
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    runtime.fitAddon = fitAddon;
    fitAddon.fit();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => fitAddon.fit());
      observer.observe(node);
      runtime.resizeObserver = observer;
    }

    return {
      destroy() {
        cleanupTab(tabId);
      },
    };
  }

  onMount(() => {
    // One subscription for the whole component (not per tab): every open
    // terminal for this session lands in the same `terminalsFor` map, so a
    // single callback can update whichever tab(s) it names by matching
    // each tab's CURRENT `runtime.terminalId`.
    unsubscribeState = client.terminalsFor(sessionId).subscribe((map) => {
      for (const tab of tabs) {
        const runtime = runtimes.get(tab.id);
        if (!runtime?.terminalId) continue;
        const state = map.get(runtime.terminalId);
        if (!state) continue;
        tab.status = state.status;
        tab.errorMessage = state.error;
        tab.cwd = state.cwd;
        tab.shell = state.shell;
        // A real answer, however late, is the honest resolution of this
        // tab's own bounded wait (issue #582's "a timeout does not mean
        // the request failed" only holds if a late answer still lands).
        if (state.status !== 'opening') {
          clearTabOpenTimeout(tab.id);
          tab.timedOut = false;
        }
      }
    });

    addTab();
  });

  onDestroy(() => {
    unsubscribeState?.();
  });
</script>

<div
  class="interactive-terminal"
  data-testid="interactive-terminal"
  data-status={activeTab?.status}
  data-cols={activeTab?.liveCols ?? 0}
  data-rows={activeTab?.liveRows ?? 0}
>
  <div class="terminal-bar" data-testid="terminal-bar">
    <StatusDot
      tone={statusTone}
      pulse={activeTab?.status === 'opening' && !activeTab?.timedOut}
      label={statusLabel}
      size="sm"
    />
    <span class="terminal-bar-status font-mono" data-testid="terminal-bar-status">{statusWord}</span
    >
    {#if activeTab?.cwd}
      <span class="terminal-bar-sep" aria-hidden="true">·</span>
      <span class="terminal-bar-cwd font-mono" title={activeTab.cwd} data-testid="terminal-bar-cwd">
        {activeTab.cwd}
      </span>
    {/if}
    {#if shellName}
      <span class="terminal-bar-sep" aria-hidden="true">·</span>
      <span
        class="terminal-bar-shell font-mono"
        title={activeTab?.shell}
        data-testid="terminal-bar-shell"
      >
        {shellName}
      </span>
    {/if}
    <div class="terminal-bar-spacer"></div>
    {#if tabs.length > 1}
      <div class="terminal-tabs" role="tablist" aria-label="Terminals" data-testid="terminal-tabs">
        {#each tabs as tab, index (tab.id)}
          <span class="terminal-tab" class:selected={tab.id === activeTabId}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              class="terminal-tab-select font-mono"
              onclick={() => (activeTabId = tab.id)}
              data-testid="terminal-tab"
            >
              {index + 1}
            </button>
            <IconButton
              label={`Close terminal ${index + 1}`}
              size="sm"
              onclick={() => closeTab(tab.id)}
              dataTestId="terminal-tab-close"
            >
              <Icon name="close" size="var(--icon-size-sm)" />
            </IconButton>
          </span>
        {/each}
      </div>
    {/if}
    <IconButton label="New terminal" onclick={addTab} dataTestId="terminal-new-tab">
      <Icon name="plus" size="var(--icon-size-md)" />
    </IconButton>
  </div>

  {#each tabs as tab (tab.id)}
    <div class="terminal-pane" class:terminal-pane-active={tab.id === activeTabId}>
      {#if tab.timedOut}
        <div class="terminal-timeout" data-testid="terminal-timeout">
          <ErrorNotice
            message="The terminal hasn't opened yet. This isn't necessarily a failure, we simply stopped waiting: the node may be asleep, offline, or slow to start the shell."
            retryable
            onRetry={() => retryTab(tab.id)}
          />
        </div>
      {:else if tab.status !== 'open'}
        <div class="status" class:error={tab.status === 'error'} data-testid="terminal-status">
          {#if tab.status === 'opening'}
            Connecting…
          {:else if tab.status === 'error'}
            {tab.errorMessage ?? 'Terminal error'}
          {:else if tab.status === 'closed'}
            Closed
          {/if}
        </div>
      {/if}

      <div
        class="xterm-container"
        class:focused={tab.id === activeTabId && focused}
        data-testid="xterm-container"
        onfocusin={() => (focused = true)}
        onfocusout={() => (focused = false)}
      >
        <div class="xterm-canvas" use:mountTerminalPane={tab.id}></div>
      </div>
    </div>
  {/each}
</div>

<style>
  .interactive-terminal {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }

  /* One thin bar (design spec §4 D1-2, issue #669) replacing the old
     bordered card's titlebar: no border/background of its own beyond a
     hairline UNDER it separating it from the pane — the dock one level up
     (`+page.svelte`'s `.terminal-dock`) now supplies the surface. */
  .terminal-bar {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-shrink: 0;
    padding: var(--space-2xs) var(--space-xs);
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .terminal-bar-status {
    flex-shrink: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .terminal-bar-sep {
    flex-shrink: 0;
    color: var(--color-text-muted);
  }

  /* The cwd segment is the one allowed to truncate — it's the longest and
     least predictable value on the bar; `shell`/status/tabs stay fixed
     width either side of it. */
  .terminal-bar-cwd {
    min-width: 3rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  .terminal-bar-shell {
    flex-shrink: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  .terminal-bar-spacer {
    flex: 1;
    min-width: var(--space-sm);
  }

  .terminal-tabs {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    flex-shrink: 0;
  }

  .terminal-tab {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }

  .terminal-tab-select {
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 var(--space-2xs);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--text-caption-size);
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .terminal-tab-select:hover {
    background: var(--color-fill-subtle);
  }

  .terminal-tab-select:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .terminal-tab.selected .terminal-tab-select {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  .terminal-pane {
    display: none;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }

  /* Kept mounted at `display: none` rather than removed (this file's own
     top doc comment: a `ResizeObserver` firing when this pane is shown
     again is what re-fits it, the same mechanism `+page.svelte`'s dock
     collapse/reopen already relies on). */
  .terminal-pane.terminal-pane-active {
    display: flex;
  }

  .status {
    padding: var(--space-xs) var(--space-sm);
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
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
  }

  .terminal-timeout {
    padding: var(--space-xs) var(--space-sm);
  }

  /* This wrapper carries the ONLY padding around the terminal now — it
     used to sit directly on the element passed to `terminal.open()` /
     `FitAddon`, which over-proposed rows (issue #663). `FitAddon`'s
     `proposeDimensions()` reads the available height off
     `getComputedStyle(terminal.element.parentElement).height`; with
     `box-sizing: border-box` (`typography.css`) that is this element's
     BORDER-box height, padding included, and it then tries to subtract
     padding read off `terminal.element` itself (xterm.js's own `.xterm`
     root, which `@xterm/xterm`'s stylesheet always leaves unpadded) —
     never off this element. Padding living HERE therefore silently
     escaped that arithmetic: xterm proposed however many extra rows the
     unaccounted 2×`--space-2xs` (8px) didn't add up to a whole cell
     height, exactly xtermjs/xterm.js#2958's "4 rows proposed against 2.5
     visible" and the blank space Lorenzo saw. `display: flex` so
     `.xterm-canvas` below fills this element's CONTENT box exactly,
     outside the padding. */
  .xterm-container {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: var(--space-2xs);
    overflow: hidden;
    box-shadow: inset 0 0 0 0 transparent;
    transition: box-shadow var(--duration-fast) var(--ease-beat);
  }

  /* The element `terminal.open()` actually receives, and the one
     `FitAddon`/the `ResizeObserver` above measure (issue #663): zero
     padding of its own, so its border-box IS the full space genuinely
     available to xterm.js — nothing left for `FitAddon` to miscount, and
     nothing for its canvas to overflow into `.xterm-container`'s padding
     and get clipped by that element's own `overflow: hidden`. */
  .xterm-canvas {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* The card's own focused-state border used to carry this signal; with
     the card gone (D1-2), an inset ring on the pane itself is the
     replacement — real chrome only while the PTY genuinely has DOM focus,
     never a second permanent frame. */
  .xterm-container.focused {
    box-shadow: inset 0 0 0 1px var(--color-focus-ring);
  }
</style>
