// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import type { TrackerRecordV1, TrackerTypeDefinitionV1 } from '@loombox/protocol';
import type {
  ClientSessionMeta,
  FileTreeDirectoryState,
  TrackerSnapshotState,
} from '../relay-client';
import MentionPicker, { type MentionPickerClient } from './MentionPicker.svelte';

afterEach(() => cleanup());

function tree(
  entries: Record<string, FileTreeDirectoryState>,
): Map<string, FileTreeDirectoryState> {
  return new Map(Object.entries(entries));
}

const twoFileTree = tree({
  '': {
    path: '',
    status: 'loaded',
    entries: [
      { name: 'README.md', kind: 'file', size: 4 },
      { name: 'src', kind: 'dir', size: 0 },
    ],
  },
  src: {
    path: 'src',
    status: 'loaded',
    entries: [{ name: 'index.ts', kind: 'file', size: 10 }],
  },
});

function session(id: string, title: string, projectPath = '/proj'): ClientSessionMeta {
  return {
    id,
    nodeId: 'node-1',
    targetId: 'local',
    accountId: 'acct-1',
    provider: 'test',
    createdAt: 0,
    title,
    projectPath,
  };
}

const TASK_TYPE: TrackerTypeDefinitionV1 = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title' },
};

function record(id: string, issueNumber: number, title?: string): TrackerRecordV1 {
  return {
    id,
    primaryType: 'task',
    typeTags: [],
    issueNumber,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    fields: title ? { title } : {},
    system: {
      authorId: 'acct-1',
      linkedCommitSha: [],
      linkedPullRequests: [],
      linkedSessionIds: [],
      activity: [],
      comments: [],
    },
  };
}

function fakeClient(snapshot: TrackerSnapshotState): MentionPickerClient {
  return { trackerSnapshotFor: () => writable(snapshot) };
}

const LOADED_EMPTY_SNAPSHOT: TrackerSnapshotState = { status: 'loaded', records: [], types: [] };

