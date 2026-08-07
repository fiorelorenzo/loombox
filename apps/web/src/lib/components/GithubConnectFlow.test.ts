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
  connectGithubPat: ReturnType<typeof vi.fn<GithubConnectClient['connectGithubPat']>>;
} {
  let resolveResult: (outcome: GithubConnectOutcome) => void = () => {};
  const result = new Promise<GithubConnectOutcome>((resolve) => {
    resolveResult = resolve;
  });
  let emitDeviceCode: (info: GithubConnectDeviceCode) => void = () => {};
  const cancel = vi.fn();
  const connectGithubPat = vi.fn<GithubConnectClient['connectGithubPat']>();
  const client: GithubConnectClient = {
    startGithubConnect: (_nodeId, onDeviceCode) => {
      emitDeviceCode = onDeviceCode;
      return { requestId: 'req-1', cancel, result };
    },
    connectGithubPat,
  };
  return {
    client,
    emitDeviceCode: (info) => emitDeviceCode(info),
    settle: resolveResult,
    cancel,
    connectGithubPat,
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

describe('GithubConnectFlow — fine-grained PAT paste (issue #224)', () => {
  it('the token input is masked (type=password) — the same mechanism that keeps it out of the accessibility tree', async () => {
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

    await fireEvent.click(screen.getByTestId('github-connect-use-pat'));

    const input = screen.getByTestId('github-pat-connect-token') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('connects a pasted token, reports the account and repositories it can reach, and never renders the raw token anywhere in the DOM', async () => {
    const setup = makeClient();
    const onConnected = vi.fn();
    const { container } = render(GithubConnectFlow, {
      props: {
        open: true,
        nodeId: 'node_1',
        client: setup.client,
        onClose: vi.fn(),
        onConnected,
      },
    });

    await fireEvent.click(screen.getByTestId('github-connect-use-pat'));
    const patAccount: ConnectedAccount = {
      ...ACCOUNT,
      credentialSource: 'fine_grained_pat',
      scopes: [],
      capabilities: ['repo'],
    };
    setup.connectGithubPat.mockResolvedValue({
      outcome: 'success',
      account: patAccount,
      accessibleRepositories: ['lorenzo/loombox', 'lorenzo/dotfiles'],
      accessibleRepositoriesTruncated: false,
    });

    // A distinctive marker standing in for a real token — if this literal
    // ever showed up in the rendered DOM, that would be exactly the
    // hazard issue #224's acceptance calls out (never a log, transcript,
    // or accessibility-tree leak).
    const FAKE_TOKEN = 'github_pat_totally-secret-should-never-render-9f3a';
    await fireEvent.input(screen.getByTestId('github-pat-connect-token'), {
      target: { value: FAKE_TOKEN },
    });
    await fireEvent.click(screen.getByTestId('github-pat-connect-submit'));

    await waitFor(() => expect(screen.getByTestId('github-connect-success')).toBeTruthy());
    expect(setup.connectGithubPat).toHaveBeenCalledWith('node_1', {
      token: FAKE_TOKEN,
      host: undefined,
    });
    expect(onConnected).toHaveBeenCalledWith(patAccount);
    const reach = screen.getByTestId('github-pat-connect-reach').textContent ?? '';
    expect(reach).toContain('lorenzo/loombox');
    expect(reach).toContain('lorenzo/dotfiles');
    expect(reach).toContain('2');
    expect(container.innerHTML).not.toContain(FAKE_TOKEN);
  });

  it('shows an actionable inline error for an invalid/expired/revoked token, and keeps the form open to retry', async () => {
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

    await fireEvent.click(screen.getByTestId('github-connect-use-pat'));
    setup.connectGithubPat.mockResolvedValue({
      outcome: 'failure',
      reason: 'invalid_or_revoked',
      message: 'This token is invalid, expired, or has been revoked.',
    });

    await fireEvent.input(screen.getByTestId('github-pat-connect-token'), {
      target: { value: 'github_pat_bad' },
    });
    await fireEvent.click(screen.getByTestId('github-pat-connect-submit'));

    await waitFor(() =>
      expect(screen.getByText(/invalid, expired, or has been revoked/)).toBeTruthy(),
    );
    expect(screen.getByTestId('github-pat-connect-form')).toBeTruthy();
  });

  it('shows an actionable inline error naming a too-narrow token', async () => {
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

    await fireEvent.click(screen.getByTestId('github-connect-use-pat'));
    setup.connectGithubPat.mockResolvedValue({
      outcome: 'failure',
      reason: 'insufficient_access',
      message: "This fine-grained PAT can't reach any repositories.",
    });

    await fireEvent.input(screen.getByTestId('github-pat-connect-token'), {
      target: { value: 'github_pat_too_narrow' },
    });
    await fireEvent.click(screen.getByTestId('github-pat-connect-submit'));

    await waitFor(() => expect(screen.getByText(/can't reach any repositories/)).toBeTruthy());
  });

  it('"Use the device flow instead" abandons the PAT form and restarts the device flow', async () => {
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

    await fireEvent.click(screen.getByTestId('github-connect-use-pat'));
    expect(screen.getByTestId('github-pat-connect-form')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('github-pat-connect-use-device-flow'));

    expect(screen.queryByTestId('github-pat-connect-form')).toBeNull();
    setup.emitDeviceCode(DEVICE_CODE);
    await waitFor(() => expect(screen.getByTestId('github-device-user-code')).toBeTruthy());
  });

  it('switching to PAT mode from the waiting device-code screen cancels the in-flight device flow', async () => {
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

    await fireEvent.click(screen.getByTestId('github-connect-use-pat'));

    expect(setup.cancel).toHaveBeenCalledOnce();
    expect(screen.getByTestId('github-pat-connect-form')).toBeTruthy();
  });

  it('sends a GitHub Enterprise Server host as typed, and omits it entirely for the default github.com', async () => {
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

    await fireEvent.click(screen.getByTestId('github-connect-use-pat'));
    setup.connectGithubPat.mockReturnValue(Promise.withResolvers<never>().promise);
    await fireEvent.input(screen.getByTestId('github-pat-connect-token'), {
      target: { value: 'github_pat_ghes' },
    });
    await fireEvent.input(screen.getByTestId('github-pat-connect-host'), {
      target: { value: 'github.mycorp.com' },
    });
    await fireEvent.click(screen.getByTestId('github-pat-connect-submit'));

    expect(setup.connectGithubPat).toHaveBeenCalledWith('node_1', {
      token: 'github_pat_ghes',
      host: 'github.mycorp.com',
    });
  });
});
