import { describe, expect, it } from 'vitest';
import type { TranscriptItem, TranscriptToolCallItem } from '@loombox/providers-core/browser';
import { CanvasTabsState } from './tabs.svelte';

/** A minimal completed edit tool-call item touching `path` — every field `TranscriptToolCallItem` requires, filled with the smallest honest value for one not exercised by these tests. */
function editItem(
  id: string,
  path: string,
  status: TranscriptToolCallItem['status'] = 'completed',
): TranscriptToolCallItem {
  return {
    type: 'tool_call',
    id,
    turnId: 't1',
    title: 'Edit file',
    toolKind: 'edit',
    status,
    diff: { path, oldText: 'a', newText: 'b' },
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
  };
}

describe('CanvasTabsState: the transcript tab (issue #737)', () => {
  it('starts with exactly one permanent transcript tab, active', () => {
    const tabs = new CanvasTabsState();
    expect(tabs.tabs).toEqual([{ kind: 'transcript', id: 'transcript' }]);
    expect(tabs.activeId).toBe('transcript');
    expect(tabs.activeTab).toEqual({ kind: 'transcript', id: 'transcript' });
  });

  it('close() on the transcript tab is a no-op — it can never be closed', () => {
    const tabs = new CanvasTabsState();
    tabs.close('transcript');
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.activeId).toBe('transcript');
  });

  it('a newly opened file tab is appended, never inserted before the transcript tab', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    tabs.open('src/bar.ts', []);
    expect(tabs.tabs.map((t) => t.id)).toEqual(['transcript', 'src/foo.ts', 'src/bar.ts']);
    expect(tabs.tabs[0]?.kind).toBe('transcript');
  });
});

describe('CanvasTabsState: opening/activating file tabs', () => {
  it('open() on a new path appends a closable tab, derives its basename, starts loading, and activates it', () => {
    const tabs = new CanvasTabsState();
    tabs.open('apps/web/src/lib/foo.ts', []);
    expect(tabs.has('apps/web/src/lib/foo.ts')).toBe(true);
    expect(tabs.activeId).toBe('apps/web/src/lib/foo.ts');
    const tab = tabs.tabs[1];
    expect(tab).toEqual({
      kind: 'file',
      id: 'apps/web/src/lib/foo.ts',
      path: 'apps/web/src/lib/foo.ts',
      name: 'foo.ts',
    });
    expect(tabs.viewerFor('apps/web/src/lib/foo.ts')).toEqual({ status: 'loading' });
  });

  it('open() on an already-open path activates the existing tab instead of duplicating it — the shared tab model across every entry point', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    tabs.setViewer('src/foo.ts', { status: 'loaded', content: 'x', truncated: false });
    tabs.activate('transcript', []);
    expect(tabs.activeId).toBe('transcript');

    tabs.open('src/foo.ts', []);
    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.activeId).toBe('src/foo.ts');
    // Re-opening does not clobber the already-loaded content.
    expect(tabs.viewerFor('src/foo.ts')).toEqual({
      status: 'loaded',
      content: 'x',
      truncated: false,
    });
  });

  it('activate() on an id that is not open is a no-op', () => {
    const tabs = new CanvasTabsState();
    tabs.activate('src/nope.ts', []);
    expect(tabs.activeId).toBe('transcript');
  });
});

describe('CanvasTabsState: closing file tabs', () => {
  it('closing a non-active tab leaves the active tab untouched', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/a.ts', []);
    tabs.open('src/b.ts', []);
    tabs.activate('src/a.ts', []);
    tabs.close('src/b.ts');
    expect(tabs.tabs.map((t) => t.id)).toEqual(['transcript', 'src/a.ts']);
    expect(tabs.activeId).toBe('src/a.ts');
  });

  it('closing the active tab falls back to its nearest remaining neighbor', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/a.ts', []);
    tabs.open('src/b.ts', []);
    tabs.open('src/c.ts', []);
    tabs.activate('src/b.ts', []);
    tabs.close('src/b.ts');
    expect(tabs.tabs.map((t) => t.id)).toEqual(['transcript', 'src/a.ts', 'src/c.ts']);
    expect(tabs.activeId).toBe('src/c.ts');
  });

  it('closing the last remaining file tab while active falls back to the transcript tab', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/a.ts', []);
    tabs.close('src/a.ts');
    expect(tabs.tabs).toEqual([{ kind: 'transcript', id: 'transcript' }]);
    expect(tabs.activeId).toBe('transcript');
  });

  it('close() on an id that is not open is a no-op', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/a.ts', []);
    tabs.close('src/does-not-exist.ts');
    expect(tabs.tabs).toHaveLength(2);
  });
});

