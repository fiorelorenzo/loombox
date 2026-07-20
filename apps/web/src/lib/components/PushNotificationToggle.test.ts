// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PushNotificationToggle from './PushNotificationToggle.svelte';

afterEach(() => cleanup());

describe('PushNotificationToggle (#162)', () => {
  it('renders nothing actionable, and never calls subscribeFn, when the browser is unsupported', () => {
    const subscribeFn = vi.fn();
    render(PushNotificationToggle, {
      props: {
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
        deviceId: 'dev_1',
        subscribeFn,
        supportStateFn: () => 'unsupported',
      },
    });

    expect(screen.getByTestId('push-unsupported')).toBeTruthy();
    expect(screen.queryByTestId('push-enable')).toBeFalsy();
    expect(subscribeFn).not.toHaveBeenCalled();
  });

  it('shows a blocked message, with no button, when permission was already denied', () => {
    render(PushNotificationToggle, {
      props: {
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
        deviceId: 'dev_1',
        supportStateFn: () => 'denied',
      },
    });

    expect(screen.getByTestId('push-denied')).toBeTruthy();
    expect(screen.queryByTestId('push-enable')).toBeFalsy();
  });

  it('never prompts on mount (not called until the button is clicked) — only a user click ever calls subscribeFn', () => {
    const subscribeFn = vi.fn().mockResolvedValue({ status: 'subscribed' });
    render(PushNotificationToggle, {
      props: {
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
        deviceId: 'dev_1',
        subscribeFn,
        supportStateFn: () => 'default',
      },
    });

    expect(screen.getByTestId('push-enable')).toBeTruthy();
    expect(subscribeFn).not.toHaveBeenCalled();
  });

  it('clicking Enable calls subscribeFn with the relay/auth/device props and shows "Notifications on" on success', async () => {
    const subscribeFn = vi.fn().mockResolvedValue({ status: 'subscribed' });
    render(PushNotificationToggle, {
      props: {
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok-abc',
        deviceId: 'dev_xyz',
        subscribeFn,
        supportStateFn: () => 'default',
      },
    });

    await fireEvent.click(screen.getByTestId('push-enable'));

    expect(subscribeFn).toHaveBeenCalledWith({
      relayBaseUrl: 'http://relay.test',
      authToken: 'tok-abc',
      deviceId: 'dev_xyz',
    });
    await waitFor(() => expect(screen.getByTestId('push-granted')).toBeTruthy());
  });

  it('shows the blocked message after the user denies the permission prompt', async () => {
    const subscribeFn = vi.fn().mockResolvedValue({ status: 'permission-denied' });
    render(PushNotificationToggle, {
      props: {
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
        deviceId: 'dev_1',
        subscribeFn,
        supportStateFn: () => 'default',
      },
    });

    await fireEvent.click(screen.getByTestId('push-enable'));
    await waitFor(() => expect(screen.getByTestId('push-denied')).toBeTruthy());
  });

  it('shows an error message, without crashing, if subscribeFn rejects', async () => {
    const subscribeFn = vi.fn().mockRejectedValue(new Error('network is down'));
    render(PushNotificationToggle, {
      props: {
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
        deviceId: 'dev_1',
        subscribeFn,
        supportStateFn: () => 'default',
      },
    });

    await fireEvent.click(screen.getByTestId('push-enable'));
    await waitFor(() =>
      expect(screen.getByTestId('push-error').textContent).toContain('network is down'),
    );
  });
});
