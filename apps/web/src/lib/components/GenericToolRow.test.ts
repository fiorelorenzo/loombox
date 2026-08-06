// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
import GenericToolRow from './GenericToolRow.svelte';

afterEach(() => cleanup());

const item: TranscriptToolCallItem = {
  type: 'tool_call',
  id: 'tc1',
  turnId: 't1',
  title: 'Search for TODOs',
  toolKind: 'search',
  status: 'in_progress',
  diff: undefined,
  rawInput: { pattern: 'TODO' },
  content: undefined,
  parentToolCallId: undefined,
  startedAtMs: undefined,
  elapsedMs: undefined,
  costAtStartUsd: undefined,
  attributedCostUsd: undefined,
};

describe('GenericToolRow', () => {
  it('renders the tool kind (screen-reader only), title, and a human status label', () => {
    render(GenericToolRow, { props: { item } });
    // The kind chip is gone from the visible content flow (redesign v3 §3.4
    // "one tool-call anatomy") — the gutter icon carries it for sighted
    // users, this sr-only label carries it for screen readers.
    expect(screen.getByText('search')).toBeTruthy();
    expect(screen.getByText('Search for TODOs')).toBeTruthy();
    // Status is a StatusDot + short human label, never the raw enum.
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.queryByText('in_progress')).toBeNull();
  });

  it('renders the tool title in the shared mono identifier face (#735)', () => {
    const { container } = render(GenericToolRow, { props: { item } });
    expect(container.querySelector('.title')?.className).toContain('font-mono');
  });

  it('renders rawInput as a key/value fallback preview when there is no content yet, never a JSON blob', () => {
    const { container } = render(GenericToolRow, { props: { item } });
    expect(screen.getByText('pattern')).toBeTruthy();
    expect(screen.getByText('TODO')).toBeTruthy();
    expect(container.textContent).not.toContain('{"');
  });

  it('renders an unrecognised rawInput object as key/value rows rather than a JSON string (redesign v3 §3.4)', () => {
    const { container } = render(GenericToolRow, {
      props: {
        item: {
          ...item,
          toolKind: 'other',
          rawInput: { recursive: true, maxDepth: 2 },
        },
      },
    });
    expect(screen.getByText('recursive')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
    expect(screen.getByText('maxDepth')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(container.textContent).not.toContain('{"');
  });

  it('renders already-produced content as preformatted output text instead of the rawInput preview', () => {
    render(GenericToolRow, {
      props: { item: { ...item, content: 'src/foo.ts:12: // TODO fix this' } },
    });
    expect(screen.getByText('src/foo.ts:12: // TODO fix this')).toBeTruthy();
    expect(screen.queryByText('pattern')).toBeNull();
  });

  it('stays expanded by default while a call is still running', async () => {
    render(GenericToolRow, { props: { item } });
    expect(screen.getByText('pattern')).toBeTruthy();

    const toggle = screen.getByRole('button', { expanded: true });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('pattern')).toBeNull();
  });

  it('draws the glyph matching its ACP tool kind via the shared Icon component (#468, extended per-kind by issue #744)', () => {
    const { container } = render(GenericToolRow, { props: { item } });
    // `item.toolKind` is 'search'.
    const icon = container.querySelector('[data-icon-name="tool-search"]');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a distinct glyph per ACP tool kind, and falls back to tool-generic for an unrecognized one (issue #744)', () => {
    const cases: Array<[TranscriptToolCallItem['toolKind'], string]> = [
      ['read', 'tool-read'],
      ['edit', 'tool-edit'],
      ['delete', 'tool-delete'],
      ['move', 'tool-move'],
      ['search', 'tool-search'],
      ['execute', 'tool-bash'],
      ['think', 'tool-think'],
      ['fetch', 'tool-fetch'],
      ['other', 'tool-generic'],
      [undefined, 'tool-generic'],
      // A future ACP tool kind this build doesn't know about yet — must
      // still fall back rather than rendering nothing/throwing.
      ['made-up-future-kind' as TranscriptToolCallItem['toolKind'], 'tool-generic'],
    ];
    for (const [toolKind, expectedIcon] of cases) {
      const { container, unmount } = render(GenericToolRow, {
        props: { item: { ...item, toolKind } },
      });
      expect(
        container.querySelector(`[data-icon-name="${expectedIcon}"]`),
        `toolKind ${String(toolKind)} draws ${expectedIcon}`,
      ).toBeTruthy();
      unmount();
    }
  });
});

describe('GenericToolRow: resting state and its one override (v7 decisions §3, issue #668)', () => {
  const completedMultilineItem: TranscriptToolCallItem = {
    ...item,
    status: 'completed',
    content: Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join('\n'),
  };

  it('C1-1 — a completed multi-line call rests collapsed to one header line, output behind the disclosure', () => {
    const { container } = render(GenericToolRow, { props: { item: completedMultilineItem } });
    expect(screen.getByText('Search for TODOs')).toBeTruthy();
    expect(screen.queryByText('line 1', { exact: false })).toBeNull();
    // No block chrome at rest — `ToolCard` stays in its plain, borderless mode.
    expect(container.querySelector('.tool-card')?.getAttribute('data-surface')).toBe('false');
  });

  it('expands on click to show the full output and its card, and collapses again on a second click', async () => {
    const { container } = render(GenericToolRow, { props: { item: completedMultilineItem } });
    const toggle = screen.getByRole('button', { expanded: false });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('line 1', { exact: false })).toBeTruthy();
    expect(container.querySelector('.tool-card')?.getAttribute('data-surface')).toBe('true');

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('line 1', { exact: false })).toBeNull();
  });

  it('C2-1 — a failed call always renders in full, uncapped, with no disclosure control to collapse it', () => {
    render(GenericToolRow, { props: { item: { ...completedMultilineItem, status: 'failed' } } });
    expect(screen.getByText('line 1', { exact: false })).toBeTruthy();
    const header = screen.getByTestId('row-header');
    expect(header.tagName).toBe('DIV');
    expect(header.getAttribute('aria-expanded')).toBeNull();
  });
});

describe('GenericToolRow: shared tool-card treatment (issue #575, superseding v5 §4)', () => {
  it('states its role via the gutter icon alone now — no visible "Tool" word — and renders its content through the shared flat ToolCard', () => {
    const { container } = render(GenericToolRow, { props: { item } });
    expect(screen.queryByText('Tool')).toBeNull();
    expect(container.querySelector('[data-testid="icon"]')).toBeTruthy();
    expect(container.querySelector('.tool-card')).toBeTruthy();
  });
});
