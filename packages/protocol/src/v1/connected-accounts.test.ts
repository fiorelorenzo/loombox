import { describe, expect, it } from 'vitest';
import { PROTOCOL_V1 } from './handshake';
import {
  composeConnectedAccountId,
  connectedAccount,
  connectedAccountAnnounce,
  connectedAccountList,
  connectedAccountListRequest,
  connectedAccountSecretRef,
  parseConnectedAccountId,
  type ConnectedAccount,
} from './connected-accounts';

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base = {
    id: 'github:github.com:1234567',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1234567',
    label: 'octocat',
    credentialSource: 'device_flow' as const,
    scopes: ['repo', 'read:user', 'read:org'],
    capabilities: ['repo', 'issues'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef('github:github.com:1234567'),
  };
  return { ...base, ...overrides };
}

describe('composeConnectedAccountId / parseConnectedAccountId', () => {
  it('round-trips a plain host', () => {
    const parts = { provider: 'github', host: 'github.com', providerAccountId: '1234567' };
    const id = composeConnectedAccountId(parts);
    expect(id).toBe('github:github.com:1234567');
    expect(parseConnectedAccountId(id)).toEqual(parts);
  });

  it('round-trips a host containing a colon (a GHES/Data Center instance on a non-default port)', () => {
    const parts = {
      provider: 'github',
      host: 'github.mycorp.com:8443',
      providerAccountId: '42',
    };
    const id = composeConnectedAccountId(parts);
    expect(id).toBe('github:github.mycorp.com:8443:42');
    expect(parseConnectedAccountId(id)).toEqual(parts);
  });

  it('rejects an id with fewer than two colons', () => {
    expect(parseConnectedAccountId('github')).toBeUndefined();
    expect(parseConnectedAccountId('github:github.com')).toBeUndefined();
  });

  it('rejects an id with an empty part', () => {
    expect(parseConnectedAccountId('::42')).toBeUndefined();
    expect(parseConnectedAccountId('github::42')).toBeUndefined();
    expect(parseConnectedAccountId('github:github.com:')).toBeUndefined();
  });
});

describe('connectedAccountSecretRef', () => {
  it('names a keyring entry off the id, never the secret itself', () => {
    expect(connectedAccountSecretRef('github:github.com:1234567')).toBe(
      'connected-account-token:github:github.com:1234567',
    );
  });
});

describe('connectedAccount', () => {
  it('parses a valid GitHub row', () => {
    const value = githubAccount();
    expect(connectedAccount.parse(value)).toEqual(value);
  });

  it('parses a valid Jira row, including a null scopes (Basic-auth API token, no introspection)', () => {
    const value = githubAccount({
      id: 'jira:myteam.atlassian.net:5b10ac8d82e05b22cc7d4ef5',
      provider: 'jira',
      host: 'myteam.atlassian.net',
      providerAccountId: '5b10ac8d82e05b22cc7d4ef5',
      label: 'Jane Doe',
      credentialSource: 'api_token',
      scopes: null,
      capabilities: ['comments', 'transitions'],
    });
    expect(connectedAccount.parse(value)).toEqual(value);
  });

  it('rejects an id that is not the derived composition', () => {
    const value = githubAccount({ id: 'github:github.com:9999999' });
    expect(() => connectedAccount.parse(value)).toThrow(/derived/);
  });

  it('rejects a providerAccountId shaped like an email', () => {
    const value = githubAccount({
      id: 'github:github.com:octocat@example.com',
      providerAccountId: 'octocat@example.com',
    });
    expect(() => connectedAccount.parse(value)).toThrow(/email/);
  });

  it('rejects a non-numeric github providerAccountId (a login, not the identity-call id)', () => {
    const value = githubAccount({
      id: 'github:github.com:octocat',
      providerAccountId: 'octocat',
    });
    expect(() => connectedAccount.parse(value)).toThrow(/numeric/);
  });

  it('allows a non-numeric jira providerAccountId (no generic numeric-id guarantee for Jira)', () => {
    const value = githubAccount({
      id: 'jira:myteam.atlassian.net:5b10ac8d82e05b22cc7d4ef5',
      provider: 'jira',
      host: 'myteam.atlassian.net',
      providerAccountId: '5b10ac8d82e05b22cc7d4ef5',
      credentialSource: 'api_token',
      scopes: null,
    });
    expect(connectedAccount.parse(value)).toEqual(value);
  });

  it('rejects a provider containing a colon', () => {
    const value = githubAccount({ provider: 'git:hub', id: 'git:hub:github.com:1234567' });
    expect(() => connectedAccount.parse(value)).toThrow();
  });

  it('rejects a providerAccountId containing a colon', () => {
    const value = githubAccount({
      providerAccountId: '123:456',
      id: 'github:github.com:123:456',
    });
    expect(() => connectedAccount.parse(value)).toThrow();
  });

  it('has no nodePresence field: one is silently stripped, never round-tripped (issue #228 computes it lazily)', () => {
    const value = githubAccount();
    const withExtra = { ...value, nodePresence: { 'node-a': true, 'node-b': false } };
    const parsed = connectedAccount.parse(withExtra);
    expect(parsed).not.toHaveProperty('nodePresence');
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(value).sort());
  });

  it('type-level: ConnectedAccount has no nodePresence key (fails tsc if one is ever added)', () => {
    type AssertNoNodePresence = 'nodePresence' extends keyof ConnectedAccount ? true : false;
    const assertion: AssertNoNodePresence = false;
    expect(assertion).toBe(false);
  });
});

describe('connectedAccountAnnounce / connectedAccountListRequest / connectedAccountList', () => {
  it('parses a valid announce', () => {
    const account = githubAccount();
    const message = {
      type: 'connected_account_announce' as const,
      protocolVersion: PROTOCOL_V1,
      account,
    };
    expect(connectedAccountAnnounce.parse(message)).toEqual(message);
  });

  it('parses a valid list request', () => {
    const message = {
      type: 'connected_account_list_request' as const,
      protocolVersion: PROTOCOL_V1,
    };
    expect(connectedAccountListRequest.parse(message)).toEqual(message);
  });

  it('parses a valid list reply, including an empty list', () => {
    const message = {
      type: 'connected_account_list' as const,
      protocolVersion: PROTOCOL_V1,
      accounts: [githubAccount()],
    };
    expect(connectedAccountList.parse(message)).toEqual(message);
    expect(connectedAccountList.parse({ ...message, accounts: [] }).accounts).toEqual([]);
  });

  it('never carries a token: no schema in this module has a field for one', () => {
    const account = githubAccount();
    const message = {
      type: 'connected_account_announce' as const,
      protocolVersion: PROTOCOL_V1,
      account: { ...account, token: 'gho_super-secret-value' },
    };
    const parsed = connectedAccountAnnounce.parse(message);
    expect(JSON.stringify(parsed)).not.toContain('super-secret-value');
    expect(parsed.account).not.toHaveProperty('token');
  });
});
