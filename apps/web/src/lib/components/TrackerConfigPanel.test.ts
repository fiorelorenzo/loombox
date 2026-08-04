// @vitest-environment jsdom
import type { ConnectedAccount, GithubConnectOutcome, TrackerMode } from '@loombox/protocol';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTrackerModeStorage } from '$lib/tracker-mode-store';
import TrackerConfigPanel from './TrackerConfigPanel.svelte';

// jsdom has no Web Animations API; `GithubConnectFlow`/`JiraConnectForm`'s
// (and `presentation="header"`'s own) `Dialog` calls `element.animate()`
// once opened reactively (see `TargetStatusView.test.ts`'s identical stub
// for why).
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      play: () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

afterEach(() => cleanup());

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'github:github.com:1',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo'],
    capabilities: ['repo', 'issues'],
    connectedAt: 1,
    updatedAt: 1,
    secretRef: 'connected-account-token:github:github.com:1',
    ...overrides,
  };
}

function jiraAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'jira:team.atlassian.net:acc-1',
    provider: 'jira',
    host: 'team.atlassian.net',
    providerAccountId: 'acc-1',
    label: 'Lorenzo',
    credentialSource: 'api_token',
    scopes: null,
    capabilities: ['issues', 'comments'],
    connectedAt: 1,
    updatedAt: 1,
    secretRef: 'connected-account-token:jira:team.atlassian.net:acc-1',
    ...overrides,
  };
}

