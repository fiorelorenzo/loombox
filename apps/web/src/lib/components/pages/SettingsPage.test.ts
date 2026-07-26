// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryNotificationPreferencesStorage } from '$lib/notification-preferences';
import SettingsPage from './SettingsPage.svelte';

afterEach(() => cleanup());

describe('SettingsPage (design spec v4 §3.3, issue #507)', () => {
  it('renders a real page title and the Appearance panel it always wraps', () => {
    render(SettingsPage, {
      props: {
        notificationPreferencesStorage: undefined,
        projectPaths: [],
        onNotificationPreferencesChange: vi.fn(),
        deviceId: undefined,
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
      },
    });

    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();
    // Theme radios are AppearanceSettings' own, load-bearing test hook.
    expect(screen.getByTestId('theme-option-system')).toBeTruthy();
  });

  it('has no close button: a page is left by navigating elsewhere, not by dismissing it', () => {
    render(SettingsPage, {
      props: {
        notificationPreferencesStorage: undefined,
        projectPaths: [],
        onNotificationPreferencesChange: vi.fn(),
        deviceId: undefined,
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
      },
    });

    expect(screen.queryByTestId('drawer-close')).toBeNull();
    expect(screen.queryByRole('button', { name: /^close/i })).toBeNull();
  });

  it('wraps Notifications only once its storage is ready, mirroring the old Drawer tab guard', () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    render(SettingsPage, {
      props: {
        notificationPreferencesStorage: storage,
        projectPaths: ['/repo/a'],
        onNotificationPreferencesChange: vi.fn(),
        deviceId: undefined,
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
      },
    });

    expect(screen.getByText('Notifications')).toBeTruthy();
    expect(screen.getByTestId('mute-project-/repo/a')).toBeTruthy();
  });

  it('wraps Push notifications only once a device id exists, mirroring the old Drawer tab guard', () => {
    render(SettingsPage, {
      props: {
        notificationPreferencesStorage: undefined,
        projectPaths: [],
        onNotificationPreferencesChange: vi.fn(),
        deviceId: 'dev_1',
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
      },
    });

    expect(screen.getByText('Push notifications')).toBeTruthy();
  });

  it('reads as a complete page, not a blank rectangle, before either optional section is ready', () => {
    render(SettingsPage, {
      props: {
        notificationPreferencesStorage: undefined,
        projectPaths: [],
        onNotificationPreferencesChange: vi.fn(),
        deviceId: undefined,
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
      },
    });

    expect(screen.queryByText('Notifications')).toBeNull();
    expect(screen.queryByText('Push notifications')).toBeNull();
    expect(screen.getByText('Appearance')).toBeTruthy();
  });
});
