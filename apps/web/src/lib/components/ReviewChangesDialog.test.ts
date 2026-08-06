// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnDiffSummary } from '$lib/transcript/turn-review';
import ReviewChangesDialog from './ReviewChangesDialog.svelte';

afterEach(() => cleanup());

const twoFileSummary: TurnDiffSummary = {
  turnId: 't1',
  files: [
    { toolCallId: 'tc0', path: 'a.ts', oldText: 'x', newText: 'x\ny', added: 1, removed: 0 },
    { toolCallId: 'tc1', path: 'b.ts', oldText: 'p\nq', newText: 'p', added: 0, removed: 1 },
  ],
  totalAdded: 1,
  totalRemoved: 1,
};

describe('ReviewChangesDialog', () => {
  it('is not rendered while closed', () => {
    render(ReviewChangesDialog, {
      props: { open: false, summary: twoFileSummary, onClose: vi.fn() },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('stacks every file the turn changed, each with its own diff card', () => {
    render(ReviewChangesDialog, {
      props: { open: true, summary: twoFileSummary, onClose: vi.fn() },
    });
    const files = screen.getAllByTestId('review-changes-file');
    expect(files).toHaveLength(2);
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('b.ts')).toBeTruthy();
  });

  it('renders the same diff a tool card would — added/removed line markers included', () => {
    render(ReviewChangesDialog, {
      props: { open: true, summary: twoFileSummary, onClose: vi.fn() },
    });
    const addedRow = screen.getByText('y').closest('li');
    const removedRow = screen.getByText('q').closest('li');
    expect(addedRow?.className).toContain('added');
    expect(removedRow?.className).toContain('removed');
  });

  it('shows the file count in its header', () => {
    render(ReviewChangesDialog, {
      props: { open: true, summary: twoFileSummary, onClose: vi.fn() },
    });
    expect(screen.getByText('2 files')).toBeTruthy();
  });
});

describe('ReviewChangesDialog: read-only (issue #740 — C1-4 keep/reject was not picked)', () => {
  it('renders no button whose name suggests it can revert, restore, keep or discard anything', () => {
    render(ReviewChangesDialog, {
      props: { open: true, summary: twoFileSummary, onClose: vi.fn() },
    });

    const buttons = screen.getAllByRole('button');
    const writeIntentPattern = /reject|revert|restore|discard|keep|undo|apply/i;
    for (const button of buttons) {
      expect(button.textContent ?? '').not.toMatch(writeIntentPattern);
      expect(button.getAttribute('aria-label') ?? '').not.toMatch(writeIntentPattern);
    }
    // Every button this dialog can ever render: `Dialog`'s own backdrop
    // close and one `CopyButton` per `DiffViewer` (copy is not a write to
    // disk) — nothing that accepts a mutation callback.
    for (const button of buttons) {
      const label = button.getAttribute('aria-label') ?? '';
      const testid = button.getAttribute('data-testid') ?? '';
      expect(
        testid === 'dialog-backdrop' || label.startsWith('Copy diff for'),
        `unexpected button: testid="${testid}" aria-label="${label}"`,
      ).toBe(true);
    }
  });
});
