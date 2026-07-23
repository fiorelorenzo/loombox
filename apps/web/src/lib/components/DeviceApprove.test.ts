// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceApprove from './DeviceApprove.svelte';

afterEach(() => cleanup());

describe('DeviceApprove (#387)', () => {
  it('pre-fills the user code from initialUserCode, and both buttons are enabled', () => {
    render(DeviceApprove, {
      props: { initialUserCode: 'WXYZ-2345', onApprove: vi.fn(), onDeny: vi.fn() },
    });

    const input = screen.getByTestId('device-user-code-input') as HTMLInputElement;
    expect(input.value).toBe('WXYZ-2345');
    expect((screen.getByTestId('device-approve-submit') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('device-deny-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables both buttons until a non-empty code is present', async () => {
    render(DeviceApprove, { props: { onApprove: vi.fn(), onDeny: vi.fn() } });

    const approve = screen.getByTestId('device-approve-submit') as HTMLButtonElement;
    const deny = screen.getByTestId('device-deny-submit') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    const input = screen.getByTestId('device-user-code-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'WXYZ-2345' } });
    expect(approve.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
  });

  it('calls onApprove with the typed code on submit', async () => {
    const onApprove = vi.fn();
    render(DeviceApprove, { props: { onApprove, onDeny: vi.fn() } });

    const input = screen.getByTestId('device-user-code-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'WXYZ-2345' } });
    await fireEvent.click(screen.getByTestId('device-approve-submit'));

    expect(onApprove).toHaveBeenCalledWith('WXYZ-2345');
  });

  it('calls onDeny with the typed code, not onApprove', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(DeviceApprove, { props: { onApprove, onDeny } });

    const input = screen.getByTestId('device-user-code-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'WXYZ-2345' } });
    await fireEvent.click(screen.getByTestId('device-deny-submit'));

    expect(onDeny).toHaveBeenCalledWith('WXYZ-2345');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('disables the input and both buttons, and shows a busy label, while busy', () => {
    render(DeviceApprove, {
      props: { initialUserCode: 'WXYZ-2345', onApprove: vi.fn(), onDeny: vi.fn(), busy: true },
    });

    expect((screen.getByTestId('device-user-code-input') as HTMLInputElement).disabled).toBe(true);
    const approve = screen.getByTestId('device-approve-submit') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toMatch(/linking/i);
    expect((screen.getByTestId('device-deny-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
  });

  it('surfaces an error message', () => {
    render(DeviceApprove, {
      props: {
        initialUserCode: 'WXYZ-2345',
        onApprove: vi.fn(),
        onDeny: vi.fn(),
        error: 'That code is invalid or has expired.',
      },
    });

    expect(screen.getByText('That code is invalid or has expired.')).toBeTruthy();
  });

  it('renders the approved outcome instead of the form once settled', () => {
    render(DeviceApprove, {
      props: { onApprove: vi.fn(), onDeny: vi.fn(), outcome: 'approved' },
    });

    expect(screen.getByTestId('device-approve-outcome-approved')).toBeTruthy();
    expect(screen.queryByTestId('device-user-code-input')).toBeNull();
  });

  it('renders the denied outcome instead of the form once settled', () => {
    render(DeviceApprove, {
      props: { onApprove: vi.fn(), onDeny: vi.fn(), outcome: 'denied' },
    });

    expect(screen.getByTestId('device-approve-outcome-denied')).toBeTruthy();
    expect(screen.queryByTestId('device-user-code-input')).toBeNull();
  });
});
