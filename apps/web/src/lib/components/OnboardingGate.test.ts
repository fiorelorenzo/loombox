// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapAmkResult } from '$lib/relay-client';
import OnboardingGate from './OnboardingGate.svelte';

afterEach(() => cleanup());

const BASE_PROPS = {
  accountId: 'acct-1',
  relayUrl: 'wss://relay.test/ws',
  authToken: 'tok-1',
};

describe('OnboardingGate (issue #384)', () => {
  it('starts on the choice screen offering both paths', () => {
    render(OnboardingGate, {
      props: { ...BASE_PROPS, onFirstDevice: vi.fn(), onNewDevice: vi.fn() },
    });

    expect(screen.getByTestId('onboarding-choose-first-device')).toBeTruthy();
    expect(screen.getByTestId('onboarding-choose-new-device')).toBeTruthy();
  });

  it('first-device path: generates and displays a Recovery Code, gates continuing on the forced confirmation, then calls onFirstDevice with the generated AMK and that exact code', async () => {
    const onFirstDevice = vi.fn();
    render(OnboardingGate, {
      props: { ...BASE_PROPS, onFirstDevice, onNewDevice: vi.fn() },
    });

    await fireEvent.click(screen.getByTestId('onboarding-choose-first-device'));

    const displayedCode = screen.getByTestId('recovery-code-value').textContent;
    expect(displayedCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);

    const continueButton = screen.getByTestId('recovery-code-continue') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    await fireEvent.click(screen.getByTestId('recovery-code-confirm-checkbox'));
    expect(continueButton.disabled).toBe(false);
    await fireEvent.click(continueButton);

    expect(onFirstDevice).toHaveBeenCalledTimes(1);
    const [amk, code] = onFirstDevice.mock.calls[0] as [Uint8Array, string];
    expect(amk).toBeInstanceOf(Uint8Array);
    expect(amk.length).toBe(32);
    expect(code).toBe(displayedCode);
  });

  it('new-device path: submitting a Recovery Code calls the injected bootstrap function with the account/relay context, then onNewDevice on success', async () => {
    const result: BootstrapAmkResult = {
      amk: new Uint8Array(32).fill(7),
      deviceId: 'device-new-1',
      deviceKeyPair: undefined,
      devicePublicKey: 'pubkey-b64',
    };
    const bootstrapAmk = vi.fn().mockResolvedValue(result);
    const onNewDevice = vi.fn();
    render(OnboardingGate, {
      props: { ...BASE_PROPS, onFirstDevice: vi.fn(), onNewDevice, bootstrapAmk },
    });

    await fireEvent.click(screen.getByTestId('onboarding-choose-new-device'));
    await fireEvent.input(screen.getByTestId('recovery-code-input'), {
      target: { value: 'ABCD-EFGH-JKMN-PQRS' },
    });
    await fireEvent.click(screen.getByTestId('recovery-code-entry-submit'));

    await waitFor(() => expect(onNewDevice).toHaveBeenCalledWith(result));
    expect(bootstrapAmk).toHaveBeenCalledWith(
      expect.objectContaining({
        relayUrl: BASE_PROPS.relayUrl,
        accountId: BASE_PROPS.accountId,
        authToken: BASE_PROPS.authToken,
        recoveryCode: 'ABCD-EFGH-JKMN-PQRS',
      }),
    );
  });

  it('new-device path: surfaces a bootstrap failure and never calls onNewDevice', async () => {
    const bootstrapAmk = vi.fn().mockRejectedValue(new Error('wrong recovery code'));
    const onNewDevice = vi.fn();
    render(OnboardingGate, {
      props: { ...BASE_PROPS, onFirstDevice: vi.fn(), onNewDevice, bootstrapAmk },
    });

    await fireEvent.click(screen.getByTestId('onboarding-choose-new-device'));
    await fireEvent.input(screen.getByTestId('recovery-code-input'), {
      target: { value: 'WRONG-CODE' },
    });
    await fireEvent.click(screen.getByTestId('recovery-code-entry-submit'));

    await waitFor(() => expect(screen.getByText('wrong recovery code')).toBeTruthy());
    expect(onNewDevice).not.toHaveBeenCalled();
  });

  it('Back returns from either path to the choice screen', async () => {
    render(OnboardingGate, {
      props: { ...BASE_PROPS, onFirstDevice: vi.fn(), onNewDevice: vi.fn() },
    });

    await fireEvent.click(screen.getByTestId('onboarding-choose-new-device'));
    expect(screen.getByTestId('recovery-code-input')).toBeTruthy();
    await fireEvent.click(screen.getByText('Back'));
    expect(screen.getByTestId('onboarding-choose-first-device')).toBeTruthy();
  });
});
