// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitCheckpointV1 } from '@loombox/protocol';
import CheckpointPanel, { type CheckpointListClient } from './CheckpointPanel.svelte';

// jsdom has no Web Animations API; the restore dialog this panel mounts
// (`Dialog`'s panel-lift transition) calls `element.animate()` once opened
// reactively — see `TargetStatusView.test.ts`'s identical stub for why.
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

function fakeClient(overrides: Partial<CheckpointListClient> = {}): CheckpointListClient {
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

describe('CheckpointPanel (SPEC §7.20; issue #268/#603)', () => {
  it('shows an empty state instead of fetching anything when there is no active session', () => {
    const client = fakeClient();
    render(CheckpointPanel, { props: { client } });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(client.listCheckpoints).not.toHaveBeenCalled();
  });

  it('lists a session\u2019s checkpoints with their label and time', async () => {
    const client = fakeClient({
      listCheckpoints: vi.fn().mockResolvedValue({
        outcome: 'ok',
        checkpoints: [makeCheckpoint({ id: 'cp_1', message: 'before the refactor' })],
      }),
    });
    render(CheckpointPanel, { props: { sessionId: 'sess_1', client } });

    await waitFor(() => expect(client.listCheckpoints).toHaveBeenCalledWith('sess_1'));
    await waitFor(() => {
      const row = screen.getByTestId('checkpoint-row-cp_1');
      expect(row.textContent).toContain('before the refactor');
      expect(row.textContent).toContain('2026');
    });
  });

  it('shows an empty state (not an error) when a session has no checkpoints yet', async () => {
    const client = fakeClient();
    render(CheckpointPanel, { props: { sessionId: 'sess_1', client } });

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
    render(CheckpointPanel, { props: { sessionId: 'sess_ssh', client } });

    await waitFor(() => expect(screen.getByTestId('ui-empty-state').textContent).toContain('ssh:'));
    // No dead control sitting above a surface that will always fail.
    expect(screen.queryByTestId('checkpoint-create-button')).toBeNull();
    expect(screen.queryByTestId('ui-error-notice')).toBeNull();
  });

  it('a real load failure is shown through ErrorNotice, distinct from the unsupported state', async () => {
    const client = fakeClient({
      listCheckpoints: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(CheckpointPanel, { props: { sessionId: 'sess_1', client } });

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
    render(CheckpointPanel, { props: { sessionId: 'sess_1', client } });

    const labelInput = (await screen.findByTestId('checkpoint-label-input')) as HTMLInputElement;
    await fireEvent.input(labelInput, { target: { value: 'manual save' } });
    await fireEvent.click(screen.getByTestId('checkpoint-create-button'));

    await waitFor(() => expect(createCheckpoint).toHaveBeenCalledWith('sess_1', 'manual save'));
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
    render(CheckpointPanel, { props: { sessionId: 'sess_1', client } });

    await screen.findByTestId('checkpoint-row-cp_1');
    await fireEvent.click(screen.getByTestId('checkpoint-create-button'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('submodule'),
    );
    expect(screen.getByTestId('checkpoint-row-cp_1')).toBeTruthy();
  });

  it('clicking "Restore\u2026" on a row opens the restore dialog for that exact checkpoint', async () => {
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
    render(CheckpointPanel, { props: { sessionId: 'sess_1', client } });

    await screen.findByTestId('checkpoint-row-cp_2');
    await fireEvent.click(screen.getByTestId('checkpoint-restore-cp_2'));

    await waitFor(() => expect(previewCheckpointRestore).toHaveBeenCalledWith('sess_1', 'cp_2'));
    await waitFor(() =>
      expect(screen.getByTestId('checkpoint-restore-context').textContent).toContain('second'),
    );
  });
});
