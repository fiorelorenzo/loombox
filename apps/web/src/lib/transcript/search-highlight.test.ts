// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTranscriptSearchHighlights,
  clearTranscriptSearchHighlights,
  findTextRanges,
  TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT,
  TRANSCRIPT_SEARCH_HIGHLIGHT,
} from './search-highlight';

/** A minimal stand-in for the real `Highlight` DOM class (jsdom has none) — captures whatever `Range`s it was constructed with, which is all `applyTranscriptSearchHighlights` ever reads back out in these tests. */
class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

function makeRow(itemId: string, text: string): HTMLElement {
  const row = document.createElement('li');
  row.dataset.testid = 'transcript-row';
  row.dataset.itemId = itemId;
  row.textContent = text;
  return row;
}

describe('findTextRanges', () => {
  it('returns [] for an empty or whitespace-only query', () => {
    const root = makeRow('a', 'hello world');
    expect(findTextRanges(root, '')).toEqual([]);
    expect(findTextRanges(root, '   ')).toEqual([]);
  });

  it('finds a case-insensitive substring match and returns a Range over exactly that text', () => {
    const root = makeRow('a', 'The Quick Brown Fox');
    const ranges = findTextRanges(root, 'quick');
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.toString()).toBe('Quick');
  });

  it('finds every occurrence, including across sibling text nodes split by inline elements — the exact shape rendered Markdown produces', () => {
    const root = document.createElement('div');
    root.innerHTML = 'a needle in <strong>a needle</strong> stack, and one more needle.';
    const ranges = findTextRanges(root, 'needle');
    expect(ranges).toHaveLength(3);
    ranges.forEach((range) => expect(range.toString().toLowerCase()).toBe('needle'));
  });

  it('returns [] when nothing in the subtree matches', () => {
    const root = makeRow('a', 'nothing to see here');
    expect(findTextRanges(root, 'zzz')).toEqual([]);
  });
});

describe('applyTranscriptSearchHighlights', () => {
  const originalCSS = globalThis.CSS;
  const originalHighlight = globalThis.Highlight;

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'CSS', { value: originalCSS, configurable: true });
    Object.defineProperty(globalThis, 'Highlight', {
      value: originalHighlight,
      configurable: true,
    });
  });

  it('never throws when the CSS Custom Highlight API is unsupported (jsdom, by default, has none) — progressive enhancement, not a hard requirement', () => {
    const container = document.createElement('div');
    container.append(makeRow('a', 'hello world'));
    expect(() => applyTranscriptSearchHighlights(container, 'hello', 'a')).not.toThrow();
    expect(() => clearTranscriptSearchHighlights()).not.toThrow();
  });

  describe('with a stubbed CSS.highlights registry (simulating real browser support)', () => {
    let registry: Map<string, FakeHighlight>;

    beforeEach(() => {
      registry = new Map();
      vi.stubGlobal('CSS', { highlights: registry });
      vi.stubGlobal('Highlight', FakeHighlight);
    });

    it('paints one highlight covering every match across every mounted row', () => {
      const container = document.createElement('div');
      container.append(makeRow('a', 'find the needle'), makeRow('b', 'no match here'));
      container.append(makeRow('c', 'a second needle'));

      applyTranscriptSearchHighlights(container, 'needle', undefined);

      const highlight = registry.get(TRANSCRIPT_SEARCH_HIGHLIGHT) as unknown as FakeHighlight;
      expect(highlight.ranges).toHaveLength(2);
    });

    it('paints the active highlight only for the row matching activeItemId', () => {
      const container = document.createElement('div');
      container.append(makeRow('a', 'find the needle'), makeRow('b', 'a second needle'));

      applyTranscriptSearchHighlights(container, 'needle', 'b');

      const active = registry.get(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT) as unknown as FakeHighlight;
      expect(active.ranges).toHaveLength(1);
      expect(active.ranges[0]?.startContainer.parentElement?.dataset.itemId).toBe('b');
    });

    it("never highlights a row that is not currently mounted — the documented, accepted constraint (see this module's own doc comment)", () => {
      // Only row "a" is mounted; a real windowed-out match for a fictional
      // row "z" simply has no DOM to search — this proves the function
      // never reaches past `container`'s own live subtree.
      const container = document.createElement('div');
      container.append(makeRow('a', 'needle'));

      applyTranscriptSearchHighlights(container, 'needle', 'z');

      expect(registry.has(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT)).toBe(false);
      expect(
        (registry.get(TRANSCRIPT_SEARCH_HIGHLIGHT) as unknown as FakeHighlight).ranges,
      ).toHaveLength(1);
    });

    it('clears both highlights when the query is blank', () => {
      const container = document.createElement('div');
      container.append(makeRow('a', 'needle'));
      applyTranscriptSearchHighlights(container, 'needle', 'a');
      expect(registry.has(TRANSCRIPT_SEARCH_HIGHLIGHT)).toBe(true);

      applyTranscriptSearchHighlights(container, '', 'a');

      expect(registry.has(TRANSCRIPT_SEARCH_HIGHLIGHT)).toBe(false);
      expect(registry.has(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT)).toBe(false);
    });

    it('clears both highlights when no matches exist anywhere in the mounted rows', () => {
      const container = document.createElement('div');
      container.append(makeRow('a', 'no matches in here'));
      registry.set(TRANSCRIPT_SEARCH_HIGHLIGHT, new FakeHighlight());

      applyTranscriptSearchHighlights(container, 'absent-query', 'a');

      expect(registry.has(TRANSCRIPT_SEARCH_HIGHLIGHT)).toBe(false);
    });

    it('clearTranscriptSearchHighlights removes both entries unconditionally', () => {
      registry.set(TRANSCRIPT_SEARCH_HIGHLIGHT, new FakeHighlight());
      registry.set(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT, new FakeHighlight());

      clearTranscriptSearchHighlights();

      expect(registry.size).toBe(0);
    });
  });
});
