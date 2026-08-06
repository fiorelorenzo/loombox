// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnDiffSummary } from '$lib/transcript/turn-review';
import TurnEditsBar from './TurnEditsBar.svelte';

afterEach(() => cleanup());

const threeFileSummary: TurnDiffSummary = {
  turnId: 't1',
  files: [
    { toolCallId: 'tc0', path: 'a.ts', oldText: 'x', newText: 'x\ny', added: 1, removed: 0 },
    { toolCallId: 'tc1', path: 'b.ts', oldText: 'p\nq', newText: 'p', added: 0, removed: 1 },
    { toolCallId: 'tc2', path: 'c.ts', oldText: null, newText: 'one\ntwo', added: 2, removed: 0 },
  ],
  totalAdded: 3,
  totalRemoved: 1,
};

describe('TurnEditsBar', () => {
  it('a turn with no edits (summary undefined) shows no bar at all', () => {
    render(TurnEditsBar, {
      props: { summary: undefined, onJumpToFile: vi.fn(), onReviewChanges: vi.fn() },
    });
    expect(screen.queryByTestId('turn-edits-bar')).toBeNull();
  });

  it('a turn with three edits shows one bar with correct file count and +/- totals', () => {
    render(TurnEditsBar, {
      props: { summary: threeFileSummary, onJumpToFile: vi.fn(), onReviewChanges: vi.fn() },
    });
    const bar = screen.getByTestId('turn-edits-bar');
    expect(bar.textContent).toContain('3 files');
    expect(bar.textContent).toContain('+3');
    expect(bar.textContent).toContain('−1');
  });

  it('expands to exactly one row per file, each with its own path and stats', async () => {
    render(TurnEditsBar, {
      props: { summary: threeFileSummary, onJumpToFile: vi.fn(), onReviewChanges: vi.fn() },
    });
    expect(screen.queryAllByTestId('turn-edits-file-row')).toHaveLength(0);

    await fireEvent.click(screen.getByTestId('turn-edits-toggle'));

    const rows = screen.getAllByTestId('turn-edits-file-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.textContent?.includes('a.ts'))).toContain(true);
    expect(rows.map((r) => r.textContent?.includes('b.ts'))).toContain(true);
    expect(rows.map((r) => r.textContent?.includes('c.ts'))).toContain(true);
  });

  it('clicking a file row jumps to that file’s own tool call, by id — never a path lookup', async () => {
    const onJumpToFile = vi.fn();
    render(TurnEditsBar, {
      props: { summary: threeFileSummary, onJumpToFile, onReviewChanges: vi.fn() },
    });
    await fireEvent.click(screen.getByTestId('turn-edits-toggle'));

    const rows = screen.getAllByTestId('turn-edits-file-row');
    await fireEvent.click(rows[1]!);

    expect(onJumpToFile).toHaveBeenCalledExactlyOnceWith('tc1');
  });

  it('the Review Changes button opens the review surface, not the per-file disclosure', async () => {
    const onReviewChanges = vi.fn();
    const onJumpToFile = vi.fn();
    render(TurnEditsBar, {
      props: { summary: threeFileSummary, onJumpToFile, onReviewChanges },
    });

    await fireEvent.click(screen.getByTestId('turn-edits-review-changes'));

    expect(onReviewChanges).toHaveBeenCalledOnce();
    expect(onJumpToFile).not.toHaveBeenCalled();
    // Clicking it did not also expand the per-file rows.
    expect(screen.queryAllByTestId('turn-edits-file-row')).toHaveLength(0);
  });
});

describe('TurnEditsBar: read-only (issue #740 — C1-4 keep/reject was not picked)', () => {
  it('renders no button whose name suggests it can revert, restore, keep or discard anything', async () => {
    render(TurnEditsBar, {
      props: { summary: threeFileSummary, onJumpToFile: vi.fn(), onReviewChanges: vi.fn() },
    });
    await fireEvent.click(screen.getByTestId('turn-edits-toggle'));

    const buttons = screen.getAllByRole('button');
    const writeIntentPattern = /reject|revert|restore|discard|keep|undo|apply/i;
    for (const button of buttons) {
      expect(button.textContent ?? '').not.toMatch(writeIntentPattern);
      expect(button.getAttribute('aria-label') ?? '').not.toMatch(writeIntentPattern);
    }
    // The only buttons this bar ever renders: the disclosure toggle, the
    // Review Changes trigger, and one row per file — all navigation, none
    // of them accept a mutation callback (see the component's own Props).
    expect(buttons.map((b) => b.getAttribute('data-testid')).sort()).toEqual([
      'turn-edits-file-row',
      'turn-edits-file-row',
      'turn-edits-file-row',
      'turn-edits-review-changes',
      'turn-edits-toggle',
    ]);
  });
});
