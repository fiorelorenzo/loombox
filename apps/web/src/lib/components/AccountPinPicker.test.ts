// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountPinMapV1,
  AccountPinResolveOutcome,
  ConnectedAccount,
} from '@loombox/protocol';
import AccountPinPicker, { type AccountPinClient } from './AccountPinPicker.svelte';

afterEach(() => cleanup());

const GITHUB_ACCOUNT: ConnectedAccount = {
  id: 'github:github.com:1',
  provider: 'github',
  host: 'github.com',
  providerAccountId: '1',
  label: 'lorenzo-personal',
  credentialSource: 'device_flow',
  scopes: ['repo'],
  capabilities: ['issues'],
  connectedAt: 1000,
  updatedAt: 1000,
  secretRef: 'connected-account-token:github:github.com:1',
};

const GITHUB_ACCOUNT_2: ConnectedAccount = {
  ...GITHUB_ACCOUNT,
  id: 'github:github.com:2',
  providerAccountId: '2',
  label: 'lorenzo-work',
};

function makeClient(overrides: Partial<AccountPinClient> = {}): AccountPinClient {
  return {
    getAccountPins: vi.fn(async () => ({}) as AccountPinMapV1),
    setAccountPin: vi.fn(async () => ({}) as AccountPinMapV1),
    unsetAccountPin: vi.fn(async () => ({}) as AccountPinMapV1),
    resolveAccountPin: vi.fn(async () => ({ outcome: 'none' }) as AccountPinResolveOutcome),
    ...overrides,
  };
}

