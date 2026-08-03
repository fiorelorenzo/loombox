// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryNotificationPreferencesStorage } from '$lib/notification-preferences';
import type { TargetListEntry } from '$lib/relay-client';
import SettingsPage from './SettingsPage.svelte';

afterEach(() => cleanup());

const TARGETS: TargetListEntry[] = [
  {
    nodeId: 'node_1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local',
    providers: ['claude'],
    reachable: true,
  },
];

const noop = () => {};

/** Every prop `SettingsPage` now requires, individual tests only override what they care about (issue #568 grew this from the original three-prop Appearance/Notifications/Push set to include the merged-in Nodes section's own former `NodesPage` props). */
function baseProps() {
  return {
    notificationPreferencesStorage: undefined,
    projectPaths: [],
    onNotificationPreferencesChange: vi.fn(),
    deviceId: undefined,
    relayBaseUrl: 'http://relay.test',
    authToken: 'tok',
    targets: TARGETS,
    loading: false,
    error: undefined,
    onRefresh: noop,
    onAddTarget: noop,
    onConnectNode: noop,
  };
}

describe('SettingsPage (design spec v4 §3.3, issue #507; reorganised by issue #568)', () => {
  it('renders a real page title and the Appearance panel by default', () => {
    render(SettingsPage, { props: baseProps() });

    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeTruthy();
    // Theme radios are AppearanceSettings' own, load-bearing test hook.
    expect(screen.getByTestId('theme-option-system')).toBeTruthy();
  });

  it('has no close button: a page is left by navigating elsewhere, not by dismissing it', () => {
    render(SettingsPage, { props: baseProps() });

    expect(screen.queryByTestId('drawer-close')).toBeNull();
    expect(screen.queryByRole('button', { name: /^close/i })).toBeNull();
  });

  it('wraps Notifications only once its storage is ready, mirroring the old Drawer tab guard', () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    render(SettingsPage, {
      props: {
        ...baseProps(),
        notificationPreferencesStorage: storage,
        projectPaths: ['/repo/a'],
        section: 'notifications' as const,
      },
    });

    expect(screen.getByRole('heading', { name: 'Notifications', level: 2 })).toBeTruthy();
    expect(screen.getByTestId('mute-project-/repo/a')).toBeTruthy();
    expect(screen.queryByTestId('settings-nav-notifications')).toBeTruthy();
  });

  it('offers no Notifications section at all, in either nav, before storage is ready', () => {
    render(SettingsPage, { props: baseProps() });

    expect(screen.queryByTestId('settings-nav-notifications')).toBeNull();
    expect(screen.queryByTestId('settings-tab-notifications')).toBeNull();
  });

  it('wraps Push notifications only once a device id exists, mirroring the old Drawer tab guard', () => {
    render(SettingsPage, {
      props: { ...baseProps(), deviceId: 'dev_1', section: 'push' as const },
    });

    expect(screen.getByText('Push notifications')).toBeTruthy();
  });

  it('offers no Push section at all, in either nav, before a device id exists', () => {
    render(SettingsPage, { props: baseProps() });

    expect(screen.queryByTestId('settings-nav-push')).toBeNull();
    expect(screen.queryByTestId('settings-tab-push')).toBeNull();
  });

  it('reads as a complete page, not a blank rectangle, before either optional section is ready', () => {
    render(SettingsPage, { props: baseProps() });

    expect(screen.queryByText('Notifications')).toBeNull();
    expect(screen.queryByText('Push notifications')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeTruthy();
  });

  it('wraps Push notifications in a card, matching Appearance and Notifications above it (design spec §0.8)', () => {
    render(SettingsPage, {
      props: { ...baseProps(), deviceId: 'dev_1', section: 'push' as const },
    });

    const pushToggle = screen.getByTestId('push-toggle');
    expect(pushToggle.closest('[data-testid="ui-card"]')).not.toBeNull();
  });

  it("gives the section heading a visibly different treatment than a card's own field caption, not just a different position on the page (design spec §0.8)", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'SettingsPage.svelte'),
      'utf8',
    );
    const styleBlock = source.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '';
    const headingRule = styleBlock.match(/\.settings-section h2\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(headingRule).not.toMatch(/text-transform:\s*uppercase/);
    expect(headingRule).not.toContain('var(--text-caption-size)');
    expect(headingRule).not.toContain('var(--text-small-size)');
  });

  // -----------------------------------------------------------------
  // Section navigation (issue #568): Settings outgrew a flat `<h2>`
  // stack once Nodes moved in, so it needs real navigation between its
  // four sections rather than one long scroll.
  // -----------------------------------------------------------------

  it('lists every section that has its prerequisites, in the desktop sub-nav and the narrow segmented control alike', () => {
    render(SettingsPage, {
      props: {
        ...baseProps(),
        notificationPreferencesStorage: createInMemoryNotificationPreferencesStorage(),
        deviceId: 'dev_1',
      },
    });

    for (const id of ['appearance', 'notifications', 'push', 'nodes']) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeTruthy();
      expect(screen.getByTestId(`settings-tab-${id}`)).toBeTruthy();
    }
  });

  it('a sub-nav click reports the new section rather than switching silently, and only ever shows one section at a time', async () => {
    const onSectionChange = vi.fn();
    render(SettingsPage, { props: { ...baseProps(), onSectionChange } });

    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeTruthy();
    expect(screen.queryByTestId('settings-section-nodes')).toBeNull();

    await fireEvent.click(screen.getByTestId('settings-nav-nodes'));

    expect(onSectionChange).toHaveBeenCalledExactlyOnceWith('nodes');
  });

  it("renders the Nodes section as this page's own TargetStatusView, actions included, once selected", () => {
    render(SettingsPage, { props: { ...baseProps(), section: 'nodes' as const } });

    expect(screen.getByRole('heading', { name: 'Nodes and targets', level: 2 })).toBeTruthy();
    expect(screen.getByTestId('target-status-view')).toBeTruthy();
    expect(screen.getByText('This machine')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Appearance', level: 2 })).toBeNull();
  });

  it("wires the Nodes section's own setup actions through to the callbacks passed in", async () => {
    const onAddTarget = vi.fn();
    const onConnectNode = vi.fn();
    render(SettingsPage, {
      props: { ...baseProps(), section: 'nodes' as const, onAddTarget, onConnectNode },
    });

    await fireEvent.click(screen.getByTestId('nodes-page-add-target'));
    expect(onAddTarget).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByTestId('nodes-page-connect-node'));
    expect(onConnectNode).toHaveBeenCalledOnce();
  });

  it('highlights the focused target passed in from a deep link', () => {
    render(SettingsPage, {
      props: {
        ...baseProps(),
        section: 'nodes' as const,
        focusTarget: { nodeId: 'node_1', targetId: 'local' },
      },
    });

    const row = screen.getByTestId('target-status-row-node_1:local');
    expect(row.className).toContain('focused');
  });

  it('falls back to Appearance if the requested section has no prerequisite, rather than rendering blank', () => {
    // `section: 'push'` with no `deviceId` — the section the caller asked
    // for doesn't exist right now.
    render(SettingsPage, { props: { ...baseProps(), section: 'push' as const } });

    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeTruthy();
    expect(screen.queryByText('Push notifications')).toBeNull();
  });
});
