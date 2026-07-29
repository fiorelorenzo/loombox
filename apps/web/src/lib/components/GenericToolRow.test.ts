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

  it('is expandable/collapsible, defaulting open so replayed history still shows its body immediately', async () => {
    render(GenericToolRow, { props: { item } });
    expect(screen.getByText('pattern')).toBeTruthy();

    const toggle = screen.getByRole('button', { expanded: true });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('pattern')).toBeNull();
  });

  it('draws its tool-call type glyph via the shared Icon component (#468)', () => {
    const { container } = render(GenericToolRow, { props: { item } });
    const icon = container.querySelector('[data-icon-name="tool-generic"]');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('GenericToolRow: shared tool-card treatment (design spec v5 §4)', () => {
  it('states its role as the visible word "Tool" in the gutter, and renders its content through the shared flat ToolCard', () => {
    const { container } = render(GenericToolRow, { props: { item } });
    expect(screen.getByText('Tool')).toBeTruthy();
    expect(container.querySelector('.tool-card')).toBeTruthy();
  });
});