describe('TrackerConfigPanel (issue #220)', () => {
  it('with no mode set yet, opens straight into the picker rather than any current-mode summary', () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    expect(screen.queryByTestId('tracker-mode-summary')).toBeNull();
    expect(screen.getByTestId('tracker-mode')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Tracking mode' })).toBeTruthy();
  });

  it('choosing native and saving persists {kind:"native"} to storage and survives a re-mount (reload)', async () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.click(screen.getByTestId('tracker-mode-native'));
    await fireEvent.click(screen.getByTestId('tracker-save'));

    expect(storage.get()).toEqual({ kind: 'native' });

    cleanup();
    render(TrackerConfigPanel, { props: { projectPath: '/tmp/project', storage } });
    expect(screen.getByTestId('tracker-mode-summary').textContent).toMatch(/native/i);
  });

  it("choosing live reveals the provider choice, then that provider's own target fields — github", async () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, {
      props: { projectPath: '/tmp/project', storage, connectedAccounts: [githubAccount()] },
    });

    expect(screen.queryByTestId('tracker-provider')).toBeNull();
    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    expect(screen.getByTestId('tracker-provider')).toBeTruthy();

    // github is the default provider once live is picked.
    expect(screen.getByTestId('tracker-owner')).toBeTruthy();
    expect(screen.getByTestId('tracker-repo')).toBeTruthy();
    expect(screen.getByTestId('tracker-project-number')).toBeTruthy();
    expect(screen.queryByTestId('tracker-cloud-id')).toBeNull();
    expect(screen.queryByTestId('tracker-project-key')).toBeNull();
  });

  it('switching provider to jira swaps the field set to cloudId/projectKey', async () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    await fireEvent.click(screen.getByTestId('tracker-provider-jira'));

    expect(screen.getByTestId('tracker-cloud-id')).toBeTruthy();
    expect(screen.getByTestId('tracker-project-key')).toBeTruthy();
    expect(screen.queryByTestId('tracker-owner')).toBeNull();
    expect(screen.queryByTestId('tracker-repo')).toBeNull();
  });

  it('no connected account for the chosen provider renders an EmptyState with a real way forward, not a dead dropdown', async () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, {
      props: { projectPath: '/tmp/project', storage, connectedAccounts: [] },
    });

    await fireEvent.click(screen.getByTestId('tracker-mode-live'));

    expect(screen.getByTestId('ui-empty-state').textContent).toMatch(
      /no connected github account/i,
    );
    const useNative = screen.getByTestId('tracker-use-native-instead');
    expect(useNative).toBeTruthy();

    await fireEvent.click(useNative);
    expect(screen.getByTestId('tracker-mode-native').getAttribute('aria-checked')).toBe('true');
  });

  it('rejects saving live mode with no account picked — a real error, not a silent no-op', async () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, {
      props: { projectPath: '/tmp/project', storage, connectedAccounts: [githubAccount()] },
    });

    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    await fireEvent.input(screen.getByTestId('tracker-owner'), { target: { value: 'loombox' } });
    await fireEvent.input(screen.getByTestId('tracker-repo'), { target: { value: 'loombox' } });
    await fireEvent.click(screen.getByTestId('tracker-save'));

    expect(screen.getByRole('alert').textContent).toMatch(/connected account/i);
    expect(storage.get()).toBeUndefined();
  });

  it('choosing live, an account, owner/repo saves a valid live TrackerMode and calls onChange', async () => {
    const storage = createInMemoryTrackerModeStorage();
    const onChange = vi.fn();
    render(TrackerConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        storage,
        connectedAccounts: [githubAccount()],
        onChange,
      },
    });

    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    await fireEvent.click(screen.getByTestId('tracker-connected-account-select-trigger'));
    await fireEvent.click(
      screen.getByTestId('tracker-connected-account-select-option-github:github.com:1'),
    );
    await fireEvent.input(screen.getByTestId('tracker-owner'), { target: { value: 'loombox' } });
    await fireEvent.input(screen.getByTestId('tracker-repo'), { target: { value: 'loombox' } });
    await fireEvent.click(screen.getByTestId('tracker-save'));

    const expected: TrackerMode = {
      kind: 'live',
      provider: 'github',
      connectionId: 'github:github.com:1',
      target: { owner: 'loombox', repo: 'loombox' },
    };
    expect(storage.get()).toEqual(expected);
    expect(onChange).toHaveBeenCalledWith(expected);
    expect(screen.getByTestId('tracker-mode-summary').textContent).toMatch(/loombox\/loombox/);
  });

  it('switching an already-saved mode requires an explicit "Change tracker mode" click — the form is not silently editable inline', async () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set({ kind: 'native' });
    render(TrackerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    expect(screen.getByTestId('tracker-mode-summary')).toBeTruthy();
    expect(screen.queryByTestId('tracker-mode')).toBeNull();

    await fireEvent.click(screen.getByTestId('tracker-change-mode'));
    expect(screen.getByTestId('tracker-mode')).toBeTruthy();
    // Reopens pre-selected on the current mode, not blank.
    expect(screen.getByTestId('tracker-mode-native').getAttribute('aria-checked')).toBe('true');
  });

  it('Cancel from the change-mode editor leaves the saved mode untouched', async () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set({ kind: 'native' });
    render(TrackerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.click(screen.getByTestId('tracker-change-mode'));
    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    await fireEvent.click(screen.getByTestId('tracker-cancel'));

    expect(screen.getByTestId('tracker-mode-summary')).toBeTruthy();
    expect(storage.get()).toEqual({ kind: 'native' });
  });

  it('the mode picker carries a real radiogroup role, not a toolbar/aria-pressed control', () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    const group = screen.getByTestId('tracker-mode');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(screen.getByTestId('tracker-mode-native').getAttribute('role')).toBe('radio');
  });

  it('presentation="header": a saved mode renders as a bare badge + button, no Card wrapper', () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set({ kind: 'native' });
    render(TrackerConfigPanel, {
      props: { projectPath: '/tmp/project', storage, presentation: 'header' },
    });

    expect(screen.getByTestId('tracker-mode-summary')).toBeTruthy();
    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(document.querySelector('.config-section')).toBeNull();
  });

  it('presentation="header": "Change tracker mode" opens the form inside a Dialog, not inline', async () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set({ kind: 'native' });
    render(TrackerConfigPanel, {
      props: { projectPath: '/tmp/project', storage, presentation: 'header' },
    });

    await fireEvent.click(screen.getByTestId('tracker-change-mode'));

    expect(screen.getByTestId('dialog')).toBeTruthy();
    expect(screen.getByTestId('tracker-mode')).toBeTruthy();
  });

  it('accountConnect: the empty-state CTA gets a real "Connect GitHub" button that opens GithubConnectFlow', async () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        storage,
        connectedAccounts: [],
        accountConnect: {
          nodeId: 'node-1',
          client: {
            startGithubConnect: vi.fn(() => ({
              requestId: 'req-1',
              cancel: () => {},
              result: Promise.withResolvers<GithubConnectOutcome>().promise,
            })),
            connectJiraAccount: vi.fn(),
          },
          refreshConnectedAccounts: vi.fn(),
        },
      },
    });

    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    expect(screen.getByTestId('tracker-connect-github')).toBeTruthy();
    // The pre-#672 escape hatch stays available alongside the real connect path.
    expect(screen.getByTestId('tracker-use-native-instead')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('tracker-connect-github'));
    expect(screen.getByTestId('dialog').textContent).toMatch(/connect a github account/i);
  });

  it('accountConnect: omitting the prop falls back to "use native instead" only, no connect button', async () => {
    const storage = createInMemoryTrackerModeStorage();
    render(TrackerConfigPanel, {
      props: { projectPath: '/tmp/project', storage, connectedAccounts: [] },
    });

    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    expect(screen.queryByTestId('tracker-connect-github')).toBeNull();
    expect(screen.getByTestId('tracker-use-native-instead')).toBeTruthy();
  });

  it('accountConnect: connecting a Jira account through the empty-state CTA auto-selects it and refreshes the caller', async () => {
    const storage = createInMemoryTrackerModeStorage();
    const refreshConnectedAccounts = vi.fn();
    const account = jiraAccount();
    const connectJiraAccount = vi.fn(async () => ({ outcome: 'success' as const, account }));
    render(TrackerConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        storage,
        connectedAccounts: [],
        accountConnect: {
          nodeId: 'node-1',
          client: { startGithubConnect: vi.fn(), connectJiraAccount },
          refreshConnectedAccounts,
        },
      },
    });

    await fireEvent.click(screen.getByTestId('tracker-mode-live'));
    await fireEvent.click(screen.getByTestId('tracker-provider-jira'));
    await fireEvent.click(screen.getByTestId('tracker-connect-jira'));

    await fireEvent.input(screen.getByTestId('jira-connect-site-url'), {
      target: { value: 'https://team.atlassian.net' },
    });
    await fireEvent.input(screen.getByTestId('jira-connect-email'), {
      target: { value: 'lorenzo@example.com' },
    });
    await fireEvent.input(screen.getByTestId('jira-connect-api-token'), {
      target: { value: 'tok' },
    });
    await fireEvent.click(screen.getByTestId('jira-connect-submit'));

    await waitFor(() => expect(refreshConnectedAccounts).toHaveBeenCalledOnce());
  });
});
