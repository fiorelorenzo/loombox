// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitCheckpointV1 } from '@loombox/protocol';
import type { ClientSessionMeta } from '$lib/relay-client';
import CheckpointsDialog, { type CheckpointsClient } from './CheckpointsDialog.svelte';

// jsdom has no Web Animations API; `Dialog`'s panel-lift transition calls
// `element.animate()` once opened/closed reactively (see
// `TargetStatusView.test.ts`'s identical stub for why).
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

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

function makeCheckpoint(overrides: Partial<GitCheckpointV1> = {}): GitCheckpointV1 {
  return {
    id: 'cp_1',
    sessionId: 'sess_1',
    message: 'auto: before turn 1',
    createdAt: new Date('2026-08-06T12:00:00Z').getTime(),
    commit: 'abc123',
    baseCommit: 'def456',
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasUntrackedFiles: false,
    isWorkInPlace: false,
    ...overrides,
  };
}

function fakeClient(overrides: Partial<CheckpointsClient> = {}): CheckpointsClient {
  return {
    listCheckpoints: vi.fn().mockResolvedValue({ outcome: 'ok', checkpoints: [] }),
    createCheckpoint: vi.fn().mockResolvedValue({ outcome: 'ok', checkpoint: makeCheckpoint() }),
    previewCheckpointRestore: vi.fn().mockResolvedValue({
      outcome: 'ok',
      preview: {
        checkpointId: 'cp_1',
        commitsSinceCheckpoint: 0,
        hasUncommittedChangesToDiscard: false,
        isWorkInPlace: false,
      },
    }),
    restoreCheckpoint: vi.fn().mockResolvedValue({
      outcome: 'ok',
      result: { checkpointId: 'cp_1', discardedUncommittedChanges: false, commitsPreserved: 0 },
    }),
    ...overrides,
  };
}

