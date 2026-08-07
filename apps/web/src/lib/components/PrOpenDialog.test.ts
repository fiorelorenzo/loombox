// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrOpenOutcome, PrOpenPreviewOutcome } from '@loombox/protocol';
import type { ClientSessionMeta } from '$lib/relay-client';
import PrOpenDialog, { type PrOpenClient } from './PrOpenDialog.svelte';

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

function fakeClient(overrides: Partial<PrOpenClient> = {}): PrOpenClient {
  return {
    previewPrOpen: vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'loombox/session-1',
      base: 'main',
      commitCount: 2,
    }),
    openPr: vi.fn().mockResolvedValue({
      outcome: 'ok',
      url: 'https://github.com/acme/widgets/pull/7',
      number: 7,
    }),
    ...overrides,
  };
}

const OK_PREVIEW: PrOpenPreviewOutcome = {
  outcome: 'ok',
  branch: 'loombox/session-1',
  base: 'main',
  commitCount: 2,
};

describe('PrOpenDialog (SPEC §7.14; issue #238)', () => {
  it('is not rendered while closed, and never previews', () => {
    const client = fakeClient();
    render(PrOpenDialog, {
      props: { open: false, session: makeSession(), client, onClose: vi.fn() },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(client.previewPrOpen).not.toHaveBeenCalled();
  });

  it('loads a preview the moment it opens — no side effect, never calls openPr', async () => {
    const client = fakeClient();
    render(PrOpenDialog, {
      props: { open: true, session: makeSession({ id: 'sess-1' }), client, onClose: vi.fn() },
    });

    await waitFor(() => expect(client.previewPrOpen).toHaveBeenCalledWith('sess-1'));
    await waitFor(() =>
      expect(screen.getByTestId('pr-open-preview').textContent).toContain('loombox/session-1'),
    );
    expect(screen.getByTestId('pr-open-preview').textContent).toContain('main');
    expect(screen.getByTestId('pr-open-preview').textContent).toContain('2');
    expect(client.openPr).not.toHaveBeenCalled();
  });

  it('names the session in the context line', async () => {
    const client = fakeClient();
    render(PrOpenDialog, {
      props: {
        open: true,
        session: makeSession({ title: 'Add widget support' }),
        client,
        onClose: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('pr-open-context').textContent).toContain('Add widget support'),
    );
  });

  it('a no_commits preview shows a distinct, visible reason instead of the title/body form', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockResolvedValue({
        outcome: 'failure',
        category: 'no_commits',
        reason: '"loombox/session-1" has no commits ahead of "main"',
      } satisfies PrOpenPreviewOutcome),
    });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('No commits'),
    );
    expect(screen.queryByTestId('pr-open-title-input')).toBeNull();
  });

  it('a gh_missing preview shows a distinct reason from gh_unauthenticated', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockResolvedValue({
        outcome: 'failure',
        category: 'gh_missing',
        reason: "gh CLI not found on this target's PATH",
      } satisfies PrOpenPreviewOutcome),
    });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain("isn't installed"),
    );
  });

  it('a gh_unauthenticated preview shows a distinct reason from gh_missing', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockResolvedValue({
        outcome: 'failure',
        category: 'gh_unauthenticated',
        reason: 'gh is not authenticated on this target',
      } satisfies PrOpenPreviewOutcome),
    });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain("isn't signed in"),
    );
  });

  it('the confirm button stays disabled until a title is typed, and never calls openPr before it is clicked', async () => {
    const client = fakeClient({ previewPrOpen: vi.fn().mockResolvedValue(OK_PREVIEW) });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    const confirmButton = (await screen.findByTestId('pr-open-confirm')) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(client.openPr).not.toHaveBeenCalled();

    const titleInput = screen.getByTestId('pr-open-title-input') as HTMLInputElement;
    await fireEvent.input(titleInput, { target: { value: 'Add widget' } });
    expect(confirmButton.disabled).toBe(false);
    expect(client.openPr).not.toHaveBeenCalled();
  });

  it('clicking confirm sends the typed title/body and shows the returned URL on success', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockResolvedValue(OK_PREVIEW),
      openPr: vi.fn().mockResolvedValue({
        outcome: 'ok',
        url: 'https://github.com/acme/widgets/pull/7',
        number: 7,
      } satisfies PrOpenOutcome),
    });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession({ id: 'sess-1' }), client, onClose: vi.fn() },
    });

    const titleInput = (await screen.findByTestId('pr-open-title-input')) as HTMLInputElement;
    await fireEvent.input(titleInput, { target: { value: 'Add widget' } });
    const bodyInput = screen.getByTestId('pr-open-body-input') as HTMLTextAreaElement;
    await fireEvent.input(bodyInput, { target: { value: 'Body text' } });
    await fireEvent.click(screen.getByTestId('pr-open-confirm'));

    await waitFor(() =>
      expect(client.openPr).toHaveBeenCalledWith('sess-1', {
        title: 'Add widget',
        body: 'Body text',
      }),
    );
    await waitFor(() => {
      const result = screen.getByTestId('pr-open-result-url');
      expect(result.textContent).toContain('https://github.com/acme/widgets/pull/7');
      expect(result.textContent).toContain('7');
    });
    // The form is replaced by the success view — a second click can't fire twice.
    expect(screen.queryByTestId('pr-open-confirm')).toBeNull();
  });

  it('Done, after a successful open, closes the dialog', async () => {
    const onClose = vi.fn();
    const client = fakeClient({ previewPrOpen: vi.fn().mockResolvedValue(OK_PREVIEW) });
    render(PrOpenDialog, { props: { open: true, session: makeSession(), client, onClose } });

    const titleInput = (await screen.findByTestId('pr-open-title-input')) as HTMLInputElement;
    await fireEvent.input(titleInput, { target: { value: 'Add widget' } });
    await fireEvent.click(screen.getByTestId('pr-open-confirm'));
    await screen.findByTestId('pr-open-done');

    await fireEvent.click(screen.getByTestId('pr-open-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes without opening anything', async () => {
    const onClose = vi.fn();
    const client = fakeClient({ previewPrOpen: vi.fn().mockResolvedValue(OK_PREVIEW) });
    render(PrOpenDialog, { props: { open: true, session: makeSession(), client, onClose } });

    await screen.findByTestId('pr-open-title-input');
    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.openPr).not.toHaveBeenCalled();
  });

  it('an open failure (e.g. push_failed) is shown distinctly and keeps the form so the operator can retry', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockResolvedValue(OK_PREVIEW),
      openPr: vi.fn().mockResolvedValue({
        outcome: 'failure',
        category: 'push_failed',
        reason: 'git push failed: permission denied',
      } satisfies PrOpenOutcome),
    });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    const titleInput = (await screen.findByTestId('pr-open-title-input')) as HTMLInputElement;
    await fireEvent.input(titleInput, { target: { value: 'Add widget' } });
    await fireEvent.click(screen.getByTestId('pr-open-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain(
        'Pushing the branch failed',
      ),
    );
    expect(screen.getByTestId('pr-open-confirm')).toBeTruthy();
    expect(screen.queryByTestId('pr-open-result-url')).toBeNull();
  });

  it('surfaces a preview transport failure through ErrorNotice rather than hanging or throwing', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });

  it('a preview request that times out reads as "This pull-request preview didn\'t answer in time...", never the raw wire message (issue #650)', async () => {
    const client = fakeClient({
      previewPrOpen: vi
        .fn()
        .mockRejectedValue(new Error('RelayClient: timed out waiting for pr_open_preview_result')),
    });
    render(PrOpenDialog, {
      props: { open: true, session: makeSession(), client, onClose: vi.fn() },
    });

    const notice = await waitFor(() => screen.getByTestId('ui-error-notice'));
    expect(notice.textContent).not.toContain('pr_open_preview_result');
    expect(notice.textContent).toContain("This pull-request preview didn't answer in time.");
    expect(screen.queryByTestId('pr-open-title-input')).toBeNull();
  });

  it('re-loads a fresh preview each time it re-opens for a (possibly different) session', async () => {
    const previewPrOpen = vi
      .fn()
      .mockResolvedValueOnce(OK_PREVIEW)
      .mockResolvedValueOnce({
        outcome: 'ok',
        branch: 'loombox/session-2',
        base: 'main',
        commitCount: 5,
      } satisfies PrOpenPreviewOutcome);
    const client = fakeClient({ previewPrOpen });

    const { rerender } = render(PrOpenDialog, {
      props: { open: true, session: makeSession({ id: 'sess-1' }), client, onClose: vi.fn() },
    });
    await waitFor(() => expect(previewPrOpen).toHaveBeenCalledWith('sess-1'));

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

    await waitFor(() => expect(previewPrOpen).toHaveBeenCalledWith('sess-2'));
    await waitFor(() =>
      expect(screen.getByTestId('pr-open-preview').textContent).toContain('loombox/session-2'),
    );
  });
});
