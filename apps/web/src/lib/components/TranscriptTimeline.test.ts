// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTranscriptState,
  type TranscriptGapItem,
  type TranscriptItem,
  type TranscriptState,
  type TranscriptToolCallItem,
} from '@loombox/providers-core/browser';
import TranscriptTimeline, { type TranscriptJumpTarget } from './TranscriptTimeline.svelte';

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
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
    ...extra,
  };
}

function toolCalls(count: number): TranscriptToolCallItem[] {
  return Array.from({ length: count }, (_, i) => toolCallItem(`tc${i}`));
}

function messageItem(id: string, text: string): TranscriptItem {
  return {
    type: 'message',
    id,
    kind: 'agent_message_chunk',
    turnId: 't1',
    messageId: id,
    text,
  };
}

/** A minimal stand-in for the real `Highlight` DOM class (jsdom has none) — captures whatever `Range`s it was constructed with, mirroring `search-highlight.test.ts`'s own fake. */
class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

interface TranscriptTimelineTestProps {
  sessionKey: string;
  items: TranscriptItem[];
  transcript: TranscriptState;
  turnActive: boolean;
  providerId: string;
  permissionHead: undefined;
  jumpTarget: TranscriptJumpTarget | undefined;
  searchQuery?: string;
  activeSearchItemId?: string;
}

function propsFor(items: TranscriptItem[], sessionKey: string): TranscriptTimelineTestProps {
  return {
    sessionKey,
    items,
    transcript: { ...createTranscriptState(), items },
    turnActive: false,
    providerId: 'claude',
    permissionHead: undefined,
    jumpTarget: undefined,
  };
}

