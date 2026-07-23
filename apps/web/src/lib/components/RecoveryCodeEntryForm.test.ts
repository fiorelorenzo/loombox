// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecoveryCodeEntryForm from './RecoveryCodeEntryForm.svelte';

afterEach(() => cleanup());

describe('RecoveryCodeEntryForm', () => {
  it('the submit button is disabled until a non-empty code is typed, then calls onSubmit with it', async () => {
    const onSubmit = vi.fn();
    render(RecoveryCodeEntryForm, { props: { onSubmit } });

    const submit = screen.getByTestId('recovery-code-entry-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = screen.getByTestId('recovery-code-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'ABCD-EFGH-JKMN-PQRS' } });
    expect(submit.disabled).toBe(false);

    await fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('ABCD-EFGH-JKMN-PQRS');
  });

  it('does not submit whitespace-only input', async () => {
    const onSubmit = vi.fn();
    render(RecoveryCodeEntryForm, { props: { onSubmit } });

    const input = screen.getByTestId('recovery-code-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '   ' } });

    const submit = screen.getByTestId('recovery-code-entry-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('shows the busy label and disables input/submit while busy, and surfaces an error', () => {
    render(RecoveryCodeEntryForm, {
      props: { onSubmit: vi.fn(), busy: true, error: 'wrong code' },
    });

    const input = screen.getByTestId('recovery-code-input') as HTMLInputElement;
    const submit = screen.getByTestId('recovery-code-entry-submit') as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toMatch(/verifying/i);
    expect(screen.getByText('wrong code')).toBeTruthy();
  });

  it('shows the woven-thread loading motif while busy (issue #274)', () => {
    render(RecoveryCodeEntryForm, { props: { onSubmit: vi.fn(), busy: true } });
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
  });
});
