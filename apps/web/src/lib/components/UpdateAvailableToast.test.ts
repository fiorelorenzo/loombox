// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UpdateAvailableToast from './UpdateAvailableToast.svelte';

afterEach(() => cleanup());

describe('UpdateAvailableToast (issue #657)', () => {
  it('tells the user a new version is ready', () => {
    render(UpdateAvailableToast, { props: { onReload: vi.fn(), onDismiss: vi.fn() } });
    const toast = screen.getByTestId('update-available-toast');
    expect(toast.textContent).toContain('new version');
  });

  it('clicking Reload calls onReload, never fires on its own', async () => {
    const onReload = vi.fn();
    render(UpdateAvailableToast, { props: { onReload, onDismiss: vi.fn() } });
    expect(onReload).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId('update-toast-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('clicking Dismiss calls onDismiss, not onReload', async () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    render(UpdateAvailableToast, { props: { onReload, onDismiss } });
    await fireEvent.click(screen.getByTestId('update-toast-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });
});