describe('CheckpointsDialog (SPEC §7.20; issue #268/#603) — reached from the session row menu', () => {
  it('is not rendered while closed, and never lists', () => {
    const client = fakeClient();
    render(CheckpointsDialog, {
      props: { open: false, session: makeSession(), client, onClose: vi.fn() },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(client.listCheckpoints).not.toHaveBeenCalled();
  });

  it('loads the checkpoint list the moment it opens, named for the right session', async () => {
    const client = fakeClient();
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession({ id: 'sess-1' }), client, onClose: vi.fn() },
    });

    await waitFor(() => expect(client.listCheckpoints).toHaveBeenCalledWith('sess-1'));
  });

  it('names the session in the context line', async () => {
    const client = fakeClient();
    render(CheckpointsDialog, {
      props: {
        open: true,
        session: makeSession({ title: 'Add widget support' }),
        client,
        onClose: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('checkpoints-context').textContent).toContain('Add widget support'),
    );
  });

  it('lists a session\u2019s checkpoints with their label and time', async () => {
    const client = fakeClient({
      listCheckpoints: vi.fn().mockResolvedValue({
        outcome: 'ok',
        checkpoints: [makeCheckpoint({ id: 'cp_1', message: 'before the refactor' })],
      }),
    });
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await waitFor(() => {
      const row = screen.getByTestId('checkpoint-row-cp_1');
      expect(row.textContent).toContain('before the refactor');
      expect(row.textContent).toContain('2026');
    });
  });

  it('shows an empty state (not an error) when a session has no checkpoints yet', async () => {
    const client = fakeClient();
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await waitFor(() => expect(screen.getByTestId('ui-empty-state')).toBeTruthy());
    expect(screen.queryByTestId('ui-error-notice')).toBeNull();
  });

  it('an ssh: session (unsupported_target) shows the dedicated unsupported state, never a dead "Checkpoint now" control', async () => {
    const client = fakeClient({
      listCheckpoints: vi.fn().mockResolvedValue({
        outcome: 'error',
        errorType: 'unsupported_target',
        message: 'Checkpoint/rollback needs a local git worktree this node can reach directly.',
      }),
    });
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession({ id: 'sess_ssh' }), client, onClose: vi.fn() },
    });

    await waitFor(() => expect(screen.getByTestId('ui-empty-state').textContent).toContain('ssh:'));
    // No dead control sitting above a surface that will always fail.
    expect(screen.queryByTestId('checkpoint-create-button')).toBeNull();
    expect(screen.queryByTestId('ui-error-notice')).toBeNull();
  });

  it('a real load failure is shown through ErrorNotice, distinct from the unsupported state', async () => {
    const client = fakeClient({
      listCheckpoints: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });

  it('"Checkpoint now" sends the typed label and appends the returned checkpoint to the list without a full reload', async () => {
    const listCheckpoints = vi.fn().mockResolvedValue({ outcome: 'ok', checkpoints: [] });
    const createCheckpoint = vi.fn().mockResolvedValue({
      outcome: 'ok',
      checkpoint: makeCheckpoint({ id: 'cp_new', message: 'manual save' }),
    });
    const client = fakeClient({ listCheckpoints, createCheckpoint });
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession({ id: 'sess-1' }), client, onClose: vi.fn() },
    });

    const labelInput = (await screen.findByTestId('checkpoint-label-input')) as HTMLInputElement;
    await fireEvent.input(labelInput, { target: { value: 'manual save' } });
    await fireEvent.click(screen.getByTestId('checkpoint-create-button'));

    await waitFor(() => expect(createCheckpoint).toHaveBeenCalledWith('sess-1', 'manual save'));
    await waitFor(() =>
      expect(screen.getByTestId('checkpoint-row-cp_new').textContent).toContain('manual save'),
    );
    // No extra listCheckpoints call after create — the new checkpoint came
    // straight off createCheckpoint's own reply.
    expect(listCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('a checkpoint_create failure is shown inline without disturbing the existing list', async () => {
    const client = fakeClient({
      listCheckpoints: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', checkpoints: [makeCheckpoint({ id: 'cp_1' })] }),
      createCheckpoint: vi.fn().mockResolvedValue({
        outcome: 'error',
        errorType: 'dirty_submodule',
        message: 'submodule(s) with uncommitted state',
      }),
    });
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await screen.findByTestId('checkpoint-row-cp_1');
    await fireEvent.click(screen.getByTestId('checkpoint-create-button'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('submodule'),
    );
    expect(screen.getByTestId('checkpoint-row-cp_1')).toBeTruthy();
  });

  it('clicking "Restore\u2026" on a row opens the restore dialog for that exact checkpoint, stacked over this one', async () => {
    const previewCheckpointRestore = vi.fn().mockResolvedValue({
      outcome: 'ok',
      preview: {
        checkpointId: 'cp_2',
        commitsSinceCheckpoint: 0,
        hasUncommittedChangesToDiscard: false,
        isWorkInPlace: false,
      },
    });
    const client = fakeClient({
      listCheckpoints: vi.fn().mockResolvedValue({
        outcome: 'ok',
        checkpoints: [
          makeCheckpoint({ id: 'cp_1', message: 'first' }),
          makeCheckpoint({ id: 'cp_2', message: 'second' }),
        ],
      }),
      previewCheckpointRestore,
    });
    render(CheckpointsDialog, {
      props: { open: true, session: makeSession({ id: 'sess-1' }), client, onClose: vi.fn() },
    });

    await screen.findByTestId('checkpoint-row-cp_2');
    await fireEvent.click(screen.getByTestId('checkpoint-restore-cp_2'));

    await waitFor(() => expect(previewCheckpointRestore).toHaveBeenCalledWith('sess-1', 'cp_2'));
    await waitFor(() =>
      expect(screen.getByTestId('checkpoint-restore-context').textContent).toContain('second'),
    );
    // Both dialogs are stacked, not swapped — this dialog's own list is still there.
    expect(screen.getByTestId('checkpoint-list')).toBeTruthy();
  });

  it('re-loads fresh checkpoints each time it re-opens for a (possibly different) session', async () => {
    const listCheckpoints = vi.fn().mockResolvedValue({ outcome: 'ok', checkpoints: [] });
    const client = fakeClient({ listCheckpoints });
    const { rerender } = render(CheckpointsDialog, {
      props: { open: true, session: makeSession({ id: 'sess-1' }), client, onClose: vi.fn() },
    });
    await waitFor(() => expect(listCheckpoints).toHaveBeenCalledWith('sess-1'));

    await rerender({
      open: false,
      session: makeSession({ id: 'sess-1' }),
      client,
      onClose: vi.fn(),
    });
    await rerender({
      open: true,
      session: makeSession({ id: 'sess-2' }),
      client,
      onClose: vi.fn(),
    });

    await waitFor(() => expect(listCheckpoints).toHaveBeenCalledWith('sess-2'));
    expect(listCheckpoints).toHaveBeenCalledTimes(2);
  });
});
