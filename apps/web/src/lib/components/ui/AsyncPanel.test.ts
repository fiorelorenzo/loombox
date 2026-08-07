// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsyncPanelState } from '$lib/async-panel';
import AsyncPanelComponent from './AsyncPanel.svelte';

afterEach(() => cleanup());

/** A TS instantiation expression (TS 4.7+): `AsyncPanel` is generic over its loaded data's type, and `render()` can only infer that type parameter from an already-instantiated reference, not from a bare generic import. */
const AsyncPanel = AsyncPanelComponent<{ label: string }>;

/** Echoes the loaded data onto the DOM so assertions can read it straight off the rendered element — mirrors `Field.test.ts`'s own parameterized-snippet pattern. */
function contentSnippet() {
  return createRawSnippet<[{ label: string }]>((getData) => ({
    render: () => `<p data-testid="async-panel-content">${getData().label}</p>`,
  }));
}

function baseProps(
  state: AsyncPanelState<{ label: string }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    state,
    loadingLabel: 'Loading',
    loadingTestId: 'panel-loading',
    content: contentSnippet(),
    ...overrides,
  };
}

describe('AsyncPanel (issue #650: one shared loading/error/empty primitive)', () => {
  it('renders only the loading branch while loading, with the given testid and aria label', () => {
    render(AsyncPanel, { props: baseProps({ status: 'loading' }) });
    const loading = screen.getByTestId('panel-loading');
    expect(loading.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading');
    expect(screen.queryByTestId('ui-error-notice')).toBeNull();
    expect(screen.queryByTestId('ui-empty-state')).toBeNull();
    expect(screen.queryByTestId('async-panel-content')).toBeNull();
  });

  it('shows loadingText beside the spinner only when provided', () => {
    const { unmount } = render(AsyncPanel, {
      props: baseProps({ status: 'loading' }, { loadingText: 'Loading spend history…' }),
    });
    expect(screen.getByTestId('panel-loading').textContent).toContain('Loading spend history…');
    unmount();

    render(AsyncPanel, { props: baseProps({ status: 'loading' }) });
    expect(screen.getByTestId('panel-loading').textContent?.trim()).toBe('');
  });

  it('renders only the error branch on error, wired to onRetry, and never the loading or empty branch', () => {
    const onRetry = vi.fn();
    render(AsyncPanel, {
      props: baseProps(
        {
          status: 'error',
          message: 'This folder didn' + "'" + 't answer in time.',
          retryable: true,
        },
        { onRetry },
      ),
    });
    const notice = screen.getByTestId('ui-error-notice');
    expect(notice.textContent).toContain("didn't answer in time.");
    expect(screen.queryByTestId('panel-loading')).toBeNull();
    expect(screen.queryByTestId('ui-empty-state')).toBeNull();
    expect(screen.queryByTestId('async-panel-content')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the Retry button when the error is not retryable', () => {
    render(AsyncPanel, {
      props: baseProps({ status: 'error', message: 'Failed to load this directory.' }),
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('wraps the error branch in a caller-supplied testid, and renders errorExtra above the message', () => {
    const extra = createRawSnippet(() => ({
      render: () => '<span data-testid="resolution-badge">Timed out</span>',
    }));
    render(AsyncPanel, {
      props: baseProps(
        { status: 'error', message: 'Failed to load the tracker.' },
        { errorTestId: 'tracker-snapshot-error', errorExtra: extra },
      ),
    });
    const wrapper = screen.getByTestId('tracker-snapshot-error');
    const badge = screen.getByTestId('resolution-badge');
    const notice = screen.getByTestId('ui-error-notice');
    expect(wrapper.contains(badge)).toBe(true);
    expect(wrapper.contains(notice)).toBe(true);
  });

  it('renders only the empty branch, never alongside the error branch', () => {
    render(AsyncPanel, {
      props: baseProps({ status: 'empty', message: 'No checkpoints yet.' }),
    });
    expect(screen.getByTestId('ui-empty-state').textContent).toContain('No checkpoints yet.');
    expect(screen.queryByTestId('ui-error-notice')).toBeNull();
    expect(screen.queryByTestId('panel-loading')).toBeNull();
    expect(screen.queryByTestId('async-panel-content')).toBeNull();
  });

  it("renders only the loaded branch's content snippet, given state.data", () => {
    render(AsyncPanel, {
      props: baseProps({ status: 'loaded', data: { label: 'three branches' } }),
    });
    expect(screen.getByTestId('async-panel-content').textContent).toBe('three branches');
    expect(screen.queryByTestId('ui-error-notice')).toBeNull();
    expect(screen.queryByTestId('ui-empty-state')).toBeNull();
    expect(screen.queryByTestId('panel-loading')).toBeNull();
  });

  it('a state cannot be both error and empty at once — the union has no such member, and only one branch ever renders for any given state', () => {
    // The type system already rules this out (AsyncPanelState is a
    // discriminated union keyed on a single `status`), but the deeper
    // guarantee this issue asks for is behavioral: every one of the four
    // possible `status` values renders exactly one branch and none of the
    // other three, for the exact same `state` object across a render.
    const states: AsyncPanelState<{ label: string }>[] = [
      { status: 'loading' },
      { status: 'error', message: 'boom', retryable: true },
      { status: 'empty', message: 'nothing yet' },
      { status: 'loaded', data: { label: 'x' } },
    ];
    const testids = ['panel-loading', 'ui-error-notice', 'ui-empty-state', 'async-panel-content'];
    for (const state of states) {
      const { unmount } = render(AsyncPanel, { props: baseProps(state) });
      const present = testids.filter((id) => screen.queryByTestId(id) !== null);
      expect(present).toHaveLength(1);
      unmount();
    }
  });
});
