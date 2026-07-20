// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable, type Writable } from 'svelte/store';
import type { TerminalClientState } from '$lib/relay-client';
import type { TerminalClient } from '$lib/terminal';

/**
 * ENVIRONMENT NOTE (headless devbox, no browser): xterm.js renders to a
 * `<canvas>`, which cannot be exercised here — `@xterm/xterm` is fully
 * mocked below so this file proves the component's DATA FLOW (output ->
 * `terminal.write`, keystroke -> `sendTerminalInput`, resize ->
 * `resizeTerminal`) rather than any real visual rendering, per
 * `InteractiveTerminal.svelte`'s own doc comment.
 */
const { FakeTerminal, instances } = vi.hoisted(() => {
  class FakeTerminal {
    cols: number;
    rows: number;
    disposed = false;
    written: unknown[] = [];
    openedOn: unknown;
    private dataListeners: Array<(data: string) => void> = [];
    private resizeListeners: Array<(event: { cols: number; rows: number }) => void> = [];

    constructor(options: { cols: number; rows: number }) {
      this.cols = options.cols;
      this.rows = options.rows;
    }

    open(container: unknown): void {
      this.openedOn = container;
    }

    write(data: unknown): void {
      this.written.push(data);
    }

    onData(listener: (data: string) => void): void {
      this.dataListeners.push(listener);
    }

    onResize(listener: (event: { cols: number; rows: number }) => void): void {
      this.resizeListeners.push(listener);
    }

    dispose(): void {
      this.disposed = true;
    }

    /** Test-only: simulates the user typing. */
    emitData(data: string): void {
      for (const listener of this.dataListeners) listener(data);
    }

    /** Test-only: simulates xterm.js's own layout deciding on a new size. */
    emitResize(cols: number, rows: number): void {
      for (const listener of this.resizeListeners) listener({ cols, rows });
    }
  }

  const instances: FakeTerminal[] = [];
  const TrackedFakeTerminal = class extends FakeTerminal {
    constructor(options: { cols: number; rows: number }) {
      super(options);
      instances.push(this);
    }
  };
  return { FakeTerminal: TrackedFakeTerminal, instances };
});

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));

// Imported AFTER vi.mock (vitest hoists vi.mock calls above imports anyway,
// but this ordering keeps the file readable top-to-bottom).
const { default: InteractiveTerminal } = await import('./InteractiveTerminal.svelte');

afterEach(() => {
  cleanup();
  instances.length = 0;
  vi.restoreAllMocks();
});

/** A minimal fake `TerminalClient` (mirrors `RelayClient`'s terminal methods) with no real crypto/WebSocket involved. */
function fakeClient(): TerminalClient & {
  terminalStore: Writable<Map<string, TerminalClientState>>;
  openCalls: Array<{ sessionId: string; cols: number; rows: number }>;
  inputCalls: Array<{ sessionId: string; terminalId: string; data: Uint8Array | string }>;
  resizeCalls: Array<{ sessionId: string; terminalId: string; cols: number; rows: number }>;
  closeCalls: Array<{ sessionId: string; terminalId: string }>;
  emitOutput(sessionId: string, terminalId: string, chunk: Uint8Array): void;
} {
  const terminalStore = writable<Map<string, TerminalClientState>>(new Map());
  const outputListeners = new Map<string, Set<(chunk: Uint8Array) => void>>();
  const openCalls: Array<{ sessionId: string; cols: number; rows: number }> = [];
  const inputCalls: Array<{ sessionId: string; terminalId: string; data: Uint8Array | string }> =
    [];
  const resizeCalls: Array<{ sessionId: string; terminalId: string; cols: number; rows: number }> =
    [];
  const closeCalls: Array<{ sessionId: string; terminalId: string }> = [];
  let nextId = 0;

  return {
    terminalStore,
    openCalls,
    inputCalls,
    resizeCalls,
    closeCalls,
    terminalsFor: () => terminalStore,
    openTerminal(sessionId: string, cols: number, rows: number) {
      openCalls.push({ sessionId, cols, rows });
      const terminalId = `term-${nextId++}`;
      terminalStore.update((map) => {
        const next = new Map(map);
        next.set(terminalId, { terminalId, status: 'opening' });
        return next;
      });
      return terminalId;
    },
    sendTerminalInput(sessionId: string, terminalId: string, data: Uint8Array | string) {
      inputCalls.push({ sessionId, terminalId, data });
    },
    resizeTerminal(sessionId: string, terminalId: string, cols: number, rows: number) {
      resizeCalls.push({ sessionId, terminalId, cols, rows });
    },
    closeTerminal(sessionId: string, terminalId: string) {
      closeCalls.push({ sessionId, terminalId });
    },
    onTerminalOutput(sessionId: string, terminalId: string, listener: (chunk: Uint8Array) => void) {
      const key = `${sessionId}:${terminalId}`;
      let listeners = outputListeners.get(key);
      if (!listeners) {
        listeners = new Set();
        outputListeners.set(key, listeners);
      }
      listeners.add(listener);
      return () => listeners!.delete(listener);
    },
    emitOutput(sessionId: string, terminalId: string, chunk: Uint8Array) {
      const listeners = outputListeners.get(`${sessionId}:${terminalId}`);
      if (listeners) for (const listener of listeners) listener(chunk);
    },
    setStatus(terminalId: string, state: TerminalClientState) {
      terminalStore.update((map) => {
        const next = new Map(map);
        next.set(terminalId, state);
        return next;
      });
    },
  } as unknown as TerminalClient & {
    terminalStore: Writable<Map<string, TerminalClientState>>;
    openCalls: typeof openCalls;
    inputCalls: typeof inputCalls;
    resizeCalls: typeof resizeCalls;
    closeCalls: typeof closeCalls;
    emitOutput(sessionId: string, terminalId: string, chunk: Uint8Array): void;
    setStatus(terminalId: string, state: TerminalClientState): void;
  };
}