describe('MentionPicker (issue #742, decisions doc C2-3): four sources, all resolving to a MentionRef, never inserted text', () => {
  it('renders nothing when closed', () => {
    render(MentionPicker, {
      props: {
        open: false,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: undefined,
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByTestId('mention-picker-input')).toBeNull();
  });

  it('Files tab lists every loaded file AND directory, fuzzy-filtered, and Enter resolves a file to a fileMention', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: undefined,
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect,
        onClose,
      },
    });
    const items = screen.getAllByTestId('mention-picker-item');
    expect(items.map((el) => el.textContent?.trim())).toEqual(
      expect.arrayContaining(['README.md', 'src', 'src/index.ts']),
    );

    const input = screen.getByTestId('mention-picker-input');
    await fireEvent.input(input, { target: { value: 'README' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'file',
        path: 'README.md',
        resourceLink: { type: 'resource_link', uri: 'file:README.md', name: 'README.md' },
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('a directory result resolves to a directoryMention, not a fileMention', async () => {
    const onSelect = vi.fn();
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: undefined,
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect,
        onClose: vi.fn(),
      },
    });
    const input = screen.getByTestId('mention-picker-input');
    await fireEvent.input(input, { target: { value: 'src' } });
    // 'src' fuzzy-matches both the directory and 'src/index.ts'; the directory sorts first (exact prefix).
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'directory', path: 'src' }),
    );
  });

  it('Tab switches to the Sessions tab, scoped to the current project and excluding the current session, searched by title', async () => {
    const onSelect = vi.fn();
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [
          session('s-current', 'Current session'),
          session('s-other', 'Fix login bug'),
          session('s-other-project', 'Different project', '/elsewhere'),
        ],
        currentSessionId: 's-current',
        projectContext: { nodeId: 'node-1', projectPath: '/proj' },
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect,
        onClose: vi.fn(),
      },
    });
    const input = screen.getByTestId('mention-picker-input');
    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByTestId('mention-picker-tab-sessions').getAttribute('aria-selected')).toBe(
      'true',
    );

    const items = screen.getAllByTestId('mention-picker-item');
    expect(items.map((el) => el.textContent?.trim())).toEqual(['Fix login bug']);

    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'session',
        sessionId: 's-other',
        resourceLink: {
          type: 'resource_link',
          uri: 'loombox-session:s-other',
          name: 'Fix login bug',
        },
      }),
    );
  });

  it('Shift+Tab cycles the source tab backwards (Files -> Tracker)', async () => {
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: { nodeId: 'node-1', projectPath: '/proj' },
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const input = screen.getByTestId('mention-picker-input');
    await fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(screen.getByTestId('mention-picker-tab-tracker').getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('Tracker tab searches by id (#issueNumber) or title, resolving to a trackerMention scoped to the project', async () => {
    const onSelect = vi.fn();
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: { nodeId: 'node-1', projectPath: '/proj' },
        client: fakeClient({
          status: 'loaded',
          records: [record('rec-142', 142, 'Fix login bug'), record('rec-9', 9, 'Unrelated')],
          types: [TASK_TYPE],
        }),
        onSelect,
        onClose: vi.fn(),
      },
    });
    const input = screen.getByTestId('mention-picker-input');
    await fireEvent.keyDown(input, { key: 'Tab' });
    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByTestId('mention-picker-tab-tracker').getAttribute('aria-selected')).toBe(
      'true',
    );

    await fireEvent.input(input, { target: { value: '142' } });
    const items = screen.getAllByTestId('mention-picker-item');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent?.trim()).toBe('#142 Fix login bug');

    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tracker',
        nodeId: 'node-1',
        projectPath: '/proj',
        recordId: 'rec-142',
        resourceLink: {
          type: 'resource_link',
          uri: 'loombox-tracker:node-1/%2Fproj/rec-142',
          name: '#142 Fix login bug',
        },
      }),
    );
  });

  it('an archived tracker record never appears as a result', async () => {
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: { nodeId: 'node-1', projectPath: '/proj' },
        client: fakeClient({
          status: 'loaded',
          records: [{ ...record('rec-1', 1, 'Archived one'), archived: true }],
          types: [TASK_TYPE],
        }),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const input = screen.getByTestId('mention-picker-input');
    await fireEvent.keyDown(input, { key: 'Tab' });
    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
  });

  it('a tracker record with no resolvable title role falls back to a bare #issueNumber label', async () => {
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: { nodeId: 'node-1', projectPath: '/proj' },
        client: fakeClient({
          status: 'loaded',
          records: [record('rec-1', 7)],
          types: [TASK_TYPE],
        }),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const input = screen.getByTestId('mention-picker-input');
    await fireEvent.keyDown(input, { key: 'Tab' });
    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByTestId('mention-picker-item').textContent?.trim()).toBe('#7');
  });

  it('Esc closes without selecting anything, on any tab', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [],
        currentSessionId: undefined,
        projectContext: undefined,
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect,
        onClose,
      },
    });
    await fireEvent.keyDown(screen.getByTestId('mention-picker-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking a tab switches source without needing the keyboard', async () => {
    render(MentionPicker, {
      props: {
        open: true,
        tree: twoFileTree,
        onExpand: vi.fn(),
        sessions: [session('s-other', 'Other session')],
        currentSessionId: undefined,
        projectContext: { nodeId: 'node-1', projectPath: '/proj' },
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    await fireEvent.click(screen.getByTestId('mention-picker-tab-sessions'));
    expect(screen.getByTestId('mention-picker-tab-sessions').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByTestId('mention-picker-item').textContent?.trim()).toBe('Other session');
  });

  it('opportunistically expands every directory it can already see but has not loaded yet, bounded', () => {
    const onExpand = vi.fn();
    const rootOnly = tree({
      '': {
        path: '',
        status: 'loaded',
        entries: [{ name: 'src', kind: 'dir', size: 0 }],
      },
    });
    render(MentionPicker, {
      props: {
        open: true,
        tree: rootOnly,
        onExpand,
        sessions: [],
        currentSessionId: undefined,
        projectContext: undefined,
        client: fakeClient(LOADED_EMPTY_SNAPSHOT),
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(onExpand).toHaveBeenCalledWith('src');
  });
});
