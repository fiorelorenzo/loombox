// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitCheckpointV1 } from '@loombox/protocol';
import CheckpointRestoreDialog, {
  type CheckpointRestoreClient,
} from './CheckpointRestoreDialog.svelte';

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

function makeCheckpoint(overrides: Partial<GitCheckpointV1> = {}): GitCheckpointV1 {
  return {
    id: 'cp_1',
    sessionId: 'sess_1',
    message: 'before refactor',
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

function fakeClient(overrides: Partial<CheckpointRestoreClient> = {}): CheckpointRestoreClient {
  return {
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

describe('CheckpointRestoreDialog (SPEC §7.20; issue #268/#603)', () => {
  it('is not rendered while closed, and never previews', () => {
    const client = fakeClient();
    render(CheckpointRestoreDialog, {
      props: {
        open: false,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint(),
        client,
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(client.previewCheckpointRestore).not.toHaveBeenCalled();
  });

  it('loads a preview the moment it opens — no side effect, never calls restoreCheckpoint', async () => {
    const client = fakeClient();
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint({ id: 'cp_9' }),
        client,
        onClose: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(client.previewCheckpointRestore).toHaveBeenCalledWith('sess_1', 'cp_9'),
    );
    expect(client.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it('names the checkpoint label and time in the context line', async () => {
    const client = fakeClient();
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint({ message: 'before the big refactor' }),
        client,
        onClose: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('checkpoint-restore-context').textContent).toContain(
        'before the big refactor',
      ),
    );
  });

  it('shows what will be discarded and what stays untouched, from the preview alone — not a generic "are you sure"', async () => {
    const client = fakeClient({
      previewCheckpointRestore: vi.fn().mockResolvedValue({
        outcome: 'ok',
        preview: {
          checkpointId: 'cp_1',
          commitsSinceCheckpoint: 3,
          hasUncommittedChangesToDiscard: true,
          isWorkInPlace: false,
        },
      }),
    });
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint(),
        client,
        onClose: vi.fn(),
      },
    });

    await waitFor(() => {
      const preview = screen.getByTestId('checkpoint-restore-preview').textContent ?? '';
      expect(preview).toContain('discard');
      expect(preview).toContain('3');
      expect(preview).toContain('stay untouched');
    });
  });

  it('gives a sharper warning when the preview reports isWorkInPlace, since uncommitted state may be the human\u2019s own edits', async () => {
    const client = fakeClient({
      previewCheckpointRestore: vi.fn().mockResolvedValue({
        outcome: 'ok',
        preview: {
          checkpointId: 'cp_1',
          commitsSinceCheckpoint: 0,
          hasUncommittedChangesToDiscard: true,
          isWorkInPlace: true,
        },
      }),
    });
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint(),
        client,
        onClose: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('checkpoint-restore-preview').textContent).toContain(
        'your project folder',
      ),
    );
  });

  it('a checkpoint_not_found preview error is shown verbatim through ErrorNotice, not a generic failure', async () => {
    const client = fakeClient({
      previewCheckpointRestore: vi.fn().mockResolvedValue({
        outcome: 'error',
        errorType: 'checkpoint_not_found',
        message: 'checkpoint "cp_1" not found for session "sess_1"',
      }),
    });
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint(),
        client,
        onClose: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('not found'),
    );
    expect(screen.queryByTestId('checkpoint-restore-confirm')).toBeNull();
  });

  it('clicking "Restore checkpoint" sends confirm: true and shows what was actually discarded/preserved on success', async () => {
    const client = fakeClient({
      restoreCheckpoint: vi.fn().mockResolvedValue({
        outcome: 'ok',
        result: { checkpointId: 'cp_1', discardedUncommittedChanges: true, commitsPreserved: 2 },
      }),
    });
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint(),
        client,
        onClose: vi.fn(),
      },
    });

    const confirmButton = await screen.findByTestId('checkpoint-restore-confirm');
    await fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(client.restoreCheckpoint).toHaveBeenCalledWith('sess_1', 'cp_1', true),
    );
    await waitFor(() => {
      const result = screen.getByTestId('checkpoint-restore-result').textContent ?? '';
      expect(result).toContain('discarded');
      expect(result).toContain('2');
    });
    // The confirm form is replaced by the result view — a second click can't fire twice.
    expect(screen.queryByTestId('checkpoint-restore-confirm')).toBeNull();
  });

  it('Done, after a successful restore, closes the dialog', async () => {
    const onClose = vi.fn();
    const client = fakeClient();
    render(CheckpointRestoreDialog, {
      props: { open: true, sessionId: 'sess_1', checkpoint: makeCheckpoint(), client, onClose },
    });

    await fireEvent.click(await screen.findByTestId('checkpoint-restore-confirm'));
    await screen.findByTestId('checkpoint-restore-done');
    await fireEvent.click(screen.getByTestId('checkpoint-restore-done'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes without ever calling restoreCheckpoint', async () => {
    const onClose = vi.fn();
    const client = fakeClient();
    render(CheckpointRestoreDialog, {
      props: { open: true, sessionId: 'sess_1', checkpoint: makeCheckpoint(), client, onClose },
    });

    await screen.findByTestId('checkpoint-restore-confirm');
    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it('a restore refused mid-turn shows the node\u2019s own turn_in_progress reason verbatim, not a generic failure, and keeps the form so the operator can retry', async () => {
    const client = fakeClient({
      restoreCheckpoint: vi.fn().mockResolvedValue({
        outcome: 'error',
        errorType: 'turn_in_progress',
        message:
          "This session's agent is actively working on a turn; wait for it to finish (or stop it) before rolling back.",
      }),
    });
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint(),
        client,
        onClose: vi.fn(),
      },
    });

    await fireEvent.click(await screen.findByTestId('checkpoint-restore-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain(
        'actively working on a turn',
      ),
    );
    // The form stays so the operator can retry once the turn finishes.
    expect(screen.getByTestId('checkpoint-restore-confirm')).toBeTruthy();
    expect(screen.queryByTestId('checkpoint-restore-result')).toBeNull();
  });

  it('rephrases a transport timeout instead of leaking the wire identifier at the user', async () => {
    const client = fakeClient({
      restoreCheckpoint: vi
        .fn()
        .mockRejectedValue(
          new Error('RelayClient: timed out waiting for checkpoint_restore_result'),
        ),
    });
    render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint(),
        client,
        onClose: vi.fn(),
      },
    });

    await fireEvent.click(await screen.findByTestId('checkpoint-restore-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain(
        'Nothing answered in time',
      ),
    );
  });

  it('re-loads a fresh preview each time it re-opens for a (possibly different) checkpoint', async () => {
    const previewCheckpointRestore = vi.fn().mockResolvedValue({
      outcome: 'ok',
      preview: {
        checkpointId: 'cp_1',
        commitsSinceCheckpoint: 0,
        hasUncommittedChangesToDiscard: false,
        isWorkInPlace: false,
      },
    });
    const client = fakeClient({ previewCheckpointRestore });
    const { rerender } = render(CheckpointRestoreDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        checkpoint: makeCheckpoint({ id: 'cp_1' }),
        client,
        onClose: vi.fn(),
      },
    });
    await waitFor(() => expect(previewCheckpointRestore).toHaveBeenCalledWith('sess_1', 'cp_1'));

    await rerender({
      open: false,
      sessionId: 'sess_1',
      checkpoint: makeCheckpoint({ id: 'cp_1' }),
      client,
      onClose: vi.fn(),
    });
    await rerender({
      open: true,
      sessionId: 'sess_1',
      checkpoint: makeCheckpoint({ id: 'cp_2' }),
      client,
      onClose: vi.fn(),
    });

    await waitFor(() => expect(previewCheckpointRestore).toHaveBeenCalledWith('sess_1', 'cp_2'));
    expect(previewCheckpointRestore).toHaveBeenCalledTimes(2);
  });
});