describe('AccountPinPicker tri-state (SPEC §7.26/#227, issue #230)', () => {
  it('a node that never answers reads as "The pin list didn\'t answer in time...", never the raw wire message (issue #650)', async () => {
    const client = makeClient({
      getAccountPins: vi.fn(async () => {
        throw new Error(
          'RelayClient: timed out waiting for account_pin_get_response (account_pin_get_request)',
        );
      }),
    });
    render(AccountPinPicker, {
      props: { client, accounts: [GITHUB_ACCOUNT], projectPaths: ['/tmp/proj'], nodeId: 'node_1' },
    });

    const notice = await waitFor(() => screen.getByTestId('ui-error-notice'));
    expect(notice.textContent).not.toContain('account_pin_get_request');
    expect(notice.textContent).not.toContain('RelayClient');
    expect(notice.textContent).toContain("The pin list didn't answer in time.");
    expect(notice.textContent).toContain('may be asleep, offline, or on an older relay');

    const retry = screen.getByRole('button', { name: 'Retry' });
    await fireEvent.click(retry);
    expect(client.getAccountPins).toHaveBeenCalledTimes(2);
  });

  it('an absent key renders as Unconfigured — distinct from opted-out or pinned', async () => {
    const client = makeClient({ getAccountPins: vi.fn(async () => ({})) });
    render(AccountPinPicker, {
      props: { client, accounts: [GITHUB_ACCOUNT], projectPaths: ['/tmp/proj'], nodeId: 'node_1' },
    });

    await waitFor(() =>
      expect(
        screen.getByTestId('account-pin-radio-github-__unset__').getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(
      screen.getByTestId('account-pin-radio-github-__none__').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('an explicit null renders as Opted out — never confused with Unconfigured', async () => {
    const client = makeClient({ getAccountPins: vi.fn(async () => ({ github: null })) });
    render(AccountPinPicker, {
      props: { client, accounts: [GITHUB_ACCOUNT], projectPaths: ['/tmp/proj'], nodeId: 'node_1' },
    });

    await waitFor(() =>
      expect(
        screen.getByTestId('account-pin-radio-github-__none__').getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(
      screen.getByTestId('account-pin-radio-github-__unset__').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('a string pin renders as that specific account selected — distinct from both other states', async () => {
    const client = makeClient({
      getAccountPins: vi.fn(async () => ({ github: GITHUB_ACCOUNT.id })),
    });
    render(AccountPinPicker, {
      props: { client, accounts: [GITHUB_ACCOUNT], projectPaths: ['/tmp/proj'], nodeId: 'node_1' },
    });

    await waitFor(() =>
      expect(
        screen
          .getByTestId(`account-pin-radio-github-${GITHUB_ACCOUNT.id}`)
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(
      screen.getByTestId('account-pin-radio-github-__unset__').getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByTestId('account-pin-radio-github-__none__').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('all three states are reachable by picking them: unconfigured -> pinned -> opted-out -> unconfigured round-trips through the right client calls', async () => {
    let pins: AccountPinMapV1 = {};
    const setAccountPin = vi.fn(async (_nodeId, _path, capability, accountId) => {
      pins = { ...pins, [capability]: accountId };
      return pins;
    });
    const unsetAccountPin = vi.fn(async (_nodeId, _path, capability) => {
      const next = { ...pins };
      delete next[capability];
      pins = next;
      return pins;
    });
    const client = makeClient({
      getAccountPins: vi.fn(async () => pins),
      setAccountPin,
      unsetAccountPin,
    });
    render(AccountPinPicker, {
      props: {
        client,
        accounts: [GITHUB_ACCOUNT, GITHUB_ACCOUNT_2],
        projectPaths: ['/tmp/proj'],
        nodeId: 'node_1',
      },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('account-pin-radio-github-__unset__').getAttribute('aria-checked'),
      ).toBe('true'),
    );

    // Unconfigured -> pinned to a specific account.
    await fireEvent.click(screen.getByTestId(`account-pin-radio-github-${GITHUB_ACCOUNT.id}`));
    expect(setAccountPin).toHaveBeenCalledWith('node_1', '/tmp/proj', 'github', GITHUB_ACCOUNT.id);
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`account-pin-radio-github-${GITHUB_ACCOUNT.id}`)
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );

    // Pinned -> opted out.
    await fireEvent.click(screen.getByTestId('account-pin-radio-github-__none__'));
    expect(setAccountPin).toHaveBeenCalledWith('node_1', '/tmp/proj', 'github', null);
    await waitFor(() =>
      expect(
        screen.getByTestId('account-pin-radio-github-__none__').getAttribute('aria-checked'),
      ).toBe('true'),
    );

    // Opted out -> back to unconfigured (a genuinely different call than opting out).
    await fireEvent.click(screen.getByTestId('account-pin-radio-github-__unset__'));
    expect(unsetAccountPin).toHaveBeenCalledWith('node_1', '/tmp/proj', 'github');
    await waitFor(() =>
      expect(
        screen.getByTestId('account-pin-radio-github-__unset__').getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });
});

describe('AccountPinPicker resolution preview — five distinct error states (issue #230 acceptance)', () => {
  async function renderAndPreview(outcome: AccountPinResolveOutcome): Promise<void> {
    const client = makeClient({
      getAccountPins: vi.fn(async () => ({})),
      resolveAccountPin: vi.fn(async () => outcome),
    });
    render(AccountPinPicker, {
      props: { client, accounts: [GITHUB_ACCOUNT], projectPaths: ['/tmp/proj'], nodeId: 'node_1' },
    });
    await waitFor(() => expect(screen.getByTestId('account-pin-preview-run-github')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('account-pin-preview-run-github'));
    await waitFor(() => expect(screen.getByTestId('account-pin-preview-github')).toBeTruthy());
  }

  it('resolved renders the winning account', async () => {
    await renderAndPreview({ outcome: 'resolved', account: GITHUB_ACCOUNT });
    expect(screen.getByTestId('account-pin-preview-resolved-github').textContent).toContain(
      'lorenzo-personal',
    );
  });

  it('none renders "nothing to use", not an error', async () => {
    await renderAndPreview({ outcome: 'none' });
    expect(screen.getByTestId('account-pin-preview-none-github')).toBeTruthy();
  });

  it('AccountPinRequiredError renders a distinct required-pin state', async () => {
    await renderAndPreview({
      outcome: 'error',
      errorType: 'AccountPinRequiredError',
      message: 'required',
      capability: 'github',
    });
    const block = screen.getByTestId('account-pin-preview-error-github');
    expect(block.getAttribute('data-error-type')).toBe('AccountPinRequiredError');
    expect(block.textContent).toContain('never guess');
  });

  it('AccountPinMalformedError renders the malformed pin id and a clear-pin action', async () => {
    await renderAndPreview({
      outcome: 'error',
      errorType: 'AccountPinMalformedError',
      message: 'malformed',
      capability: 'github',
      pinnedAccountId: 'not-a-real-id',
    });
    const block = screen.getByTestId('account-pin-preview-error-github');
    expect(block.textContent).toContain('not-a-real-id');
    expect(block.querySelector('button')?.textContent).toContain('Clear this pin');
  });

  it('AccountHostMismatchError renders both the expected and actual host', async () => {
    await renderAndPreview({
      outcome: 'error',
      errorType: 'AccountHostMismatchError',
      message: 'mismatch',
      capability: 'github',
      pinnedAccountId: GITHUB_ACCOUNT.id,
      expectedHost: 'github.mycorp.com',
      actualHost: 'github.com',
    });
    const block = screen.getByTestId('account-pin-preview-error-github');
    expect(block.textContent).toContain('github.mycorp.com');
    expect(block.textContent).toContain('github.com');
  });

  it('AccountPinDanglingError renders the dangling id and a clear-pin action', async () => {
    await renderAndPreview({
      outcome: 'error',
      errorType: 'AccountPinDanglingError',
      message: 'dangling',
      capability: 'github',
      pinnedAccountId: 'github:github.com:999',
    });
    const block = screen.getByTestId('account-pin-preview-error-github');
    expect(block.textContent).toContain('github:github.com:999');
    expect(block.querySelector('button')?.textContent).toContain('Clear this pin');
  });

  it('AmbiguousAccountError lists candidate accounts as quick-pin actions', async () => {
    await renderAndPreview({
      outcome: 'error',
      errorType: 'AmbiguousAccountError',
      message: 'ambiguous',
      capability: 'github',
      candidateAccountIds: [GITHUB_ACCOUNT.id],
    });
    const block = screen.getByTestId('account-pin-preview-error-github');
    expect(block.textContent).toContain('lorenzo-personal');
  });

  it('every error type renders a visibly different data-error-type, never a raw error string alone', async () => {
    const types = [
      'AccountPinRequiredError',
      'AccountPinMalformedError',
      'AccountHostMismatchError',
      'AccountPinDanglingError',
      'AmbiguousAccountError',
    ] as const;
    for (const errorType of types) {
      cleanup();
      await renderAndPreview({
        outcome: 'error',
        errorType,
        message: 'x',
        capability: 'github',
        pinnedAccountId: 'x',
        expectedHost: 'x',
        actualHost: 'x',
        candidateAccountIds: [],
      });
      expect(
        screen.getByTestId('account-pin-preview-error-github').getAttribute('data-error-type'),
      ).toBe(errorType);
    }
  });
});
