// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryNotificationPreferencesStorage } from '$lib/notification-preferences';
import type {
  DecommissionTargetResponse,
  NodeSelfUpdateApplyResponse,
  ProvisionTargetResult,
  TargetListEntry,
  TargetUpdateResponse,
} from '$lib/relay-client';
import type { ConnectedAccountsClient } from '../ConnectedAccountsSection.svelte';
import type { KeymapClient } from '../KeymapPanel.svelte';
import type { TargetActionsClient } from '../TargetStatusView.svelte';
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
    concurrency: new Map(),
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

  it('shows the served build version (issue #865) so a human can tell what commit this is without SSHing to the box', () => {
    render(SettingsPage, { props: baseProps() });

    const buildLine = screen.getByTestId('web-build-version');
    expect(buildLine.textContent?.trim()).toMatch(/^Build \S+$/);
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

  it(
    'forwards `client` into TargetStatusView so Reconnect/Update/Remove/Edit and Update node are ' +
      'actually reachable here (issue #862: this mount site used to drop the prop, so those four ' +
      "actions never rendered no matter what TargetStatusView's own tests proved)",
    async () => {
      render(SettingsPage, {
        props: { ...baseProps(), section: 'nodes' as const, client: fakeAccountsClient() },
      });

      await fireEvent.click(screen.getByTestId('target-row-toggle-node_1:local'));

      expect(screen.getByTestId('target-actions')).toBeTruthy();
      expect(screen.getByTestId('target-action-reconnect-node_1:local')).toBeTruthy();
    },
  );

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

  // -----------------------------------------------------------------
  // Accounts section (SPEC §7.26, issue #230): gated on `client` like
  // Push is gated on `deviceId` — no client means no in-app way to drive
  // a connect/disconnect/pin operation, so the section stays hidden
  // rather than rendering dead controls.
  // -----------------------------------------------------------------

  /** Satisfies `TargetStatusView`'s `TargetActionsClient` alongside `ConnectedAccountsClient`/`KeymapClient` (issues #476/#656) — `SettingsPage`'s `client` prop is one real `RelayClient` widened over all three narrowed interfaces (its own doc comment explains why), so this single fake stands in for it everywhere a test needs "a client exists", nodes-section actions included. */
  function fakeAccountsClient(): ConnectedAccountsClient & KeymapClient & TargetActionsClient {
    return {
      startGithubConnect: vi.fn(() => ({
        requestId: 'r',
        cancel: vi.fn(),
        result: Promise.withResolvers<never>().promise,
      })),
      connectJiraAccount: vi.fn(),
      scanAccountPins: vi.fn(async () => []),
      disconnectAccount: vi.fn(),
      getAccountPins: vi.fn(async () => ({})),
      setAccountPin: vi.fn(),
      unsetAccountPin: vi.fn(),
      resolveAccountPin: vi.fn(),
      refreshConnectedAccounts: vi.fn(),
      setKeymap: vi.fn(async (candidate: Record<string, string>) => candidate),
      listTargets: vi.fn().mockResolvedValue(TARGETS),
      provisionTarget: vi.fn().mockResolvedValue({
        type: 'provision_target_result',
        protocolVersion: 1,
        requestId: 'req-3',
        nodeId: 'node_1',
        targetId: 'ssh:devbox-replacement',
        ok: true,
        message: 'paired',
      } satisfies ProvisionTargetResult),
      discoverSshHosts: vi.fn().mockResolvedValue({
        outcome: 'ok',
        candidates: [],
        agent: { available: false, identities: [] },
        requiresManualEntry: true,
      }),
      decommissionTarget: vi.fn().mockResolvedValue({
        type: 'decommission_target_response',
        protocolVersion: 1,
        requestId: 'req-1',
        nodeId: 'node_1',
        targetId: 'local',
        ok: true,
        result: {
          unitWasInstalled: true,
          unitStopped: true,
          unitDisabled: true,
          deviceKeyRevoked: true,
          filesRemoved: false,
        },
        message: 'decommissioned "local"',
      } satisfies DecommissionTargetResponse),
      updateTarget: vi.fn().mockResolvedValue({
        type: 'target_update_response',
        protocolVersion: 1,
        requestId: 'req-2',
        nodeId: 'node_1',
        targetId: 'local',
        ok: true,
        status: 'current',
        remoteVersion: '2.0.0',
        installedVersion: '2.0.0',
        message: '"local" is now at 2.0.0',
      } satisfies TargetUpdateResponse),
      applyNodeSelfUpdate: vi.fn().mockResolvedValue({
        type: 'node_self_update_apply_response',
        protocolVersion: 1,
        requestId: 'req-4',
        nodeId: 'node_1',
        ok: true,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        message: 'updated 1.0.0 -> 2.0.0; restarting to apply',
      } satisfies NodeSelfUpdateApplyResponse),
    };
  }

  it('offers no Accounts section at all, in either nav, without a client', () => {
    render(SettingsPage, { props: baseProps() });
    expect(screen.queryByTestId('settings-nav-accounts')).toBeNull();
    expect(screen.queryByTestId('settings-tab-accounts')).toBeNull();
  });

  it('lists Accounts in both navs once a client is passed', () => {
    render(SettingsPage, { props: { ...baseProps(), client: fakeAccountsClient() } });
    expect(screen.getByTestId('settings-nav-accounts')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-accounts')).toBeTruthy();
  });

  it("renders the Accounts section as this page's own ConnectedAccountsSection once selected", () => {
    render(SettingsPage, {
      props: {
        ...baseProps(),
        client: fakeAccountsClient(),
        section: 'accounts' as const,
      },
    });
    expect(screen.getByRole('heading', { name: 'Connected accounts', level: 2 })).toBeTruthy();
    expect(screen.getByTestId('connected-accounts-section')).toBeTruthy();
  });

  it('falls back to Appearance when accounts is requested but no client is passed', () => {
    render(SettingsPage, { props: { ...baseProps(), section: 'accounts' as const } });
    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeTruthy();
    expect(screen.queryByTestId('connected-accounts-section')).toBeNull();
  });

  // -----------------------------------------------------------------
  // Keyboard section (Zed-parity F3-3, issue #760): gated on `client`
  // like Accounts, PLUS never offered at all on a narrow viewport — the
  // issue's own "the phone" answer, implemented here (not merely
  // documented): recording a chord has nothing to attach to with no
  // physical keyboard to press.
  // -----------------------------------------------------------------

  function stubMatchMedia(narrow: boolean): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: narrow,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  it('offers no Keyboard section at all, in either nav, without a client (even on a wide viewport)', () => {
    stubMatchMedia(false);
    render(SettingsPage, { props: baseProps() });
    expect(screen.queryByTestId('settings-nav-keyboard')).toBeNull();
    expect(screen.queryByTestId('settings-tab-keyboard')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('lists Keyboard in both navs on a wide viewport once a client is passed', () => {
    stubMatchMedia(false);
    render(SettingsPage, { props: { ...baseProps(), client: fakeAccountsClient() } });
    expect(screen.getByTestId('settings-nav-keyboard')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-keyboard')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("issue #760's mobile answer, implemented: a narrow viewport never offers Keyboard, even with a client", () => {
    stubMatchMedia(true);
    render(SettingsPage, { props: { ...baseProps(), client: fakeAccountsClient() } });
    expect(screen.queryByTestId('settings-nav-keyboard')).toBeNull();
    expect(screen.queryByTestId('settings-tab-keyboard')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('renders KeymapPanel, reading the live action registry, once the Keyboard section is selected', () => {
    stubMatchMedia(false);
    render(SettingsPage, {
      props: {
        ...baseProps(),
        client: fakeAccountsClient(),
        keymap: { 'stop-turn': 'Mod+Shift+X' },
        section: 'keyboard' as const,
      },
    });
    expect(screen.getByTestId('settings-section-keyboard')).toBeTruthy();
    expect(screen.getByTestId('keymap-panel')).toBeTruthy();
    expect(screen.getByTestId('keymap-row-stop-turn').textContent).toContain('Mod+Shift+X');
    vi.unstubAllGlobals();
  });
});