describe('CanvasTabsState.syncDirty: the dirty indicator (issue #737)', () => {
  it('marks an open, non-active file tab dirty once a completed edit touches its path', () => {
    const tabs = new CanvasTabsState();
    const items: TranscriptItem[] = [];
    tabs.open('src/foo.ts', items);
    tabs.activate('transcript', items); // no longer the active tab

    const withEdit: TranscriptItem[] = [editItem('tc1', 'src/foo.ts')];
    tabs.syncDirty(withEdit);
    expect(tabs.isDirty('src/foo.ts')).toBe(true);
  });

  it('does not mark a tab dirty for an edit to a different path', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    tabs.activate('transcript', []);
    tabs.syncDirty([editItem('tc1', 'src/other.ts')]);
    expect(tabs.isDirty('src/foo.ts')).toBe(false);
  });

  it('does not mark a tab dirty for a still-in-progress edit — only a completed one counts', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    tabs.activate('transcript', []);
    tabs.syncDirty([editItem('tc1', 'src/foo.ts', 'in_progress')]);
    expect(tabs.isDirty('src/foo.ts')).toBe(false);
  });

  it('an edit that happened before the tab was ever opened does not retroactively mark it dirty', () => {
    const tabs = new CanvasTabsState();
    const before: TranscriptItem[] = [editItem('tc1', 'src/foo.ts')];
    tabs.open('src/foo.ts', before); // watermark = 1, this edit already "seen"
    tabs.syncDirty(before);
    expect(tabs.isDirty('src/foo.ts')).toBe(false);
  });

  it('activating a dirty tab clears the flag and re-arms its watermark — "since you last looked" resets on look', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    tabs.activate('transcript', []);
    const withEdit: TranscriptItem[] = [editItem('tc1', 'src/foo.ts')];
    tabs.syncDirty(withEdit);
    expect(tabs.isDirty('src/foo.ts')).toBe(true);

    tabs.activate('src/foo.ts', withEdit);
    expect(tabs.isDirty('src/foo.ts')).toBe(false);

    // A second sync over the SAME items must not resurrect the flag —
    // only a NEW edit after this activation should.
    tabs.syncDirty(withEdit);
    expect(tabs.isDirty('src/foo.ts')).toBe(false);
  });

  it('a later edit after re-activation marks the tab dirty again', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    const firstEdit: TranscriptItem[] = [editItem('tc1', 'src/foo.ts')];
    tabs.activate('src/foo.ts', firstEdit); // watermark = 1, clears dirty
    tabs.syncDirty(firstEdit);
    expect(tabs.isDirty('src/foo.ts')).toBe(false);

    const secondEdit: TranscriptItem[] = [...firstEdit, editItem('tc2', 'src/foo.ts')];
    tabs.syncDirty(secondEdit);
    expect(tabs.isDirty('src/foo.ts')).toBe(true);
  });

  it('closing a dirty tab clears its dirty flag along with its viewer state', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    tabs.activate('transcript', []);
    tabs.syncDirty([editItem('tc1', 'src/foo.ts')]);
    expect(tabs.isDirty('src/foo.ts')).toBe(true);
    tabs.close('src/foo.ts');
    expect(tabs.isDirty('src/foo.ts')).toBe(false);
    expect(tabs.viewerFor('src/foo.ts')).toBeUndefined();
  });
});

describe('CanvasTabsState.reset', () => {
  it('drops every file tab and every viewer/dirty state, back to just the transcript tab active', () => {
    const tabs = new CanvasTabsState();
    tabs.open('src/foo.ts', []);
    tabs.setViewer('src/foo.ts', { status: 'error', message: 'boom' });
    tabs.activate('transcript', []);
    tabs.syncDirty([editItem('tc1', 'src/foo.ts')]);

    tabs.reset();
    expect(tabs.tabs).toEqual([{ kind: 'transcript', id: 'transcript' }]);
    expect(tabs.activeId).toBe('transcript');
    expect(tabs.viewerFor('src/foo.ts')).toBeUndefined();
    expect(tabs.isDirty('src/foo.ts')).toBe(false);
  });
});
