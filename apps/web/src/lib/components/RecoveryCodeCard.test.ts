// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecoveryCodeCard from './RecoveryCodeCard.svelte';

afterEach(() => cleanup());

const CODE = 'ABCD-EFGH-JKMN-PQRS';

describe('RecoveryCodeCard (issue #384)', () => {
  it('renders the code in monospace and a warning that it is the only recovery path', () => {
    render(RecoveryCodeCard, { props: { code: CODE, onConfirmed: vi.fn() } });

    expect(screen.getByTestId('recovery-code-value').textContent).toBe(CODE);
    expect(screen.getByRole('alert').textContent).toMatch(/only/i);
  });

  it('the Continue control is disabled until the confirmation checkbox is actively checked, then calls onConfirmed', async () => {
    const onConfirmed = vi.fn();
    render(RecoveryCodeCard, { props: { code: CODE, onConfirmed } });

    const continueButton = screen.getByTestId('recovery-code-continue') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    await fireEvent.click(continueButton);
    expect(onConfirmed).not.toHaveBeenCalled();

    const checkbox = screen.getByTestId('recovery-code-confirm-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await fireEvent.click(checkbox);
    expect(continueButton.disabled).toBe(false);

    await fireEvent.click(continueButton);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('copies the code via the injected copy function', async () => {
    const copyFn = vi.fn().mockResolvedValue(undefined);
    render(RecoveryCodeCard, { props: { code: CODE, onConfirmed: vi.fn(), copyFn } });

    await fireEvent.click(screen.getByTestId('recovery-code-copy'));
    expect(copyFn).toHaveBeenCalledWith(CODE);
  });

  it('disables Continue and shows the busy label while busy, and surfaces an error', async () => {
    render(RecoveryCodeCard, {
      props: { code: CODE, onConfirmed: vi.fn(), busy: true, error: 'escrow failed' },
    });

    const checkbox = screen.getByTestId('recovery-code-confirm-checkbox') as HTMLInputElement;
    await fireEvent.click(checkbox);

    const continueButton = screen.getByTestId('recovery-code-continue') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    expect(continueButton.textContent).toMatch(/securing/i);
    expect(screen.getByText('escrow failed')).toBeTruthy();
  });

  it('shows the woven-thread loading motif while busy (issue #274)', () => {
    render(RecoveryCodeCard, { props: { code: CODE, onConfirmed: vi.fn(), busy: true } });
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
  });
});
