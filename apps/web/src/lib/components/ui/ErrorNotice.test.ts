// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorNotice from './ErrorNotice.svelte';

afterEach(() => cleanup());

describe('ErrorNotice (issue #428 Warp Deck shared UI primitives)', () => {
  it('renders the message as an alert', () => {
    render(ErrorNotice, { props: { message: 'relay unreachable' } });
    const notice = screen.getByTestId('ui-error-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('relay unreachable');
  });

  it('renders no Retry button when not retryable (a fatal error)', () => {
    render(ErrorNotice, { props: { message: 'fatal: session gone' } });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a secondary Retry button when retryable and calls onRetry on click', async () => {
    const onRetry = vi.fn();
    render(ErrorNotice, { props: { message: 'relay unreachable', retryable: true, onRetry } });
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry.getAttribute('data-variant')).toBe('secondary');
    await fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
