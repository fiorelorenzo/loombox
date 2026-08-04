// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectedAccount,
  GithubConnectDeviceCode,
  GithubConnectOutcome,
} from '@loombox/protocol';
import GithubConnectFlow, { type GithubConnectClient } from './GithubConnectFlow.svelte';

afterEach(() => cleanup());

const ACCOUNT: ConnectedAccount = {
  id: 'github:github.com:12345',
  provider: 'github',
  host: 'github.com',
  providerAccountId: '12345',
  label: 'lorenzo',
  credentialSource: 'device_flow',
  scopes: ['repo', 'read:user'],
  capabilities: ['issues', 'comments'],
  connectedAt: 1000,
  updatedAt: 1000,
  secretRef: 'connected-account-token:github:github.com:12345',
};

const DEVICE_CODE: GithubConnectDeviceCode = {
  type: 'github_connect_device_code',
  protocolVersion: 1,
  requestId: 'req-1',
  nodeId: 'node_1',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresInSeconds: 900,
  intervalSeconds: 5,
};

/** A fake `client.startGithubConnect` whose device-code callback and terminal result the test controls by hand — mirrors how the real `RelayClient` streams one then settles the other. */
function makeClient(): {
  client: GithubConnectClient;
  emitDeviceCode: (info: GithubConnectDeviceCode) => void;
  settle: (outcome: GithubConnectOutcome) => void;
  cancel: () => void;
} {
  let resolveResult: (outcome: GithubConnectOutcome) => void = () => {};
  const result = new Promise<GithubConnectOutcome>((resolve) => {
    resolveResult = resolve;
  });
  let emitDeviceCode: (info: GithubConnectDeviceCode) => void = () => {};
  const cancel = vi.fn();
  const client: GithubConnectClient = {
    startGithubConnect: (_nodeId, onDeviceCode) => {
      emitDeviceCode = onDeviceCode;
      return { requestId: 'req-1', cancel, result };
    },
  };
  return {
    client,
    emitDeviceCode: (info) => emitDeviceCode(info),
    settle: resolveResult,
    cancel,
  };
}

describe('GithubConnectFlow (SPEC §7.26, issue #230)', () => {
  it('shows the big, selectable device code and verification link once the node issues it', async () => {
    const setup = makeClient();
    render(GithubConnectFlow, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: setup.client,
        onClose: vi.fn(),
        onConnected: vi.fn(),
      },
    });

    setup.emitDeviceCode(DEVICE_CODE);

    await waitFor(() => expect(screen.getByTestId('github-device-user-code')).toBeTruthy());
    expect(screen.getByTestId('github-device-user-code').textContent).toContain('ABCD-1234');
    expect(screen.getByText('https://github.com/login/device')).toBeTruthy();
  });

  it("cancel calls the flow's own cancel() and closes", async () => {
    const setup = makeClient();
    const onClose = vi.fn();
    render(GithubConnectFlow, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: setup.client,
        onClose,
        onConnected: vi.fn(),
      },
    });
    setup.emitDeviceCode(DEVICE_CODE);
    await waitFor(() => expect(screen.getByTestId('github-connect-cancel')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('github-connect-cancel'));

    expect(setup.cancel).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it('renders success and calls onConnected with the new account', async () => {
    const setup = makeClient();
    const onConnected = vi.fn();
    render(GithubConnectFlow, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: setup.client,
        onClose: vi.fn(),
        onConnected,
      },
    });
    setup.emitDeviceCode(DEVICE_CODE);
    setup.settle({ outcome: 'success', account: ACCOUNT });

    await waitFor(() => expect(screen.getByTestId('github-connect-success')).toBeTruthy());
    expect(screen.getByTestId('github-connect-success').textContent).toContain('lorenzo');
    expect(onConnected).toHaveBeenCalledWith(ACCOUNT);
  });

  it('renders the failure message on an operator-actionable outcome (e.g. expired code)', async () => {
    const setup = makeClient();
    render(GithubConnectFlow, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: setup.client,
        onClose: vi.fn(),
        onConnected: vi.fn(),
      },
    });
    setup.emitDeviceCode(DEVICE_CODE);
    setup.settle({ outcome: 'failure', reason: 'expired_token', message: 'Code expired.' });

    await waitFor(() => expect(screen.getByText('Code expired.')).toBeTruthy());
    expect(screen.getByTestId('github-connect-retry')).toBeTruthy();
  });
});
