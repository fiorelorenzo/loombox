// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GitCommitDraftResponsePayloadV1,
  GitCommitResponsePayloadV1,
} from '@loombox/protocol';
import CommitDialog, { type CommitDialogClient } from './CommitDialog.svelte';

// jsdom has no Web Animations API; `Dialog`'s panel-lift transition calls
// `element.animate()` once opened/closed reactively (see
// `TargetStatusView.test.ts`'s identical stub for why).
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      play: () => {},
      pause: () => {},
      finish: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

afterEach(() => cleanup());

const OK_DRAFT: GitCommitDraftResponsePayloadV1 = { outcome: 'ok', message: 'Add widget support' };
const OK_COMMIT: GitCommitResponsePayloadV1 = { outcome: 'ok', sha: 'deadbeef1234' };

function fakeClient(overrides: Partial<CommitDialogClient> = {}): CommitDialogClient {
  return {
    requestGitCommitDraft: vi.fn().mockResolvedValue(OK_DRAFT),
    commitStaged: vi.fn().mockResolvedValue(OK_COMMIT),
    ...overrides,
  };
}

describe('CommitDialog (SPEC §7.6 commit workflow with AI-generated commit messages; issue #233)', () => {
  it('is not rendered while closed, and never drafts or commits', () => {
    const client = fakeClient();
    render(CommitDialog, {
      props: { open: false, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(client.requestGitCommitDraft).not.toHaveBeenCalled();
    expect(client.commitStaged).not.toHaveBeenCalled();
  });

  it('drafts a commit message the moment it opens, by prompting the session\u2019s own agent \u2014 never commits automatically', async () => {
    const client = fakeClient();
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    await waitFor(() => expect(client.requestGitCommitDraft).toHaveBeenCalledWith('sess-1'));
    await waitFor(() => {
      const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
      expect(input.value).toBe('Add widget support');
    });
    expect(client.commitStaged).not.toHaveBeenCalled();
  });

  it('committing with no edits uses the draft verbatim', async () => {
    const client = fakeClient();
    const onCommitted = vi.fn();
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted },
    });

    await waitFor(() => {
      const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
      expect(input.value).toBe('Add widget support');
    });
    await fireEvent.click(screen.getByTestId('commit-confirm'));

    await waitFor(() =>
      expect(client.commitStaged).toHaveBeenCalledWith('sess-1', {
        message: 'Add widget support',
      }),
    );
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('lets the operator edit the draft before committing \u2014 the edited text, not the draft, is what gets committed', async () => {
    const client = fakeClient();
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    const input = (await screen.findByTestId('commit-message-input')) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe('Add widget support'));
    await fireEvent.input(input, { target: { value: 'Add widget support (edited by hand)' } });
    await fireEvent.click(screen.getByTestId('commit-confirm'));

    await waitFor(() =>
      expect(client.commitStaged).toHaveBeenCalledWith('sess-1', {
        message: 'Add widget support (edited by hand)',
      }),
    );
  });

  it('the confirm button stays disabled while drafting, and while the message is empty', async () => {
    const client = fakeClient({
      requestGitCommitDraft: vi.fn().mockResolvedValue({
        outcome: 'error',
        message: 'Nothing staged to draft a commit message for.',
      }),
    });
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    const confirmButton = (await screen.findByTestId('commit-confirm')) as HTMLButtonElement;
    await waitFor(() => expect(confirmButton.disabled).toBe(true));
    expect(client.commitStaged).not.toHaveBeenCalled();

    const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: 'Hand-typed message' } });
    expect(confirmButton.disabled).toBe(false);
  });

  it('a draft failure shows a retryable error notice but still lets the operator type and commit a message by hand', async () => {
    const client = fakeClient({
      requestGitCommitDraft: vi
        .fn()
        .mockResolvedValue({ outcome: 'error', message: 'This session has no live agent.' }),
    });
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    await waitFor(() => expect(screen.getByText(/This session has no live agent\./)).toBeTruthy());

    const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: 'Hand-typed message' } });
    await fireEvent.click(screen.getByTestId('commit-confirm'));

    await waitFor(() =>
      expect(client.commitStaged).toHaveBeenCalledWith('sess-1', { message: 'Hand-typed message' }),
    );
  });

  it('a draft request that times out reads as "The commit draft didn\'t answer in time...", never the raw wire message (issue #650)', async () => {
    const client = fakeClient({
      requestGitCommitDraft: vi
        .fn()
        .mockRejectedValue(
          new Error('RelayClient: timed out waiting for git_commit_draft_response'),
        ),
    });
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    const notice = await waitFor(() => screen.getByTestId('ui-error-notice'));
    expect(notice.textContent).not.toContain('git_commit_draft_response');
    expect(notice.textContent).toContain("The commit draft didn't answer in time.");

    // Retrying still works, and hand-typing still commits even after a
    // failed draft — the same guarantee the structured-reply failure case
    // above already covers.
    const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: 'Hand-typed message' } });
    expect((screen.getByTestId('commit-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the sha and lets Done close the dialog on a successful commit \u2014 a second click cannot fire twice', async () => {
    const onClose = vi.fn();
    const client = fakeClient();
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose, onCommitted: vi.fn() },
    });

    await waitFor(() => {
      const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
      expect(input.value).toBe('Add widget support');
    });
    await fireEvent.click(screen.getByTestId('commit-confirm'));

    const result = await screen.findByTestId('commit-result');
    expect(result.textContent).toContain('deadbeef1234'.slice(0, 12));
    // The form is replaced by the success view — a second click can't fire twice.
    expect(screen.queryByTestId('commit-confirm')).toBeNull();
    expect(client.commitStaged).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId('commit-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes without committing anything', async () => {
    const onClose = vi.fn();
    const client = fakeClient();
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose, onCommitted: vi.fn() },
    });

    await screen.findByTestId('commit-message-input');
    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.commitStaged).not.toHaveBeenCalled();
  });

  it('shows the node-reported message and stays open when the commit resolves outcome: error (e.g. an index that went empty since the draft loaded)', async () => {
    const client = fakeClient({
      commitStaged: vi
        .fn()
        .mockResolvedValue({ outcome: 'error', message: 'nothing staged to commit' }),
    });
    const onCommitted = vi.fn();
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted },
    });

    await waitFor(() => {
      const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
      expect(input.value).toBe('Add widget support');
    });
    await fireEvent.click(screen.getByTestId('commit-confirm'));

    await waitFor(() => expect(screen.getByText(/nothing staged to commit/)).toBeTruthy());
    expect(screen.getByTestId('commit-confirm')).toBeTruthy();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('rephrases a transport timeout instead of leaking the wire identifier at the user (issue #505 precedent)', async () => {
    const client = fakeClient({
      commitStaged: vi
        .fn()
        .mockRejectedValue(new Error('timed out waiting for git_commit_response')),
    });
    render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    await waitFor(() => {
      const input = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
      expect(input.value).toBe('Add widget support');
    });
    await fireEvent.click(screen.getByTestId('commit-confirm'));

    await waitFor(() => expect(screen.getByText(/node may be asleep, offline/)).toBeTruthy());
    expect(screen.queryByText(/git_commit_response/)).toBeNull();
  });

  it('re-drafts fresh each time it re-opens, discarding the previous session\u2019s in-progress edit', async () => {
    const client = fakeClient();
    const { rerender } = render(CommitDialog, {
      props: { open: true, sessionId: 'sess-1', client, onClose: vi.fn(), onCommitted: vi.fn() },
    });

    const input = (await screen.findByTestId('commit-message-input')) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe('Add widget support'));
    await fireEvent.input(input, {
      target: { value: 'an in-progress edit, about to be discarded' },
    });

    await rerender({
      open: false,
      sessionId: 'sess-1',
      client,
      onClose: vi.fn(),
      onCommitted: vi.fn(),
    });
    client.requestGitCommitDraft = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', message: 'Fresh draft for the next open' });
    await rerender({
      open: true,
      sessionId: 'sess-2',
      client,
      onClose: vi.fn(),
      onCommitted: vi.fn(),
    });

    await waitFor(() => expect(client.requestGitCommitDraft).toHaveBeenCalledWith('sess-2'));
    await waitFor(() => {
      const reopened = screen.getByTestId('commit-message-input') as HTMLTextAreaElement;
      expect(reopened.value).toBe('Fresh draft for the next open');
    });
  });
});
