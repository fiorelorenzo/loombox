// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAccount, JiraConnectOutcome } from '@loombox/protocol';
import JiraConnectForm, { type JiraConnectClient } from './JiraConnectForm.svelte';

afterEach(() => cleanup());

function account(siteUrl: string, accountId: string): ConnectedAccount {
  return {
    id: `jira:${siteUrl}:${accountId}`,
    provider: 'jira',
    host: siteUrl,
    providerAccountId: accountId,
    label: 'Lorenzo',
    credentialSource: 'api_token',
    scopes: null,
    capabilities: ['issues', 'comments'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: `connected-account-token:jira:${siteUrl}:${accountId}`,
  };
}

async function fillForm(siteUrl: string, email: string, apiToken: string): Promise<void> {
  await fireEvent.input(screen.getByTestId('jira-connect-site-url'), {
    target: { value: siteUrl },
  });
  await fireEvent.input(screen.getByTestId('jira-connect-email'), { target: { value: email } });
  await fireEvent.input(screen.getByTestId('jira-connect-api-token'), {
    target: { value: apiToken },
  });
}

describe('JiraConnectForm (SPEC §7.26, issue #230)', () => {
  it('submits the three fields and reports the connected account', async () => {
    const connectJiraAccount = vi.fn<JiraConnectClient['connectJiraAccount']>(async () => ({
      outcome: 'success',
      account: account('team-a.atlassian.net', 'acc-1'),
    }));
    const onConnected = vi.fn();
    render(JiraConnectForm, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: { connectJiraAccount },
        onClose: vi.fn(),
        onConnected,
      },
    });

    await fillForm('https://team-a.atlassian.net', 'lorenzo@example.com', 'tok-a');
    await fireEvent.click(screen.getByTestId('jira-connect-submit'));

    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(connectJiraAccount).toHaveBeenCalledWith('node_1', {
      siteUrl: 'https://team-a.atlassian.net',
      email: 'lorenzo@example.com',
      apiToken: 'tok-a',
    });
  });

  it('connecting a second Jira site in the same dialog session ADDS a second onConnected call rather than replacing the first — the dialog never auto-closes on success', async () => {
    const accounts = [
      account('team-a.atlassian.net', 'acc-1'),
      account('team-b.atlassian.net', 'acc-2'),
    ];
    let call = 0;
    const connectJiraAccount = vi.fn<JiraConnectClient['connectJiraAccount']>(async () => {
      const outcome: JiraConnectOutcome = { outcome: 'success', account: accounts[call] };
      call += 1;
      return outcome;
    });
    const onConnected = vi.fn();
    render(JiraConnectForm, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: { connectJiraAccount },
        onClose: vi.fn(),
        onConnected,
      },
    });

    // First site.
    await fillForm('https://team-a.atlassian.net', 'lorenzo@example.com', 'tok-a');
    await fireEvent.click(screen.getByTestId('jira-connect-submit'));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));

    // The dialog is still open, ready for a second site — not closed, not
    // showing a "done" state that would need to be re-opened.
    expect(screen.getByTestId('jira-connect-form')).toBeTruthy();

    // Second site, same dialog session.
    await fillForm('https://team-b.atlassian.net', 'lorenzo@example.com', 'tok-b');
    await fireEvent.click(screen.getByTestId('jira-connect-submit'));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2));

    // Both distinct accounts were reported — a second connect added a call,
    // it did not resend/replace the first.
    expect(onConnected).toHaveBeenNthCalledWith(1, accounts[0]);
    expect(onConnected).toHaveBeenNthCalledWith(2, accounts[1]);
    expect(connectJiraAccount).toHaveBeenCalledTimes(2);
  });

  it('shows the failure message and never calls onConnected on a bad connect', async () => {
    const connectJiraAccount = vi.fn<JiraConnectClient['connectJiraAccount']>(async () => ({
      outcome: 'failure',
      message: 'Invalid credentials.',
    }));
    const onConnected = vi.fn();
    render(JiraConnectForm, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: { connectJiraAccount },
        onClose: vi.fn(),
        onConnected,
      },
    });

    await fillForm('https://team-a.atlassian.net', 'lorenzo@example.com', 'bad-token');
    await fireEvent.click(screen.getByTestId('jira-connect-submit'));

    await waitFor(() => expect(screen.getByText('Invalid credentials.')).toBeTruthy());
    expect(onConnected).not.toHaveBeenCalled();
  });
});
