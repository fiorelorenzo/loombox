// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAccount } from '@loombox/protocol';
import ConnectedAccountsList, {
  type DisconnectAccountsClient,
} from './ConnectedAccountsList.svelte';

afterEach(() => cleanup());

// A distinctive marker standing in for "the keyring holds a real token" —
// `ConnectedAccount` structurally never carries a token field, so the real
// risk this guards is `secretRef` (a keyring key NAME, not a secret)
// getting rendered as though it meant something to a person. If this
// literal string ever showed up in the DOM, that would be exactly the bug
// this issue's acceptance calls out.
const FAKE_TOKEN_MARKER = 'ghp_totally-secret-token-should-never-render-9f3a';

const ACCOUNT: ConnectedAccount = {
  id: 'github:github.com:12345',
  provider: 'github',
  host: 'github.com',
  providerAccountId: '12345',
  label: 'lorenzo',
  avatarUrl: 'https://avatars.example/lorenzo.png',
  credentialSource: 'device_flow',
  scopes: ['repo', 'read:user'],
  capabilities: ['issues', 'comments'],
  connectedAt: Date.UTC(2026, 6, 1, 12, 0, 0),
  updatedAt: Date.UTC(2026, 6, 2, 9, 0, 0),
  secretRef: `connected-account-token:github:github.com:12345:${FAKE_TOKEN_MARKER}`,
};

function noopClient(overrides: Partial<DisconnectAccountsClient> = {}): DisconnectAccountsClient {
  return {
    disconnectAccount: vi.fn(),
    refreshConnectedAccounts: vi.fn(),
    ...overrides,
  };
}

describe('ConnectedAccountsList (SPEC §7.26, issue #230)', () => {
  it('shows a real EmptyState pointing at the connect actions when there are no accounts', () => {
    render(ConnectedAccountsList, {
      props: { accounts: [], client: noopClient(), nodeId: 'node_1' },
    });
    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(screen.queryByText('No accounts')).toBeNull();
  });

  it('renders label, host, provider, and capabilities from the real fields only', () => {
    render(ConnectedAccountsList, {
      props: { accounts: [ACCOUNT], client: noopClient(), nodeId: 'node_1' },
    });
    expect(screen.getByText('lorenzo')).toBeTruthy();
    expect(screen.getByText('github.com')).toBeTruthy();
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByText('issues')).toBeTruthy();
    expect(screen.getByText('comments')).toBeTruthy();
  });

  it('never renders secretRef or anything that looks like a real token, anywhere in the DOM', () => {
    const { container } = render(ConnectedAccountsList, {
      props: { accounts: [ACCOUNT], client: noopClient(), nodeId: 'node_1' },
    });
    expect(container.textContent).not.toContain(FAKE_TOKEN_MARKER);
    expect(container.textContent).not.toContain(ACCOUNT.secretRef);
    expect(container.innerHTML).not.toContain(FAKE_TOKEN_MARKER);
  });

  it('expanding a row and starting Disconnect shows a confirm bar naming what it may affect, not an immediate disconnect', async () => {
    const disconnectAccount = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({ disconnectAccount }),
        nodeId: 'node_1',
      },
    });

    await fireEvent.click(screen.getByTestId(`connected-account-row-${ACCOUNT.id}`));
    await fireEvent.click(screen.getByTestId(`disconnect-start-${ACCOUNT.id}`));

    expect(screen.getByTestId(`disconnect-confirmbar-${ACCOUNT.id}`).textContent).toContain(
      'pinned',
    );
    expect(disconnectAccount).not.toHaveBeenCalled();
  });

  it('confirming Disconnect calls disconnectAccount with the acting node and refreshes the list', async () => {
    const disconnectAccount = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', message: 'Disconnected.' });
    const refreshConnectedAccounts = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({ disconnectAccount, refreshConnectedAccounts }),
        nodeId: 'node_1',
      },
    });

    await fireEvent.click(screen.getByTestId(`connected-account-row-${ACCOUNT.id}`));
    await fireEvent.click(screen.getByTestId(`disconnect-start-${ACCOUNT.id}`));
    await fireEvent.click(screen.getByTestId(`disconnect-confirm-${ACCOUNT.id}`));

    expect(disconnectAccount).toHaveBeenCalledWith('node_1', ACCOUNT.id);
    await Promise.resolve();
    expect(refreshConnectedAccounts).toHaveBeenCalled();
  });

  it('Cancel on the confirm bar backs out without disconnecting', async () => {
    const disconnectAccount = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({ disconnectAccount }),
        nodeId: 'node_1',
      },
    });

    await fireEvent.click(screen.getByTestId(`connected-account-row-${ACCOUNT.id}`));
    await fireEvent.click(screen.getByTestId(`disconnect-start-${ACCOUNT.id}`));
    await fireEvent.click(screen.getByTestId(`disconnect-cancel-${ACCOUNT.id}`));

    expect(screen.queryByTestId(`disconnect-confirmbar-${ACCOUNT.id}`)).toBeNull();
    expect(disconnectAccount).not.toHaveBeenCalled();
  });
});
