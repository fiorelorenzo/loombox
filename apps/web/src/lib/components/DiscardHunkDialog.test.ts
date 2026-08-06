// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHunkActionResponsePayloadV1, GitHunkV1 } from '@loombox/protocol';
import DiscardHunkDialog, { type DiscardHunkClient } from './DiscardHunkDialog.svelte';

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
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

afterEach(() => cleanup());

function makeHunk(overrides: Partial<GitHunkV1> = {}): GitHunkV1 {
  return {
    header: '@@ -18,1 +18,1 @@',
    oldStart: 18,
    oldLines: 1,
    newStart: 18,
    newLines: 1,
    lines: [
      { kind: 'removed', text: 'line18' },
      { kind: 'added', text: 'LINE18' },
    ],
    ...overrides,
  };
}

function fakeClient(
  applyGitHunkAction: DiscardHunkClient['applyGitHunkAction'],
): DiscardHunkClient {
  return { applyGitHunkAction };
}

describe('DiscardHunkDialog (SPEC §7.6 hunk-level staging; issue #232)', () => {
  it('is not rendered while closed', () => {
    render(DiscardHunkDialog, {
      props: {
        open: false,
        sessionId: 'sess_1',
        client: fakeClient(vi.fn()),
        path: 'multi.txt',
        hunkIndex: 0,
        hunk: makeHunk(),
        onClose: vi.fn(),
        onDiscarded: vi.fn(),
      },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('names the file and the line the hunk starts at', () => {
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(vi.fn()),
        path: 'src/multi.txt',
        hunkIndex: 0,
        hunk: makeHunk({ newStart: 18 }),
        onClose: vi.fn(),
        onDiscarded: vi.fn(),
      },
    });
    const context = screen.getByTestId('discard-hunk-context').textContent ?? '';
    expect(context).toContain('src/multi.txt');
    expect(context).toContain('18');
  });

  it('describes a mixed edit as both removing the added lines and restoring the removed ones', () => {
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(vi.fn()),
        path: 'multi.txt',
        hunkIndex: 0,
        hunk: makeHunk(),
        onClose: vi.fn(),
        onDiscarded: vi.fn(),
      },
    });
    const context = screen.getByTestId('discard-hunk-context').textContent ?? '';
    expect(context).toContain('remove 1 added line');
    expect(context).toContain('restore 1 removed line');
  });

  it('describes a pure addition as only removing the added lines', () => {
    const pureAddition = makeHunk({
      oldStart: 0,
      oldLines: 0,
      lines: [
        { kind: 'added', text: 'first' },
        { kind: 'added', text: 'second' },
      ],
    });
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(vi.fn()),
        path: 'new.txt',
        hunkIndex: 0,
        hunk: pureAddition,
        onClose: vi.fn(),
        onDiscarded: vi.fn(),
      },
    });
    const context = screen.getByTestId('discard-hunk-context').textContent ?? '';
    expect(context).toContain('remove 2 added lines');
    expect(context).not.toContain('restore');
  });

  it('on confirm applies a discard action for exactly this path/hunkIndex, then fires onDiscarded and onClose', async () => {
    const applyGitHunkAction = vi
      .fn<DiscardHunkClient['applyGitHunkAction']>()
      .mockResolvedValue({ outcome: 'ok' } satisfies GitHunkActionResponsePayloadV1);
    const onDiscarded = vi.fn();
    const onClose = vi.fn();
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_discard',
        client: fakeClient(applyGitHunkAction),
        path: 'multi.txt',
        hunkIndex: 2,
        hunk: makeHunk(),
        onClose,
        onDiscarded,
      },
    });

    await fireEvent.click(screen.getByTestId('discard-hunk-confirm'));

    expect(applyGitHunkAction).toHaveBeenCalledWith('sess_discard', {
      path: 'multi.txt',
      hunkIndex: 2,
      action: 'discard',
    });
    await vi.waitFor(() => expect(onDiscarded).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    // onDiscarded fires before onClose, per this dialog's own documented contract.
    expect(onDiscarded.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0]!,
    );
  });

  it('Cancel closes without discarding', async () => {
    const applyGitHunkAction = vi.fn<DiscardHunkClient['applyGitHunkAction']>();
    const onClose = vi.fn();
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(applyGitHunkAction),
        path: 'multi.txt',
        hunkIndex: 0,
        hunk: makeHunk(),
        onClose,
        onDiscarded: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(applyGitHunkAction).not.toHaveBeenCalled();
  });

  it('shows the node-reported message and stays open when the action resolves outcome: error', async () => {
    const applyGitHunkAction = vi.fn<DiscardHunkClient['applyGitHunkAction']>().mockResolvedValue({
      outcome: 'error',
      message: 'no such unstaged hunk at index 0 for "multi.txt"',
    } satisfies GitHunkActionResponsePayloadV1);
    const onClose = vi.fn();
    const onDiscarded = vi.fn();
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(applyGitHunkAction),
        path: 'multi.txt',
        hunkIndex: 0,
        hunk: makeHunk(),
        onClose,
        onDiscarded,
      },
    });

    await fireEvent.click(screen.getByTestId('discard-hunk-confirm'));

    await vi.waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain(
        'no such unstaged hunk at index 0',
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it('shows an error notice and stays open when applyGitHunkAction rejects outright', async () => {
    const applyGitHunkAction = vi
      .fn<DiscardHunkClient['applyGitHunkAction']>()
      .mockRejectedValue(new Error('git apply failed'));
    const onClose = vi.fn();
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(applyGitHunkAction),
        path: 'multi.txt',
        hunkIndex: 0,
        hunk: makeHunk(),
        onClose,
        onDiscarded: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId('discard-hunk-confirm'));

    await vi.waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('git apply failed'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rephrases a transport timeout instead of leaking the wire identifier at the user (issue #505 precedent)', async () => {
    const applyGitHunkAction = vi
      .fn<DiscardHunkClient['applyGitHunkAction']>()
      .mockRejectedValue(new Error('RelayClient: timed out waiting for git_hunk_action_response'));
    render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(applyGitHunkAction),
        path: 'multi.txt',
        hunkIndex: 0,
        hunk: makeHunk(),
        onClose: vi.fn(),
        onDiscarded: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId('discard-hunk-confirm'));

    const notice = await vi.waitFor(() => screen.getByTestId('ui-error-notice'));
    expect(notice.textContent).not.toContain('git_hunk_action_response');
    expect(notice.textContent).toContain('may be asleep, offline, or on an older relay');
    expect(notice.textContent).toContain('Nothing was discarded');
  });

  it('resets its error/loading state when reopened for a different hunk', async () => {
    const applyGitHunkAction = vi.fn<DiscardHunkClient['applyGitHunkAction']>().mockResolvedValue({
      outcome: 'error',
      message: 'boom',
    } satisfies GitHunkActionResponsePayloadV1);
    const { rerender } = render(DiscardHunkDialog, {
      props: {
        open: true,
        sessionId: 'sess_1',
        client: fakeClient(applyGitHunkAction),
        path: 'a.txt',
        hunkIndex: 0,
        hunk: makeHunk(),
        onClose: vi.fn(),
        onDiscarded: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId('discard-hunk-confirm'));
    await vi.waitFor(() => expect(screen.getByTestId('ui-error-notice')).toBeTruthy());

    await rerender({
      open: false,
      sessionId: 'sess_1',
      client: fakeClient(applyGitHunkAction),
      path: 'a.txt',
      hunkIndex: 0,
      hunk: makeHunk(),
      onClose: vi.fn(),
      onDiscarded: vi.fn(),
    });
    await rerender({
      open: true,
      sessionId: 'sess_1',
      client: fakeClient(applyGitHunkAction),
      path: 'b.txt',
      hunkIndex: 0,
      hunk: makeHunk(),
      onClose: vi.fn(),
      onDiscarded: vi.fn(),
    });

    expect(screen.queryByTestId('ui-error-notice')).toBeNull();
  });
});