describe('InteractiveTerminal (SPEC §7.5; issues #172/#173/#174) — data flow with xterm.js mocked', () => {
  it('opens a terminal on mount and shows "Connecting…" while status is opening', () => {
    const client = fakeClient();
    render(InteractiveTerminal, { props: { sessionId: 'sess-1', client } });

    expect(client.openCalls).toEqual([{ sessionId: 'sess-1', cols: 80, rows: 24 }]);
    expect(screen.getByTestId('terminal-status').textContent?.trim()).toBe('Connecting…');
    expect(instances).toHaveLength(1);
  });

  it('flips to the open view once terminalsFor reports status open', async () => {
    const client = fakeClient();
    render(InteractiveTerminal, { props: { sessionId: 'sess-1', client } });

    // Find the terminalId the component was given.
    let openedTerminalId = '';
    client.terminalStore.subscribe((map) => {
      const [id] = map.keys();
      if (id) openedTerminalId = id;
    })();

    (client as unknown as { setStatus: (id: string, s: TerminalClientState) => void }).setStatus(
      openedTerminalId,
      { terminalId: openedTerminalId, status: 'open' },
    );

    await waitFor(() => {
      expect(screen.queryByTestId('terminal-status')).toBeNull();
    });
  });

  it('output -> terminal.write: a chunk delivered via onTerminalOutput is written to the xterm.js instance', () => {
    const client = fakeClient();
    render(InteractiveTerminal, { props: { sessionId: 'sess-1', client } });

    let openedTerminalId = '';
    client.terminalStore.subscribe((map) => {
      const [id] = map.keys();
      if (id) openedTerminalId = id;
    })();

    const chunk = new TextEncoder().encode('hello from the shell');
    (client as unknown as { emitOutput: (s: string, t: string, c: Uint8Array) => void }).emitOutput(
      'sess-1',
      openedTerminalId,
      chunk,
    );

    expect(instances[0]?.written).toEqual([chunk]);
  });

  it('keystroke -> encrypted send: xterm.js onData fires sendTerminalInput with the typed data', () => {
    const client = fakeClient();
    render(InteractiveTerminal, { props: { sessionId: 'sess-1', client } });

    let openedTerminalId = '';
    client.terminalStore.subscribe((map) => {
      const [id] = map.keys();
      if (id) openedTerminalId = id;
    })();

    (instances[0] as unknown as { emitData: (data: string) => void }).emitData('echo hi\n');

    expect(client.inputCalls).toEqual([
      { sessionId: 'sess-1', terminalId: openedTerminalId, data: 'echo hi\n' },
    ]);
  });

  it('resize -> resize frame: xterm.js onResize fires resizeTerminal with the new cols/rows', () => {
    const client = fakeClient();
    render(InteractiveTerminal, { props: { sessionId: 'sess-1', client } });

    let openedTerminalId = '';
    client.terminalStore.subscribe((map) => {
      const [id] = map.keys();
      if (id) openedTerminalId = id;
    })();

    (instances[0] as unknown as { emitResize: (cols: number, rows: number) => void }).emitResize(
      120,
      40,
    );

    expect(client.resizeCalls).toEqual([
      { sessionId: 'sess-1', terminalId: openedTerminalId, cols: 120, rows: 40 },
    ]);
  });

  it('closes the terminal and disposes xterm.js on unmount', () => {
    const client = fakeClient();
    const { unmount } = render(InteractiveTerminal, { props: { sessionId: 'sess-1', client } });

    let openedTerminalId = '';
    client.terminalStore.subscribe((map) => {
      const [id] = map.keys();
      if (id) openedTerminalId = id;
    })();

    unmount();

    expect(client.closeCalls).toEqual([{ sessionId: 'sess-1', terminalId: openedTerminalId }]);
    expect(instances[0]?.disposed).toBe(true);
  });

  it('shows an error message when status flips to error', async () => {
    const client = fakeClient();
    render(InteractiveTerminal, { props: { sessionId: 'sess-1', client } });

    let openedTerminalId = '';
    client.terminalStore.subscribe((map) => {
      const [id] = map.keys();
      if (id) openedTerminalId = id;
    })();

    (client as unknown as { setStatus: (id: string, s: TerminalClientState) => void }).setStatus(
      openedTerminalId,
      { terminalId: openedTerminalId, status: 'error', error: 'no shell available' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('terminal-status').textContent?.trim()).toBe('no shell available');
    });
  });

  it('reachability parity (#174): the same component/data flow behaves identically at a desktop and a narrow/mobile container width (structural — actual visual rendering is browser-only)', () => {
    for (const width of ['1200px', '320px']) {
      const client = fakeClient();
      const { container, unmount } = render(InteractiveTerminal, {
        props: { sessionId: 'sess-narrow', client },
      });
      container.style.width = width;

      expect(client.openCalls).toEqual([{ sessionId: 'sess-narrow', cols: 80, rows: 24 }]);
      expect(screen.getByTestId('xterm-container')).toBeTruthy();

      let openedTerminalId = '';
      client.terminalStore.subscribe((map) => {
        const [id] = map.keys();
        if (id) openedTerminalId = id;
      })();
      (instances.at(-1) as unknown as { emitData: (data: string) => void }).emitData('x');
      expect(client.inputCalls).toEqual([
        { sessionId: 'sess-narrow', terminalId: openedTerminalId, data: 'x' },
      ]);

      unmount();
      instances.length = 0;
    }
  });
});
