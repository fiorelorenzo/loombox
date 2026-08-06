// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTranscriptState,
  type TranscriptGapItem,
  type TranscriptItem,
  type TranscriptToolCallItem,
} from '@loombox/providers-core/browser';
import TranscriptTimeline from './TranscriptTimeline.svelte';

afterEach(() => cleanup());

function toolCallItem(
  id: string,
  extra: Partial<TranscriptToolCallItem> = {},
): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id,
    turnId: 't1',
    title: `tool ${id}`,
    toolKind: undefined,
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    ...extra,
  };
}

function toolCalls(count: number): TranscriptToolCallItem[] {
  return Array.from({ length: count }, (_, i) => toolCallItem(`tc${i}`));
}

function propsFor(items: TranscriptItem[], sessionKey: string) {
  return {
    sessionKey,
    items,
    transcript: { ...createTranscriptState(), items },
    turnActive: false,
    providerId: 'claude',
    permissionHead: undefined,
  };
}

function renderTimeline(items: TranscriptItem[], sessionKey = 'sess_1') {
  return render(TranscriptTimeline, { props: propsFor(items, sessionKey) });
}

/**
 * jsdom never runs layout: `clientHeight`/`scrollHeight`/`getBoundingClientRect`
 * are always 0 on every element, and there is no `ResizeObserver`. That is
 * exactly what makes the windowing engine's `pinToTail` fallback (issue
 * #755, `windowing.svelte.ts`'s own `TRANSCRIPT_MIN_PINNED_ITEMS`)
 * deterministic here — every row stays at the flat estimate, and
 * `viewportPx` never moves off 0 (nothing here re-triggers
 * `measureContainer`'s one synchronous read). The pin/anchor *pixel* math
 * itself is proven directly against `TranscriptWindow` in
 * `windowing.test.ts`; this file stubs a real container's scroll geometry
 * only where it needs to prove the component actually wires that engine up
 * to real DOM reads/writes (`el.scrollTop`/`el.scrollHeight`) and to the
 * follow/detach state machine.
 */
function stubScrollGeometry(
  el: HTMLElement,
  initial: { scrollHeight: number; clientHeight: number; scrollTop?: number },
) {
  let scrollTop = initial.scrollTop ?? 0;
  let scrollHeight = initial.scrollHeight;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: initial.clientHeight,
  });
  return {
    get scrollTop() {
      return scrollTop;
    },
    setScrollHeight(value: number) {
      scrollHeight = value;
    },
  };
}