function renderTimeline(
  items: TranscriptItem[],
  sessionKey = 'sess_1',
  overrides: Partial<TranscriptTimelineTestProps> = {},
) {
  return render(TranscriptTimeline, { props: { ...propsFor(items, sessionKey), ...overrides } });
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

describe('TranscriptTimeline: subagent/nested tool-call tree rendering (issue #200)', () => {
  it('a nested tool call renders indented, with its own row shape unchanged', () => {
    renderTimeline([
      toolCallItem('root', { title: 'Run subagent' }),
      toolCallItem('child', { parentToolCallId: 'root', title: 'Bash' }),
    ]);

    const rows = screen.getAllByTestId('transcript-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.className).not.toContain('tool-call-nested');
    expect(rows[1]!.className).toContain('tool-call-nested');

    // The child's own row shape — the tier-1/2 widget dispatcher — mounts
    // completely unchanged: still exactly one `tool-call-row`, same as the
    // root's.
    expect(screen.getAllByTestId('tool-call-row')).toHaveLength(2);

    // A caption names the resolved immediate parent, so a reader still has
    // context even if the parent's own row later scrolls out of the
    // mounted window (see the next test).
    const label = screen.getByTestId('tool-call-nesting-label');
    expect(label.textContent).toContain('Run subagent');
  });

  it('an orphan child — parentToolCallId set, but that id never arrived — still renders, at the top level', () => {
    renderTimeline([toolCallItem('orphan', { parentToolCallId: 'never-arrived' })]);

    const rows = screen.getAllByTestId('transcript-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.className).not.toContain('tool-call-nested');
    expect(screen.queryByTestId('tool-call-nesting-label')).toBeNull();
  });

  it('a tree deeper than two levels renders every level, with the indent capped rather than unbounded', () => {
    renderTimeline([
      toolCallItem('root'),
      toolCallItem('a', { parentToolCallId: 'root' }),
      toolCallItem('b', { parentToolCallId: 'a' }),
      toolCallItem('c', { parentToolCallId: 'b' }),
    ]);

    const rows = screen.getAllByTestId('transcript-row');
    expect(rows).toHaveLength(4);
    const leaf = rows.find((row) => row.dataset.itemId === 'c')!;
    // True depth (3) is preserved in the data attribute...
    expect(leaf.dataset.nestingDepth).toBe('3');
    // ...but the indent itself is capped, so a pathologically deep chain
    // never squeezes the row toward zero width.
    expect(leaf.getAttribute('style')).toContain('calc(var(--space-lg) * 3)');

    const deeper = [
      toolCallItem('root2'),
      toolCallItem('d1', { parentToolCallId: 'root2' }),
      toolCallItem('d2', { parentToolCallId: 'd1' }),
      toolCallItem('d3', { parentToolCallId: 'd2' }),
      toolCallItem('d4', { parentToolCallId: 'd3' }),
    ];
    cleanup();
    renderTimeline(deeper);
    const deepRows = screen.getAllByTestId('transcript-row');
    const deepLeaf = deepRows.find((row) => row.dataset.itemId === 'd4')!;
    expect(deepLeaf.dataset.nestingDepth).toBe('4');
    expect(deepLeaf.getAttribute('style')).toContain('calc(var(--space-lg) * 3)');
  });

  it('windowing still holds on a long transcript that includes nesting: mounted-row count stays bounded', () => {
    const items: TranscriptToolCallItem[] = [];
    for (let i = 0; i < 1000; i += 1) {
      items.push(toolCallItem(`root${i}`));
      items.push(toolCallItem(`child${i}`, { parentToolCallId: `root${i}` }));
    }
    renderTimeline(items);

    const rows = screen.getAllByTestId('transcript-row');
    expect(rows.length).toBeLessThan(60);
    expect(rows.length).toBeGreaterThan(0);
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

describe('TranscriptTimeline: jumpTarget (issue #740, turn-review "jump to this file’s diff")', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // jsdom never implements `Element.prototype.scrollIntoView` at all
    // (see the earlier module doc comment) — the two tests below add it
    // as a plain stub, which `vi.restoreAllMocks()` alone won't undo.
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it('mounts a row far outside the initial pinned-to-tail window once jumped to', () => {
    const items = toolCalls(500);
    const { rerender, container } = renderTimeline(items);
    // Pinned to the tail by default — item 50 of 500 is nowhere near it.
    expect(container.querySelector('[data-item-id="tc50"]')).toBeNull();

    rerender({ ...propsFor(items, 'sess_1'), jumpTarget: { id: 'tc50', token: 1 } });

    expect(container.querySelector('[data-item-id="tc50"]')).toBeTruthy();
  });

  it('detaches from following, so the jumped-to row is not immediately pulled back to the tail', () => {
    const items = toolCalls(500);
    const { rerender } = renderTimeline(items);
    expect(screen.queryByTestId('transcript-jump-latest')).toBeNull();

    rerender({ ...propsFor(items, 'sess_1'), jumpTarget: { id: 'tc10', token: 1 } });

    expect(screen.getByTestId('transcript-jump-latest')).toBeTruthy();
  });

  it('scrolls the target row into view once it mounts', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const items = toolCalls(500);
    const { rerender } = renderTimeline(items);

    rerender({ ...propsFor(items, 'sess_1'), jumpTarget: { id: 'tc10', token: 1 } });

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('a repeat click on an already-visible row (bumped token, same id) re-triggers the scroll', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const items = toolCalls(500);
    const { rerender } = renderTimeline(items);

    rerender({ ...propsFor(items, 'sess_1'), jumpTarget: { id: 'tc10', token: 1 } });
    rerender({ ...propsFor(items, 'sess_1'), jumpTarget: { id: 'tc10', token: 2 } });

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('an id that is not in the transcript is silently ignored — no crash', () => {
    const items = toolCalls(20);
    const { rerender } = renderTimeline(items);

    expect(() =>
      rerender({ ...propsFor(items, 'sess_1'), jumpTarget: { id: 'does-not-exist', token: 1 } }),
    ).not.toThrow();
  });

  it('acceptance: brings a turn’s edit into view even when that turn is scrolled out of the mounted range', () => {
    const editItems: TranscriptToolCallItem[] = [
      toolCallItem('edit0', {
        turnId: 't1',
        toolKind: 'edit',
        diff: { path: 'a.ts', oldText: 'x', newText: 'x\ny' },
      }),
      toolCallItem('edit1', {
        turnId: 't1',
        toolKind: 'edit',
        diff: { path: 'b.ts', oldText: 'p\nq', newText: 'p' },
      }),
      toolCallItem('edit2', {
        turnId: 't1',
        toolKind: 'edit',
        diff: { path: 'c.ts', oldText: null, newText: 'z' },
      }),
    ];
    // A long tail of later turns pushes the whole turn well above the
    // pinned-to-tail window — exactly the "most edits are not mounted"
    // case #755 introduced.
    const items = [...editItems, ...toolCalls(500)];
    const { rerender, container } = renderTimeline(items);
    expect(container.querySelector('[data-item-id="edit1"]')).toBeNull();

    rerender({ ...propsFor(items, 'sess_1'), jumpTarget: { id: 'edit1', token: 1 } });

    expect(container.querySelector('[data-item-id="edit1"]')).toBeTruthy();
  });
});

describe('TranscriptTimeline: search highlighting (issues #262/#263)', () => {
  let registry: Map<string, FakeHighlight>;

  beforeEach(() => {
    registry = new Map();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal('Highlight', FakeHighlight);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('paints a highlight over every match inside a currently mounted row', () => {
    const items = [messageItem('m0', 'looking for the needle in here')];
    renderTimeline(items, 'sess_1', { searchQuery: 'needle' });

    const highlight = registry.get('loombox-transcript-search');
    expect(highlight?.ranges).toHaveLength(1);
    expect(highlight?.ranges[0]?.toString()).toBe('needle');
  });

  it('paints no highlight at all for a match that exists in `items` but is outside the mounted window — the documented, accepted DOM-only constraint (search.ts still counted it; only painting is DOM-bound)', () => {
    // A huge tail of unrelated tool calls pushes "m0" out of the
    // pinned-to-tail window, the same setup the jumpTarget "brings a row
    // outside the window into view" test above uses.
    const items: TranscriptItem[] = [messageItem('m0', 'the needle is here'), ...toolCalls(500)];
    const { container } = renderTimeline(items, 'sess_1', { searchQuery: 'needle' });
    expect(container.querySelector('[data-item-id="m0"]')).toBeNull();

    expect(registry.has('loombox-transcript-search')).toBe(false);
  });

  it('navigating to that same off-window match (via jumpTarget, exactly like +page.svelte does) mounts it and the highlight then appears', () => {
    const items: TranscriptItem[] = [messageItem('m0', 'the needle is here'), ...toolCalls(500)];
    const { rerender, container } = renderTimeline(items, 'sess_1', { searchQuery: 'needle' });
    expect(registry.has('loombox-transcript-search')).toBe(false);

    rerender({
      ...propsFor(items, 'sess_1'),
      searchQuery: 'needle',
      jumpTarget: { id: 'm0', token: 1 },
    });

    expect(container.querySelector('[data-item-id="m0"]')).toBeTruthy();
    expect(registry.get('loombox-transcript-search')?.ranges).toHaveLength(1);
  });

  it('paints the active-match highlight only for the row matching activeSearchItemId', () => {
    const items = [messageItem('m0', 'first needle'), messageItem('m1', 'second needle')];
    renderTimeline(items, 'sess_1', { searchQuery: 'needle', activeSearchItemId: 'm1' });

    const active = registry.get('loombox-transcript-search-active');
    expect(active?.ranges).toHaveLength(1);
    expect(
      (
        active?.ranges[0]?.startContainer.parentElement?.closest(
          '[data-item-id]',
        ) as HTMLElement | null
      )?.dataset.itemId,
    ).toBe('m1');
  });

  it('clears highlights on session switch, before the new session\u2019s own rows ever mount', () => {
    const items = [messageItem('m0', 'a needle here')];
    const { rerender } = renderTimeline(items, 'sess_1', { searchQuery: 'needle' });
    expect(registry.has('loombox-transcript-search')).toBe(true);

    rerender({ ...propsFor([messageItem('m1', 'no relation')], 'sess_2'), searchQuery: 'needle' });

    expect(registry.has('loombox-transcript-search')).toBe(false);
  });

  it('an empty query clears any existing highlight', () => {
    const items = [messageItem('m0', 'a needle here')];
    const { rerender } = renderTimeline(items, 'sess_1', { searchQuery: 'needle' });
    expect(registry.has('loombox-transcript-search')).toBe(true);

    rerender({ ...propsFor(items, 'sess_1'), searchQuery: '' });

    expect(registry.has('loombox-transcript-search')).toBe(false);
  });
});
