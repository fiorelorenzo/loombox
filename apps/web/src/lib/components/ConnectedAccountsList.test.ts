// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountPinScanHitV1, ConnectedAccount } from '@loombox/protocol';
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

const SOME_PINS: AccountPinScanHitV1[] = [
  { projectPath: '/home/dev/loombox', capability: 'github' },
  { projectPath: '/home/dev/side-project', capability: 'github' },
];

function noopClient(overrides: Partial<DisconnectAccountsClient> = {}): DisconnectAccountsClient {
  return {
    scanAccountPins: vi.fn(async () => []),
    disconnectAccount: vi.fn(),
    refreshConnectedAccounts: vi.fn(),
    ...overrides,
  };
}

async function expandAndClickDisconnect(accountId: string): Promise<void> {
  await fireEvent.click(screen.getByTestId(`connected-account-row-${accountId}`));
  await fireEvent.click(screen.getByTestId(`disconnect-start-${accountId}`));
}

describe('ConnectedAccountsList (SPEC §7.26, issues #230/#229)', () => {
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

  it('clicking Disconnect scans for pins first — disconnectAccount is not called before the scan resolves', async () => {
    const scanAccountPins = vi.fn(async () => SOME_PINS);
    const disconnectAccount = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({ scanAccountPins, disconnectAccount }),
        nodeId: 'node_1',
      },
    });

    await expandAndClickDisconnect(ACCOUNT.id);

    expect(scanAccountPins).toHaveBeenCalledWith('node_1', ACCOUNT.id);
    expect(disconnectAccount).not.toHaveBeenCalled();
  });

  it('a scan that finds pins shows a confirm bar naming the real affected projects and capabilities, not a generic warning', async () => {
    const disconnectAccount = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({ scanAccountPins: vi.fn(async () => SOME_PINS), disconnectAccount }),
        nodeId: 'node_1',
      },
    });

    await expandAndClickDisconnect(ACCOUNT.id);

    const bar = await waitFor(() => screen.getByTestId(`disconnect-confirmbar-${ACCOUNT.id}`));
    expect(bar.textContent).toContain('pinned');
    const affected = screen.getByTestId(`disconnect-affected-${ACCOUNT.id}`);
    expect(affected.textContent).toContain('/home/dev/loombox');
    expect(affected.textContent).toContain('github');
    expect(affected.textContent).toContain('/home/dev/side-project');
    expect(disconnectAccount).not.toHaveBeenCalled();
  });

  it('a scan that finds nothing disconnects immediately, with no confirm bar ever shown (issue #229 acceptance)', async () => {
    const scanAccountPins = vi.fn(async () => []);
    const disconnectAccount = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', message: 'Disconnected.' });
    const refreshConnectedAccounts = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({ scanAccountPins, disconnectAccount, refreshConnectedAccounts }),
        nodeId: 'node_1',
      },
    });

    await expandAndClickDisconnect(ACCOUNT.id);

    await waitFor(() => expect(disconnectAccount).toHaveBeenCalledWith('node_1', ACCOUNT.id));
    expect(screen.queryByTestId(`disconnect-confirmbar-${ACCOUNT.id}`)).toBeNull();
    await waitFor(() => expect(refreshConnectedAccounts).toHaveBeenCalled());
  });

  it('confirming Disconnect on a bar naming real pins calls disconnectAccount with the acting node and refreshes the list', async () => {
    const disconnectAccount = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', message: 'Disconnected.' });
    const refreshConnectedAccounts = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({
          scanAccountPins: vi.fn(async () => SOME_PINS),
          disconnectAccount,
          refreshConnectedAccounts,
        }),
        nodeId: 'node_1',
      },
    });

    await expandAndClickDisconnect(ACCOUNT.id);
    await waitFor(() => screen.getByTestId(`disconnect-confirm-${ACCOUNT.id}`));
    await fireEvent.click(screen.getByTestId(`disconnect-confirm-${ACCOUNT.id}`));

    expect(disconnectAccount).toHaveBeenCalledWith('node_1', ACCOUNT.id);
    await waitFor(() => expect(refreshConnectedAccounts).toHaveBeenCalled());
  });

  it('Cancel on the confirm bar backs out without disconnecting', async () => {
    const disconnectAccount = vi.fn();
    render(ConnectedAccountsList, {
      props: {
        accounts: [ACCOUNT],
        client: noopClient({ scanAccountPins: vi.fn(async () => SOME_PINS), disconnectAccount }),
        nodeId: 'node_1',
      },
    });

    await expandAndClickDisconnect(ACCOUNT.id);
    await waitFor(() => screen.getByTestId(`disconnect-cancel-${ACCOUNT.id}`));
    await fireEvent.click(screen.getByTestId(`disconnect-cancel-${ACCOUNT.id}`));

    expect(screen.queryByTestId(`disconnect-confirmbar-${ACCOUNT.id}`)).toBeNull();
    expect(disconnectAccount).not.toHaveBeenCalled();
  });
});
