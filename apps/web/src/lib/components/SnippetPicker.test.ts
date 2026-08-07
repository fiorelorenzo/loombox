// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SnippetV1 } from '$lib/relay-client';
import SnippetPicker from './SnippetPicker.svelte';

afterEach(() => cleanup());
// jsdom has no Web Animations API; `Dialog`'s panel-lift transition calls
// `element.animate()` once opened/closed reactively (see
// `TargetStatusView.test.ts`'s identical stub for why) — only exercised in
// this file by the close/reopen round trip below.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      play: () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

const TWO_SNIPPETS: SnippetV1[] = [
  { id: 'snip_standup', name: 'Daily standup', text: 'What did you ship yesterday?' },
  { id: 'snip_retro', name: 'Retro notes', text: "What went well, what didn't, one action item." },
];

describe('SnippetPicker (SPEC §7.18, reusable prompt/snippet library; issue #261)', () => {
  it('renders nothing when closed', () => {
    render(SnippetPicker, {
      props: {
        open: false,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert: vi.fn(),
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('lists every saved snippet when the query is empty', () => {
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert: vi.fn(),
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const items = screen.getAllByTestId('snippet-picker-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Daily standup');
    expect(items[1].textContent).toContain('Retro notes');
  });

  it('shows an empty-catalog message distinct from a no-match message', () => {
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: [],
        draftText: '',
        onInsert: vi.fn(),
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(screen.getByText('No saved snippets yet.')).not.toBeNull();
  });

  it('fuzzy-filters by name and text as the user types', async () => {
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert: vi.fn(),
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    await fireEvent.input(screen.getByTestId('snippet-picker-input'), {
      target: { value: 'ship' },
    });
    const items = screen.getAllByTestId('snippet-picker-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Daily standup');
  });

  it('clicking an entry inserts it verbatim and closes — the exact saved text, nothing added or trimmed', async () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert,
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose,
      },
    });
    const items = screen.getAllByTestId('snippet-picker-item');
    await fireEvent.click(items[1]);
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(TWO_SNIPPETS[1]);
    expect(onInsert.mock.calls[0][0].text).toBe("What went well, what didn't, one action item.");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Enter inserts the active entry, then closes', async () => {
    const onInsert = vi.fn();
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert,
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const input = screen.getByTestId('snippet-picker-input');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(TWO_SNIPPETS[1]);
  });

  it('Esc closes without inserting anything', async () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert,
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose,
      },
    });
    await fireEvent.keyDown(screen.getByTestId('snippet-picker-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("clicking Delete on a row fires onDelete with that snippet's id, without inserting it", async () => {
    const onDelete = vi.fn();
    const onInsert = vi.fn();
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert,
        onSave: vi.fn(),
        onDelete,
        onClose: vi.fn(),
      },
    });
    const deleteButtons = screen.getAllByTestId('snippet-picker-delete');
    await fireEvent.click(deleteButtons[0]);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('snip_standup');
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('the save form prefills from the current composer draft, editable before saving', async () => {
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: [],
        draftText: 'Review this PR for security issues.',
        onInsert: vi.fn(),
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    await fireEvent.click(screen.getByTestId('snippet-picker-save-toggle'));
    const textField = screen.getByTestId('snippet-picker-text') as HTMLTextAreaElement;
    expect(textField.value).toBe('Review this PR for security issues.');
  });

  it('saving with a name calls onSave with the trimmed name and the (possibly edited) text', async () => {
    const onSave = vi.fn();
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: [],
        draftText: 'Draft body',
        onInsert: vi.fn(),
        onSave,
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    await fireEvent.click(screen.getByTestId('snippet-picker-save-toggle'));
    await fireEvent.input(screen.getByTestId('snippet-picker-name'), {
      target: { value: '  My snippet  ' },
    });
    await fireEvent.click(screen.getByTestId('snippet-picker-save'));
    expect(onSave).toHaveBeenCalledExactlyOnceWith('My snippet', 'Draft body');
  });

  it('saving without a name shows an error and never calls onSave', async () => {
    const onSave = vi.fn();
    render(SnippetPicker, {
      props: {
        open: true,
        snippets: [],
        draftText: 'Draft body',
        onInsert: vi.fn(),
        onSave,
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    await fireEvent.click(screen.getByTestId('snippet-picker-save-toggle'));
    await fireEvent.click(screen.getByTestId('snippet-picker-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Name is required.')).not.toBeNull();
  });

  it('reopening resets the search query and save form (issue #261: a stale query never leaks across opens)', async () => {
    const { rerender } = render(SnippetPicker, {
      props: {
        open: true,
        snippets: TWO_SNIPPETS,
        draftText: '',
        onInsert: vi.fn(),
        onSave: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      },
    });
    await fireEvent.input(screen.getByTestId('snippet-picker-input'), {
      target: { value: 'ship' },
    });
    await rerender({
      open: false,
      snippets: TWO_SNIPPETS,
      draftText: '',
      onInsert: vi.fn(),
      onSave: vi.fn(),
      onDelete: vi.fn(),
      onClose: vi.fn(),
    });
    await rerender({
      open: true,
      snippets: TWO_SNIPPETS,
      draftText: '',
      onInsert: vi.fn(),
      onSave: vi.fn(),
      onDelete: vi.fn(),
      onClose: vi.fn(),
    });
    expect(screen.getAllByTestId('snippet-picker-item')).toHaveLength(2);
  });
});
