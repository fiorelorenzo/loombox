import { describe, expect, it } from 'vitest';

import { connectedAccountSecretRef, type ConnectedAccount } from '@loombox/protocol';

import {
  AccountHostMismatchError,
  AccountNotPresentOnNodeError,
  AccountPinDanglingError,
  AccountPinMalformedError,
  AccountPinRequiredError,
  AmbiguousAccountError,
  ensureAccountPresentOnThisNode,
  resolveAccountForRead,
  resolveAccountForWrite,
  resolveAccountForWriteOnThisNode,
  type AccountPinMap,
  type AccountResolutionTarget,
  type NodePresenceCheck,
} from './account-pin';

function account(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base = {
    id: 'github:github.com:1111',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1111',
    label: 'octocat',
    credentialSource: 'device_flow' as const,
    scopes: ['repo', 'read:user', 'read:org'],
    capabilities: ['repo', 'issues'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef('github:github.com:1111'),
  };
  return { ...base, ...overrides };
}

const GITHUB_COM: AccountResolutionTarget = { provider: 'github', host: 'github.com' };
const JIRA_SITE: AccountResolutionTarget = { provider: 'jira', host: 'myteam.atlassian.net' };

const octocat = account();
const otherGithub = account({
  id: 'github:github.com:2222',
  providerAccountId: '2222',
  label: 'other-cat',
  secretRef: connectedAccountSecretRef('github:github.com:2222'),
});
const jiraAccount = account({
  id: 'jira:myteam.atlassian.net:5b10ac8d',
  provider: 'jira',
  host: 'myteam.atlassian.net',
  providerAccountId: '5b10ac8d',
  label: 'Jane Doe',
  credentialSource: 'api_token',
  scopes: null,
  capabilities: ['issues', 'boards'],
  secretRef: connectedAccountSecretRef('jira:myteam.atlassian.net:5b10ac8d'),
});
// A GHES instance on a non-default port — its host itself contains a colon
// (SPEC §7.26 / issue #221's parser is deliberately tolerant of this).
const ghesAccount = account({
  id: 'github:github.example.com:8443:9999',
  host: 'github.example.com:8443',
  providerAccountId: '9999',
  label: 'ghes-user',
  secretRef: connectedAccountSecretRef('github:github.example.com:8443:9999'),
});
const GHES: AccountResolutionTarget = { provider: 'github', host: 'github.example.com:8443' };

describe('AccountPinMap — tri-state (SPEC §7.26)', () => {
  it('an absent key, an explicit null, and a string pin are all distinguishable', () => {
    const pins: AccountPinMap = { jira: 'jira:myteam.atlassian.net:5b10ac8d' };
    pins.github = null;
    expect('github' in pins).toBe(true);
    expect(pins.github).toBeNull();
    expect('jira' in pins).toBe(true);
    expect(pins.jira).toBe('jira:myteam.atlassian.net:5b10ac8d');
    expect('slack' in pins).toBe(false);
    expect(pins.slack).toBeUndefined();
  });

  it('a JSON round trip preserves explicit null distinctly from an absent key — collapsing null into absent is the bug this guards against', () => {
    const pins: AccountPinMap = { github: null, jira: 'jira:myteam.atlassian.net:5b10ac8d' };
    const restored: AccountPinMap = JSON.parse(JSON.stringify(pins));
    expect('github' in restored).toBe(true);
    expect(restored.github).toBeNull();
    expect(restored.jira).toBe('jira:myteam.atlassian.net:5b10ac8d');
    expect('trackers' in restored).toBe(false);
  });
});

describe('resolveAccountForRead', () => {
  it('returns undefined for an explicit opt-out (null pin), even with an unambiguous candidate available', () => {
    const pins: AccountPinMap = { github: null };
    const resolved = resolveAccountForRead({
      pins,
      capability: 'github',
      accounts: [octocat],
      target: GITHUB_COM,
    });
    expect(resolved).toBeUndefined();
  });

  it('resolves an explicit string pin to the matching connected account', () => {
    const pins: AccountPinMap = { github: octocat.id };
    const resolved = resolveAccountForRead({
      pins,
      capability: 'github',
      accounts: [octocat, otherGithub],
      target: GITHUB_COM,
    });
    expect(resolved).toBe(octocat);
  });

  it('resolves an explicit string pin to the matching connected account (Jira)', () => {
    const pins: AccountPinMap = { jira: jiraAccount.id };
    const resolved = resolveAccountForRead({
      pins,
      capability: 'jira',
      accounts: [jiraAccount],
      target: JIRA_SITE,
    });
    expect(resolved).toBe(jiraAccount);
  });

  it('with no pin and exactly one candidate, resolves that candidate silently', () => {
    const resolved = resolveAccountForRead({
      pins: {},
      capability: 'github',
      accounts: [octocat],
      target: GITHUB_COM,
    });
    expect(resolved).toBe(octocat);
  });

  it('with no pin and zero candidates, returns undefined (nothing to read with, not an error)', () => {
    const resolved = resolveAccountForRead({
      pins: {},
      capability: 'github',
      accounts: [],
      target: GITHUB_COM,
    });
    expect(resolved).toBeUndefined();
  });

  it('with no pin and two candidates, throws AmbiguousAccountError instead of guessing', () => {
    expect(() =>
      resolveAccountForRead({
        pins: {},
        capability: 'github',
        accounts: [octocat, otherGithub],
        target: GITHUB_COM,
      }),
    ).toThrow(AmbiguousAccountError);
  });

  it('hard-fails on a host mismatch for an explicit pin (GitHub)', () => {
    const pins: AccountPinMap = { github: octocat.id }; // pinned to github.com
    expect(() =>
      resolveAccountForRead({
        pins,
        capability: 'github',
        accounts: [octocat],
        target: { provider: 'github', host: 'github.example.com' }, // project wants a different host
      }),
    ).toThrow(AccountHostMismatchError);
  });

  it('hard-fails on a host mismatch for an explicit pin (Jira)', () => {
    const pins: AccountPinMap = { jira: jiraAccount.id }; // pinned to myteam.atlassian.net
    expect(() =>
      resolveAccountForRead({
        pins,
        capability: 'jira',
        accounts: [jiraAccount],
        target: { provider: 'jira', host: 'otherteam.atlassian.net' },
      }),
    ).toThrow(AccountHostMismatchError);
  });

  it('resolves a GHES account whose host itself contains a colon (non-default port)', () => {
    const pins: AccountPinMap = { github: ghesAccount.id };
    const resolved = resolveAccountForRead({
      pins,
      capability: 'github',
      accounts: [ghesAccount],
      target: GHES,
    });
    expect(resolved).toBe(ghesAccount);
  });

  it('a GHES pin still hard-fails against a mismatched port on the same base host', () => {
    const pins: AccountPinMap = { github: ghesAccount.id };
    expect(() =>
      resolveAccountForRead({
        pins,
        capability: 'github',
        accounts: [ghesAccount],
        target: { provider: 'github', host: 'github.example.com:9443' },
      }),
    ).toThrow(AccountHostMismatchError);
  });

  it('throws AccountPinDanglingError when the pinned id names no known account', () => {
    const pins: AccountPinMap = { github: 'github:github.com:404404' };
    expect(() =>
      resolveAccountForRead({
        pins,
        capability: 'github',
        accounts: [octocat],
        target: GITHUB_COM,
      }),
    ).toThrow(AccountPinDanglingError);
  });

  it('throws AccountPinMalformedError when the pinned value does not parse as an account id', () => {
    const pins: AccountPinMap = { github: 'not-a-valid-id' };
    expect(() =>
      resolveAccountForRead({
        pins,
        capability: 'github',
        accounts: [octocat],
        target: GITHUB_COM,
      }),
    ).toThrow(AccountPinMalformedError);
  });
});

describe('resolveAccountForWrite', () => {
  it('refuses to run with an absent (unconfigured) pin, even with an unambiguous candidate available', () => {
    expect(() =>
      resolveAccountForWrite({
        pins: {},
        capability: 'github',
        accounts: [octocat],
        target: GITHUB_COM,
      }),
    ).toThrow(AccountPinRequiredError);
  });

  it('refuses to run with an explicit opt-out (null pin)', () => {
    const pins: AccountPinMap = { github: null };
    expect(() =>
      resolveAccountForWrite({
        pins,
        capability: 'github',
        accounts: [octocat],
        target: GITHUB_COM,
      }),
    ).toThrow(AccountPinRequiredError);
  });

  it('resolves with an explicit pin', () => {
    const pins: AccountPinMap = { github: octocat.id };
    const resolved = resolveAccountForWrite({
      pins,
      capability: 'github',
      accounts: [octocat, otherGithub],
      target: GITHUB_COM,
    });
    expect(resolved).toBe(octocat);
  });

  it('hard-fails on a host mismatch for an explicit pin (GitHub)', () => {
    const pins: AccountPinMap = { github: octocat.id };
    expect(() =>
      resolveAccountForWrite({
        pins,
        capability: 'github',
        accounts: [octocat],
        target: { provider: 'github', host: 'github.example.com' },
      }),
    ).toThrow(AccountHostMismatchError);
  });

  it('hard-fails on a host mismatch for an explicit pin (Jira)', () => {
    const pins: AccountPinMap = { jira: jiraAccount.id };
    expect(() =>
      resolveAccountForWrite({
        pins,
        capability: 'jira',
        accounts: [jiraAccount],
        target: { provider: 'jira', host: 'otherteam.atlassian.net' },
      }),
    ).toThrow(AccountHostMismatchError);
  });

  it('resolves a GHES account whose host itself contains a colon (non-default port)', () => {
    const pins: AccountPinMap = { github: ghesAccount.id };
    const resolved = resolveAccountForWrite({
      pins,
      capability: 'github',
      accounts: [ghesAccount],
      target: GHES,
    });
    expect(resolved).toBe(ghesAccount);
  });

  it('never silently falls back to a same-provider account at the right host when the pin points elsewhere — only a mismatch error, not a substitution', () => {
    const pins: AccountPinMap = { github: 'github:github.example.com:404404' };
    expect(() =>
      resolveAccountForWrite({
        pins,
        capability: 'github',
        accounts: [octocat], // github.com, an unambiguous single candidate — must never be substituted in
        target: GITHUB_COM,
      }),
    ).toThrow(AccountHostMismatchError);
  });
});

/** A `NodePresenceCheck` stub keyed on `secretRef` — never touches a real keyring, mirroring how `NodeAccountPresence` itself is exercised in `account-presence.test.ts`. */
function presenceOf(presentSecretRefs: readonly string[]): NodePresenceCheck {
  return {
    async isPresent(account) {
      return presentSecretRefs.includes(account.secretRef);
    },
  };
}

describe('ensureAccountPresentOnThisNode (SPEC §7.26 "Node-locality", issue #228)', () => {
  it('resolves without throwing when the presence check reports the account present', async () => {
    await expect(
      ensureAccountPresentOnThisNode(octocat, 'github', presenceOf([octocat.secretRef])),
    ).resolves.toBeUndefined();
  });

  it('throws AccountNotPresentOnNodeError when the presence check reports the account absent', async () => {
    await expect(ensureAccountPresentOnThisNode(octocat, 'github', presenceOf([]))).rejects.toThrow(
      AccountNotPresentOnNodeError,
    );
  });
});

describe('resolveAccountForWriteOnThisNode (SPEC §7.26 "Node-locality", issue #228)', () => {
  it('resolves when the pinned account is present on this node', async () => {
    const pins: AccountPinMap = { github: octocat.id };
    const resolved = await resolveAccountForWriteOnThisNode(
      { pins, capability: 'github', accounts: [octocat, otherGithub], target: GITHUB_COM },
      presenceOf([octocat.secretRef]),
    );
    expect(resolved).toBe(octocat);
  });

  it('throws AccountNotPresentOnNodeError — a distinct outcome from "no pin" and from "ambiguous" — when the pinned account resolves but this node holds no local secret for it', async () => {
    const pins: AccountPinMap = { github: octocat.id };
    await expect(
      resolveAccountForWriteOnThisNode(
        { pins, capability: 'github', accounts: [octocat, otherGithub], target: GITHUB_COM },
        presenceOf([]), // otherGithub's secret is present, but octocat's — the pinned one — is not
      ),
    ).rejects.toThrow(AccountNotPresentOnNodeError);
  });

  it("never reaches the presence check at all — #227's hard-fail cases stay intact — for an absent (unconfigured) pin", async () => {
    let presenceChecked = false;
    await expect(
      resolveAccountForWriteOnThisNode(
        { pins: {}, capability: 'github', accounts: [octocat], target: GITHUB_COM },
        {
          async isPresent() {
            presenceChecked = true;
            return true;
          },
        },
      ),
    ).rejects.toThrow(AccountPinRequiredError);
    expect(presenceChecked).toBe(false);
  });

  it('still hard-fails on a host mismatch before ever consulting node-presence (#227 unchanged)', async () => {
    const pins: AccountPinMap = { github: octocat.id };
    await expect(
      resolveAccountForWriteOnThisNode(
        {
          pins,
          capability: 'github',
          accounts: [octocat],
          target: { provider: 'github', host: 'github.example.com' },
        },
        presenceOf([octocat.secretRef]),
      ),
    ).rejects.toThrow(AccountHostMismatchError);
  });

  it('still hard-fails on a dangling pin before ever consulting node-presence (#227 unchanged)', async () => {
    const pins: AccountPinMap = { github: 'github:github.com:404404' };
    await expect(
      resolveAccountForWriteOnThisNode(
        { pins, capability: 'github', accounts: [octocat], target: GITHUB_COM },
        presenceOf(['anything']),
      ),
    ).rejects.toThrow(AccountPinDanglingError);
  });
});
