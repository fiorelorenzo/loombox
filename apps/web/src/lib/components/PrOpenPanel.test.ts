// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrOpenOutcome, PrOpenPreviewOutcome } from '@loombox/protocol';
import PrOpenPanel, { type PrOpenClient } from './PrOpenPanel.svelte';

afterEach(() => cleanup());

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

describe('PrOpenPanel (SPEC §7.14; issue #238)', () => {
  it('shows an empty state instead of fetching anything when there is no active session', () => {
    const client = fakeClient();
    render(PrOpenPanel, { props: { client } });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(client.previewPrOpen).not.toHaveBeenCalled();
  });

  it('loads a preview automatically for the active session — no side effect, never calls openPr', async () => {
    const client = fakeClient();
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

    await waitFor(() => expect(client.previewPrOpen).toHaveBeenCalledWith('sess-1'));
    await waitFor(() =>
      expect(screen.getByTestId('pr-open-preview').textContent).toContain('loombox/session-1'),
    );
    expect(screen.getByTestId('pr-open-preview').textContent).toContain('main');
    expect(screen.getByTestId('pr-open-preview').textContent).toContain('2');
    expect(client.openPr).not.toHaveBeenCalled();
  });

  it('a no_commits preview shows a distinct, visible reason instead of the title/body form', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockResolvedValue({
        outcome: 'failure',
        category: 'no_commits',
        reason: '"loombox/session-1" has no commits ahead of "main"',
      } satisfies PrOpenPreviewOutcome),
    });
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

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
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

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
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain("isn't signed in"),
    );
  });

  it('the confirm button stays disabled until a title is typed, and never calls openPr before it is clicked', async () => {
    const client = fakeClient({ previewPrOpen: vi.fn().mockResolvedValue(OK_PREVIEW) });
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

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
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

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

  it('an open failure (e.g. push_failed) is shown distinctly and keeps the form so the operator can retry', async () => {
    const client = fakeClient({
      previewPrOpen: vi.fn().mockResolvedValue(OK_PREVIEW),
      openPr: vi.fn().mockResolvedValue({
        outcome: 'failure',
        category: 'push_failed',
        reason: 'git push failed: permission denied',
      } satisfies PrOpenOutcome),
    });
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

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
    render(PrOpenPanel, { props: { sessionId: 'sess-1', client } });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });
});
