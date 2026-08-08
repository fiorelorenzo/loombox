// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitConflictResolveResponsePayloadV1 } from '@loombox/protocol';
import ConflictResolveDialog, {
  type ConflictResolveDialogClient,
} from './ConflictResolveDialog.svelte';

// jsdom has no Web Animations API; `Dialog`'s panel-lift transition calls
// `element.animate()` once opened/closed reactively (see
// `CommitDialog.test.ts`'s identical stub for why).
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

const OK_PROPOSAL: GitConflictResolveResponsePayloadV1 = {
  outcome: 'ok',
  path: 'notes.txt',
  baseHash: 'deadbeef',
  hunks: [
    {
      index: 0,
      oursLabel: 'HEAD',
      theirsLabel: 'feature',
      oursText: 'MAIN-EDIT\n',
      theirsText: 'FEATURE-EDIT\n',
      baseText: null,
    },
  ],
  resolution: [{ index: 0, origin: 'rewritten', resolvedText: 'MERGED-EDIT\n' }],
  resolvedContent: 'one\nMERGED-EDIT\nthree\n',
};

function fakeClient(
  overrides: Partial<ConflictResolveDialogClient> = {},
): ConflictResolveDialogClient {
  return {
    requestGitConflictResolve: vi.fn().mockResolvedValue(OK_PROPOSAL),
    writeFile: vi.fn().mockResolvedValue({ outcome: 'ok', path: 'notes.txt', hash: 'newhash' }),
    ...overrides,
  };
}