describe('TranscriptTimeline: mounts a bounded window, not the whole transcript (issue #755)', () => {
  it('a 2000-item transcript mounts far fewer than 2000 rows', () => {
    renderTimeline(toolCalls(2000));

    const rows = screen.getAllByTestId('transcript-row');
    expect(rows.length).toBeLessThan(60);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('a short transcript that fits well within the window mounts every item', () => {
    renderTimeline(toolCalls(5));
    expect(screen.getAllByTestId('transcript-row')).toHaveLength(5);
  });

  it('still renders the tool-call "compact" rhythm class on a mounted row following another tool_call', () => {
    renderTimeline(toolCalls(3));
    const rows = screen.getAllByTestId('transcript-row');
    expect(rows[0]!.className).not.toContain('tool-call-compact');
    expect(rows[1]!.className).toContain('tool-call-compact');
    expect(rows[2]!.className).toContain('tool-call-compact');
  });
});

describe('TranscriptTimeline: follow/pin-to-bottom (issue #508, extended by #755)', () => {
  it('a later chunk that grows real scrollHeight keeps following rather than landing below the fold', async () => {
    const { rerender } = renderTimeline(toolCalls(30));
    const container = screen.getByTestId('transcript-items');
    // The pin effect already ran once at mount, against jsdom's real
    // (always-zero) geometry; stub it, then trigger the effect again the
    // same way real new content does — a changed `items` reference — to
    // observe it read the stubbed `scrollHeight`.
    const geometry = stubScrollGeometry(container, { scrollHeight: 900, clientHeight: 400 });
    await rerender(propsFor(toolCalls(31), 'sess_1'));
    expect(geometry.scrollTop).toBe(900);

    // A further chunk grows the real container taller still (issue #508's
    // own scenario: streamed output arriving below the fold).
    geometry.setScrollHeight(1100);
    await rerender(propsFor(toolCalls(32), 'sess_1'));
    expect(geometry.scrollTop).toBe(1100);
    expect(screen.queryByTestId('transcript-jump-latest')).toBeNull();
  });

  it('stops following once the reader scrolls away, and offers Jump to latest', async () => {
    renderTimeline(toolCalls(30));
    const container = screen.getByTestId('transcript-items');
    // A real scroll: the browser would already have moved `scrollTop`
    // before dispatching the event — the stub mirrors that, then the
    // `scroll` event is what `onScroll` reacts to.
    stubScrollGeometry(container, { scrollHeight: 900, clientHeight: 400, scrollTop: 100 });

    expect(screen.queryByTestId('transcript-jump-latest')).toBeNull();
    await fireEvent.scroll(container); // distance = 900 - 100 - 400 = 400 > 48px slack
    expect(screen.getByTestId('transcript-jump-latest')).toBeTruthy();
  });

  it('"Jump to latest" returns to the real bottom and hides itself again', async () => {
    renderTimeline(toolCalls(30));
    const container = screen.getByTestId('transcript-items');
    const geometry = stubScrollGeometry(container, {
      scrollHeight: 900,
      clientHeight: 400,
      scrollTop: 100,
    });
    await fireEvent.scroll(container);
    expect(screen.getByTestId('transcript-jump-latest')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('transcript-jump-latest'));

    expect(geometry.scrollTop).toBe(900);
    expect(screen.queryByTestId('transcript-jump-latest')).toBeNull();
  });

  it("a detached reader scrolling further does not get yanked back (issue #508's own regression)", async () => {
    renderTimeline(toolCalls(30));
    const container = screen.getByTestId('transcript-items');
    stubScrollGeometry(container, { scrollHeight: 900, clientHeight: 400, scrollTop: 100 });
    await fireEvent.scroll(container);
    expect(screen.getByTestId('transcript-jump-latest')).toBeTruthy();

    // Scrolling further while already detached must never itself move
    // `scrollTop` out from under the reader — the real browser already
    // put it exactly where they scrolled to.
    const furtherScroll = stubScrollGeometry(container, {
      scrollHeight: 900,
      clientHeight: 400,
      scrollTop: 50,
    });
    await fireEvent.scroll(container);
    expect(furtherScroll.scrollTop).toBe(50);
  });
});

describe('TranscriptTimeline: session switch resets the window (issue #755)', () => {
  it('re-attaches to the bottom of a newly opened session even if the previous one was left scrolled away', async () => {
    const { rerender } = renderTimeline(toolCalls(30), 'sess_1');
    const container = screen.getByTestId('transcript-items');
    stubScrollGeometry(container, { scrollHeight: 900, clientHeight: 400, scrollTop: 100 });
    await fireEvent.scroll(container);
    expect(screen.getByTestId('transcript-jump-latest')).toBeTruthy();

    await rerender(propsFor(toolCalls(3), 'sess_2'));

    expect(screen.queryByTestId('transcript-jump-latest')).toBeNull();
  });
});

describe('TranscriptTimeline: resync gap row (issue #729)', () => {
  it('renders a resync gap item as its own visible row, distinct from message/tool-call rows', () => {
    const gap: TranscriptGapItem = { type: 'gap', id: 'gap::3::5', fromSeq: 3, toSeq: 5 };
    const items: TranscriptItem[] = [toolCallItem('tc0'), gap, toolCallItem('tc1')];
    renderTimeline(items);

    const gapRow = screen.getByTestId('transcript-gap');
    expect(gapRow.textContent).toContain('History gap');
    expect(gapRow.textContent).toContain('3');
    expect(gapRow.textContent).toContain('5');
    // Still exactly one row per item — the gap did not replace or merge
    // with a neighboring tool-call row.
    expect(screen.getAllByTestId('transcript-row')).toHaveLength(3);
  });
});
