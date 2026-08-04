// @vitest-environment jsdom
import type { ConnectedAccount } from '@loombox/protocol';
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConnectedAccountPicker from './ConnectedAccountPicker.svelte';

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
    id: 'jira:myteam.atlassian.net:acc_1',
    provider: 'jira',
    host: 'myteam.atlassian.net',
    providerAccountId: 'acc_1',
    label: 'lorenzo@example.com',
    credentialSource: 'api_token',
    scopes: null,
    capabilities: ['issues', 'transitions'],
    connectedAt: 1,
    updatedAt: 1,
    secretRef: 'connected-account-token:jira:myteam.atlassian.net:acc_1',
    ...overrides,
  };
}

describe('ConnectedAccountPicker (issue #220)', () => {
  it('renders an EmptyState, not a dead dropdown, when no account is connected for the provider', () => {
    render(ConnectedAccountPicker, {
      props: { provider: 'github', accounts: [], value: undefined, onChange: vi.fn() },
    });
    expect(screen.getByTestId('ui-empty-state').textContent).toMatch(
      /no connected github account/i,
    );
    expect(screen.queryByTestId('connected-account-picker-select')).toBeNull();
  });

  it('filters to only the requested provider — a jira-only registry still empties out for github', () => {
    render(ConnectedAccountPicker, {
      props: { provider: 'github', accounts: [jiraAccount()], value: undefined, onChange: vi.fn() },
    });
    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
  });

  it('lists every connected account for the provider as a Select option', async () => {
    render(ConnectedAccountPicker, {
      props: {
        provider: 'github',
        accounts: [githubAccount(), jiraAccount()],
        value: undefined,
        onChange: vi.fn(),
      },
    });
    const trigger = screen.getByTestId('connected-account-picker-select-trigger');
    await fireEvent.click(trigger);
    expect(
      screen.getByTestId('connected-account-picker-select-option-github:github.com:1'),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(
        'connected-account-picker-select-option-jira:myteam.atlassian.net:acc_1',
      ),
    ).toBeNull();
  });

  it("calls onChange with the picked account's connectionId (its composed id)", async () => {
    const onChange = vi.fn();
    render(ConnectedAccountPicker, {
      props: {
        provider: 'github',
        accounts: [githubAccount(), githubAccount({ id: 'github:github.com:2', label: 'second' })],
        value: undefined,
        onChange,
      },
    });
    await fireEvent.click(screen.getByTestId('connected-account-picker-select-trigger'));
    await fireEvent.click(
      screen.getByTestId('connected-account-picker-select-option-github:github.com:2'),
    );
    expect(onChange).toHaveBeenCalledWith('github:github.com:2');
  });
});