describe('ConflictResolveDialog (SPEC §7.6 AI merge-conflict resolution; issue #237)', () => {
  it('is not rendered while closed, and never proposes or writes anything', () => {
    const client = fakeClient();
    render(ConflictResolveDialog, {
      props: {
        open: false,
        sessionId: 'sess-1',
        path: 'notes.txt',
        client,
        onClose: vi.fn(),
        onApplied: vi.fn(),
      },
    });

    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(client.requestGitConflictResolve).not.toHaveBeenCalled();
    expect(client.writeFile).not.toHaveBeenCalled();
  });

  it('requests a proposal the moment it opens, and shows each hunk with its raw markers and a badge naming which side the derived origin actually is — never silently applying anything', async () => {
    const client = fakeClient();
    render(ConflictResolveDialog, {
      props: {
        open: true,
        sessionId: 'sess-1',
        path: 'notes.txt',
        client,
        onClose: vi.fn(),
        onApplied: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(client.requestGitConflictResolve).toHaveBeenCalledWith('sess-1', {
        path: 'notes.txt',
      }),
    );

    const hunks = await screen.findAllByTestId('conflict-resolve-hunk');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.textContent).toContain('HEAD');
    expect(hunks[0]!.textContent).toContain('MAIN-EDIT');
    expect(hunks[0]!.textContent).toContain('feature');
    expect(hunks[0]!.textContent).toContain('FEATURE-EDIT');
    expect(hunks[0]!.textContent).toContain('rewritten');

    const draft = screen.getByTestId('conflict-resolve-draft') as HTMLTextAreaElement;
    expect(draft.value).toBe('one\nMERGED-EDIT\nthree\n');
    expect(client.writeFile).not.toHaveBeenCalled();
  });

  it('applying is one deliberate action: Apply sends the (possibly hand-edited) draft with the proposal\u2019s own baseHash, then reports success', async () => {
    const client = fakeClient();
    const onApplied = vi.fn();
    render(ConflictResolveDialog, {
      props: {
        open: true,
        sessionId: 'sess-1',
        path: 'notes.txt',
        client,
        onClose: vi.fn(),
        onApplied,
      },
    });

    const draft = (await screen.findByTestId('conflict-resolve-draft')) as HTMLTextAreaElement;
    await waitFor(() => expect(draft.value).toBe('one\nMERGED-EDIT\nthree\n'));
    await fireEvent.input(draft, { target: { value: 'one\nHAND-EDITED\nthree\n' } });
    await fireEvent.click(screen.getByTestId('conflict-resolve-apply'));

    await waitFor(() =>
      expect(client.writeFile).toHaveBeenCalledWith('sess-1', {
        path: 'notes.txt',
        content: 'one\nHAND-EDITED\nthree\n',
        baseHash: 'deadbeef',
      }),
    );
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('conflict-resolve-applied')).toBeTruthy();
  });

  it('declining (closing without applying) never calls writeFile \u2014 the file is left exactly as it was', async () => {
    const client = fakeClient();
    const onClose = vi.fn();
    render(ConflictResolveDialog, {
      props: {
        open: true,
        sessionId: 'sess-1',
        path: 'notes.txt',
        client,
        onClose,
        onApplied: vi.fn(),
      },
    });

    await screen.findByTestId('conflict-resolve-hunk');
    await fireEvent.click(screen.getByTestId('conflict-resolve-decline'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.writeFile).not.toHaveBeenCalled();
  });

  it('a too_large outcome shows the real hunk count and bound, and never renders hunks or a draft to apply', async () => {
    const client = fakeClient({
      requestGitConflictResolve: vi.fn().mockResolvedValue({
        outcome: 'too_large',
        path: 'huge.txt',
        message: 'too many hunks',
        hunkCount: 20,
        maxHunks: 12,
      }),
    });
    render(ConflictResolveDialog, {
      props: {
        open: true,
        sessionId: 'sess-1',
        path: 'huge.txt',
        client,
        onClose: vi.fn(),
        onApplied: vi.fn(),
      },
    });

    const notice = await screen.findByTestId('conflict-resolve-too-large');
    expect(notice.textContent).toContain('20');
    expect(notice.textContent).toContain('12');
    expect(screen.queryByTestId('conflict-resolve-hunk')).toBeNull();
    expect(screen.queryByTestId('conflict-resolve-draft')).toBeNull();
    expect(client.writeFile).not.toHaveBeenCalled();
  });

  it('an error outcome (e.g. no live agent) shows a retryable notice rather than hanging on the loading state', async () => {
    const client = fakeClient({
      requestGitConflictResolve: vi
        .fn()
        .mockResolvedValue({ outcome: 'error', path: 'notes.txt', message: 'no live agent' }),
    });
    render(ConflictResolveDialog, {
      props: {
        open: true,
        sessionId: 'sess-1',
        path: 'notes.txt',
        client,
        onClose: vi.fn(),
        onApplied: vi.fn(),
      },
    });

    expect(await screen.findByText('no live agent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it("a write-time conflict (the file changed underneath since the proposal) shows what's actually on disk now and offers Reload rather than clobbering it", async () => {
    const client = fakeClient({
      writeFile: vi.fn().mockResolvedValue({
        outcome: 'conflict',
        path: 'notes.txt',
        current: { content: 'changed on disk', hash: 'newer', truncated: false },
      }),
    });
    render(ConflictResolveDialog, {
      props: {
        open: true,
        sessionId: 'sess-1',
        path: 'notes.txt',
        client,
        onClose: vi.fn(),
        onApplied: vi.fn(),
      },
    });

    await screen.findByTestId('conflict-resolve-hunk');
    await fireEvent.click(screen.getByTestId('conflict-resolve-apply'));

    const conflictNotice = await screen.findByTestId('conflict-resolve-write-conflict');
    expect(conflictNotice.textContent).toContain('notes.txt');
    expect(screen.getByTestId('conflict-resolve-reload')).toBeTruthy();
    expect(screen.queryByTestId('conflict-resolve-applied')).toBeNull();
  });

  it('re-requests a fresh proposal each time it re-opens for a different path, discarding the previous draft', async () => {
    const requestGitConflictResolve = vi
      .fn()
      .mockResolvedValueOnce(OK_PROPOSAL)
      .mockResolvedValueOnce({ ...OK_PROPOSAL, path: 'other.txt', resolvedContent: 'fresh\n' });
    const client = fakeClient({ requestGitConflictResolve });
    const { rerender } = render(ConflictResolveDialog, {
      props: {
        open: true,
        sessionId: 'sess-1',
        path: 'notes.txt',
        client,
        onClose: vi.fn(),
        onApplied: vi.fn(),
      },
    });

    await waitFor(() => {
      const draft = screen.getByTestId('conflict-resolve-draft') as HTMLTextAreaElement;
      expect(draft.value).toBe('one\nMERGED-EDIT\nthree\n');
    });

    await rerender({
      open: true,
      sessionId: 'sess-1',
      path: 'other.txt',
      client,
      onClose: vi.fn(),
      onApplied: vi.fn(),
    });

    await waitFor(() =>
      expect(requestGitConflictResolve).toHaveBeenCalledWith('sess-1', { path: 'other.txt' }),
    );
    await waitFor(() => {
      const draft = screen.getByTestId('conflict-resolve-draft') as HTMLTextAreaElement;
      expect(draft.value).toBe('fresh\n');
    });
  });
});
