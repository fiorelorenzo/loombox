// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientSessionMeta } from '$lib/relay-client';
import ArchiveSessionDialog, { type ArchiveSessionClient } from './ArchiveSessionDialog.svelte';

afterEach(() => cleanup());

function makeSession(overrides: Partial<ClientSessionMeta> = {}): ClientSessionMeta {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    targetId: 'local',
    accountId: 'acct_1',
    provider: 'claude',
    createdAt: Date.now(),
    title: 'Refactor relay routing',
    projectPath: '/home/dev/loombox',
    ...overrides,
  };
}

function fakeClient(archiveSession: ArchiveSessionClient['archiveSession']): ArchiveSessionClient {
  return { archiveSession };
}

describe('ArchiveSessionDialog (SPEC §7.2 board archive; issue #512)', () => {
  it('is not rendered while closed', () => {
    render(ArchiveSessionDialog, {
      props: {
        open: false,
        session: makeSession(),
        client: fakeClient(vi.fn()),
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('names the session and its project', () => {
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession({ title: 'Refactor relay routing', projectPath: '/home/dev/loombox' }),
        client: fakeClient(vi.fn()),
        onClose: vi.fn(),
      },
    });
    const context = screen.getByTestId('archive-session-context').textContent ?? '';
    expect(context).toContain('Refactor relay routing');
    expect(context).toContain('/home/dev/loombox');
  });

  it('offers the "also delete" checkbox, checked by default, when the session runs in an isolated worktree', () => {
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession({ worktree: true }),
        client: fakeClient(vi.fn()),
        onClose: vi.fn(),
      },
    });
    const checkbox = screen.getByTestId('archive-session-remove-worktree') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.queryByTestId('archive-session-inplace-note')).toBeNull();
  });

  it("treats an absent worktree value as isolated too — the node's per-target default (SPEC §7.1)", () => {
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession({ worktree: undefined }),
        client: fakeClient(vi.fn()),
        onClose: vi.fn(),
      },
    });
    expect(screen.getByTestId('archive-session-remove-worktree')).toBeTruthy();
  });

  it('hides the checkbox and states the project folder is left untouched when the session runs in place', () => {
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession({ worktree: false }),
        client: fakeClient(vi.fn()),
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByTestId('archive-session-remove-worktree')).toBeNull();
    expect(screen.getByTestId('archive-session-inplace-note').textContent).toMatch(
      /leaves it untouched/i,
    );
  });

  it('on confirm archives with removeWorktree: true by default, then closes', async () => {
    const archiveSession = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession({ id: 'sess_confirm', worktree: true }),
        client: fakeClient(archiveSession),
        onClose,
      },
    });

    await fireEvent.click(screen.getByTestId('archive-session-confirm'));

    expect(archiveSession).toHaveBeenCalledWith('sess_confirm', { removeWorktree: true });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('unchecking "also delete" archives with removeWorktree: false', async () => {
    const archiveSession = vi.fn().mockResolvedValue(undefined);
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession({ id: 'sess_keep_worktree', worktree: true }),
        client: fakeClient(archiveSession),
        onClose: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId('archive-session-remove-worktree'));
    await fireEvent.click(screen.getByTestId('archive-session-confirm'));

    expect(archiveSession).toHaveBeenCalledWith('sess_keep_worktree', { removeWorktree: false });
  });

  it('an in-place session always archives with removeWorktree: false — there is no checkbox to represent true', async () => {
    const archiveSession = vi.fn().mockResolvedValue(undefined);
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession({ id: 'sess_inplace', worktree: false }),
        client: fakeClient(archiveSession),
        onClose: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId('archive-session-confirm'));

    expect(archiveSession).toHaveBeenCalledWith('sess_inplace', { removeWorktree: false });
  });

  it('Cancel closes without archiving', async () => {
    const archiveSession = vi.fn();
    const onClose = vi.fn();
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession(),
        client: fakeClient(archiveSession),
        onClose,
      },
    });

    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(archiveSession).not.toHaveBeenCalled();
  });

  it('shows the node-reported message and stays open when archiveSession rejects', async () => {
    const archiveSession = vi.fn().mockRejectedValue(new Error('git worktree remove failed'));
    const onClose = vi.fn();
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession(),
        client: fakeClient(archiveSession),
        onClose,
      },
    });

    await fireEvent.click(screen.getByTestId('archive-session-confirm'));

    await vi.waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain(
        'git worktree remove failed',
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rephrases a transport timeout instead of leaking the wire identifier at the user (issue #505 precedent)', async () => {
    const archiveSession = vi
      .fn()
      .mockRejectedValue(new Error('RelayClient: timed out waiting for session_archive_response'));
    render(ArchiveSessionDialog, {
      props: {
        open: true,
        session: makeSession(),
        client: fakeClient(archiveSession),
        onClose: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId('archive-session-confirm'));

    const notice = await vi.waitFor(() => screen.getByTestId('ui-error-notice'));
    expect(notice.textContent).not.toContain('session_archive_response');
    expect(notice.textContent).toContain('may be asleep, offline, or on an older relay');
    // Says plainly that nothing happened: a timeout is the one failure where
    // the user cannot tell whether the destructive half already ran.
    expect(notice.textContent).toContain('Nothing was archived');
  });
});
