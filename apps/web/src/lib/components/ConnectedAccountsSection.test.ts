// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAccount, GithubConnectOutcome } from '@loombox/protocol';
import type { TargetListEntry } from '$lib/relay-client';
import ConnectedAccountsSection, {
  type ConnectedAccountsClient,
} from './ConnectedAccountsSection.svelte';

// jsdom has no Web Animations API; `GithubConnectFlow`/`JiraConnectForm`'s
// `Dialog` calls `element.animate()` once opened reactively (see
// `TargetStatusView.test.ts`'s own identical stub for why).
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

const ONE_TARGET: TargetListEntry[] = [
  {
    nodeId: 'node_1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local',
    reachable: true,
    providers: ['claude'],
  },
];

const TWO_NODE_TARGETS: TargetListEntry[] = [
  ...ONE_TARGET,
  {
    nodeId: 'node_2',
    targetId: 'mac',
    label: 'The Mac',
    kind: 'local',
    reachable: true,
    providers: ['claude'],
  },
];

function noopClient(): ConnectedAccountsClient {
  return {
    startGithubConnect: vi.fn(() => ({
      requestId: 'r',
      cancel: vi.fn(),
      result: Promise.withResolvers<GithubConnectOutcome>().promise,
    })),
    connectJiraAccount: vi.fn(),
    disconnectAccount: vi.fn(),
    getAccountPins: vi.fn(async () => ({})),
    setAccountPin: vi.fn(),
    unsetAccountPin: vi.fn(),
    resolveAccountPin: vi.fn(),
    refreshConnectedAccounts: vi.fn(),
  };
}

describe('ConnectedAccountsSection (SPEC §7.26, issue #230)', () => {
  it('tells the operator to connect a node first when there are no known nodes', () => {
    render(ConnectedAccountsSection, {
      props: { client: noopClient(), connectedAccounts: [], targets: [], projectPaths: [] },
    });
    expect(screen.getByTestId('accounts-no-nodes')).toBeTruthy();
    expect(screen.queryByTestId('accounts-connect-github')).toBeNull();
  });

  it('offers no node picker with exactly one known node — it is used implicitly', () => {
    render(ConnectedAccountsSection, {
      props: {
        client: noopClient(),
        connectedAccounts: [],
        targets: ONE_TARGET,
        projectPaths: [],
      },
    });
    expect(screen.queryByTestId('accounts-node-select')).toBeNull();
    expect(screen.getByTestId('accounts-connect-github')).toBeTruthy();
  });

  it('offers a node picker once more than one node is known', () => {
    render(ConnectedAccountsSection, {
      props: {
        client: noopClient(),
        connectedAccounts: [],
        targets: TWO_NODE_TARGETS,
        projectPaths: [],
      },
    });
    expect(screen.getByTestId('accounts-node-select')).toBeTruthy();
  });

  it('opens the GitHub device-flow dialog from the connect action', async () => {
    render(ConnectedAccountsSection, {
      props: {
        client: noopClient(),
        connectedAccounts: [],
        targets: ONE_TARGET,
        projectPaths: [],
      },
    });

    await fireEvent.click(screen.getByTestId('accounts-connect-github'));

    expect(screen.getByRole('dialog', { name: 'Connect a GitHub account' })).toBeTruthy();
  });

  it('opens the Jira connect dialog from the connect action', async () => {
    render(ConnectedAccountsSection, {
      props: {
        client: noopClient(),
        connectedAccounts: [],
        targets: ONE_TARGET,
        projectPaths: [],
      },
    });

    await fireEvent.click(screen.getByTestId('accounts-connect-jira'));

    expect(screen.getByRole('dialog', { name: 'Connect a Jira account' })).toBeTruthy();
  });

  it('lists real connected accounts from the store', () => {
    const account: ConnectedAccount = {
      id: 'github:github.com:1',
      provider: 'github',
      host: 'github.com',
      providerAccountId: '1',
      label: 'lorenzo',
      credentialSource: 'device_flow',
      scopes: ['repo'],
      capabilities: ['issues'],
      connectedAt: 1000,
      updatedAt: 1000,
      secretRef: 'connected-account-token:github:github.com:1',
    };
    render(ConnectedAccountsSection, {
      props: {
        client: noopClient(),
        connectedAccounts: [account],
        targets: ONE_TARGET,
        projectPaths: [],
      },
    });
    expect(screen.getByText('lorenzo')).toBeTruthy();
  });
});
