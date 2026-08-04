import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JiraConnectError, JiraConnectService, normalizeJiraSiteUrl } from './jira-connect';
import { JiraIdentityError } from './jira-identity';

/**
 * `JiraConnectService` end to end (SPEC §7.26, issue #225) against a
 * stubbed Jira site (never the real API), proving the specific things the
 * identity module alone can't: connecting a second site never overwrites
 * the first (the exact emdash limitation this issue fixes), the api token
 * and email actually land in the keyring rather than the synced row, and
 * `getCredential` builds the Basic-auth header #214's JiraTrackerBackend
 * consumes.
 */

const SITE_A_TOKEN = 'jira-api-token-site-a-never-synced';
const SITE_B_TOKEN = 'jira-api-token-site-b-never-synced';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A `fetchImpl` that stands in for one Jira site's `GET /rest/api/3/myself`, routed by URL — so a test wiring two sites never accidentally shares one stub. */
function stubJiraFetch(options: { baseUrl: string; response: Response }): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `${options.baseUrl}/rest/api/3/myself`) {
      return options.response;
    }
    throw new Error(`stubJiraFetch: unexpected URL ${url}`);
  };
  return impl;
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-jira-connect-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function service(): JiraConnectService {
  return new JiraConnectService({ stateDir, osKeyringBackendFactory: async () => undefined });
}

describe('JiraConnectService.connect (SPEC §7.26, issue #225)', () => {
  it('completes the flow, keys providerAccountId on the stable accountId, and sets credentialSource api_token', async () => {
    const svc = service();
    const fetchImpl = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(200, {
        accountId: 'acc-ada',
        displayName: 'Ada Lovelace',
        emailAddress: 'ada@example.com',
        avatarUrls: { '48x48': 'https://avatar.example.com/48' },
      }),
    });

    const account = await svc.connect({
      siteUrl: 'https://myteam.atlassian.net',
      email: 'ada@example.com',
      apiToken: SITE_A_TOKEN,
      fetchImpl,
    });

    expect(account.provider).toBe('jira');
    expect(account.host).toBe('myteam.atlassian.net');
    expect(account.providerAccountId).toBe('acc-ada');
    expect(account.id).toBe('jira:myteam.atlassian.net:acc-ada');
    expect(account.label).toBe('Ada Lovelace');
    expect(account.avatarUrl).toBe('https://avatar.example.com/48');
    expect(account.credentialSource).toBe('api_token');
    expect(account.scopes).toBeNull();
    expect(account.capabilities).toEqual(['comments', 'transitions', 'boards', 'sprints']);
    expect(account.secretRef).toBe('connected-account-token:jira:myteam.atlassian.net:acc-ada');
  });

  it('accepts a bare host siteUrl (no scheme) the same way as a full URL', async () => {
    const svc = service();
    const fetchImpl = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(200, { accountId: 'acc-ada', displayName: 'Ada Lovelace' }),
    });

    const account = await svc.connect({
      siteUrl: 'myteam.atlassian.net',
      email: 'ada@example.com',
      apiToken: SITE_A_TOKEN,
      fetchImpl,
    });

    expect(account.host).toBe('myteam.atlassian.net');
  });

  it('writes {email, apiToken} to the keyring, referenced only by secretRef — the synced metadata row carries neither', async () => {
    const svc = service();
    const fetchImpl = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(200, { accountId: 'acc-ada', displayName: 'Ada Lovelace' }),
    });

    const account = await svc.connect({
      siteUrl: 'https://myteam.atlassian.net',
      email: 'ada@example.com',
      apiToken: SITE_A_TOKEN,
      fetchImpl,
    });

    // The row this service hands back is exactly what `connected_account_announce`
    // (issue #221) syncs to the relay: assert the raw token AND email appear
    // nowhere in it, under any field.
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain(SITE_A_TOKEN);
    expect(serialized).not.toContain('ada@example.com');
    expect(Object.keys(account)).not.toContain('apiToken');
    expect(Object.keys(account)).not.toContain('email');

    // ...while the keyring (not the row) actually holds both, resolvable
    // through the Authorization header getCredential builds.
    const credential = await svc.getCredential(account);
    expect(credential?.baseUrl).toBe('https://myteam.atlassian.net');
    expect(credential?.authHeader).toBe(
      `Basic ${Buffer.from('ada@example.com:jira-api-token-site-a-never-synced').toString('base64')}`,
    );
  });

  it('connecting a second Jira site does not overwrite the first — both rows survive and resolve independently', async () => {
    const svc = service();
    const fetchImplA = stubJiraFetch({
      baseUrl: 'https://team-a.atlassian.net',
      response: jsonResponse(200, {
        accountId: 'acc-ada',
        displayName: 'Ada Lovelace',
        emailAddress: 'ada@team-a.example.com',
      }),
    });
    const fetchImplB = stubJiraFetch({
      baseUrl: 'https://team-b.atlassian.net',
      response: jsonResponse(200, {
        accountId: 'acc-grace',
        displayName: 'Grace Hopper',
        emailAddress: 'grace@team-b.example.com',
      }),
    });

    const accountA = await svc.connect({
      siteUrl: 'https://team-a.atlassian.net',
      email: 'ada@team-a.example.com',
      apiToken: SITE_A_TOKEN,
      fetchImpl: fetchImplA,
    });
    const accountB = await svc.connect({
      siteUrl: 'https://team-b.atlassian.net',
      email: 'grace@team-b.example.com',
      apiToken: SITE_B_TOKEN,
      fetchImpl: fetchImplB,
    });

    expect(accountA.id).not.toBe(accountB.id);
    expect(accountA.host).toBe('team-a.atlassian.net');
    expect(accountB.host).toBe('team-b.atlassian.net');

    const credentialA = await svc.getCredential(accountA);
    const credentialB = await svc.getCredential(accountB);
    expect(credentialA?.baseUrl).toBe('https://team-a.atlassian.net');
    expect(credentialB?.baseUrl).toBe('https://team-b.atlassian.net');
    expect(credentialA?.authHeader).toBe(
      `Basic ${Buffer.from(`ada@team-a.example.com:${SITE_A_TOKEN}`).toString('base64')}`,
    );
    expect(credentialB?.authHeader).toBe(
      `Basic ${Buffer.from(`grace@team-b.example.com:${SITE_B_TOKEN}`).toString('base64')}`,
    );

    // The first site's credential is still intact after the second connect
    // — nothing about connecting B mutated A's keyring entry.
    const credentialAAgain = await svc.getCredential(accountA);
    expect(credentialAAgain?.authHeader).toBe(credentialA?.authHeader);
  });

  it('connecting a second account on the SAME site also keeps both rows (two humans, one Jira instance)', async () => {
    const svc = service();
    const fetchImplAda = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(200, { accountId: 'acc-ada', displayName: 'Ada Lovelace' }),
    });
    const fetchImplGrace = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(200, { accountId: 'acc-grace', displayName: 'Grace Hopper' }),
    });

    const ada = await svc.connect({
      siteUrl: 'https://myteam.atlassian.net',
      email: 'ada@example.com',
      apiToken: SITE_A_TOKEN,
      fetchImpl: fetchImplAda,
    });
    const grace = await svc.connect({
      siteUrl: 'https://myteam.atlassian.net',
      email: 'grace@example.com',
      apiToken: SITE_B_TOKEN,
      fetchImpl: fetchImplGrace,
    });

    expect(ada.id).toBe('jira:myteam.atlassian.net:acc-ada');
    expect(grace.id).toBe('jira:myteam.atlassian.net:acc-grace');
    await expect(svc.getCredential(ada)).resolves.toMatchObject({
      authHeader: `Basic ${Buffer.from(`ada@example.com:${SITE_A_TOKEN}`).toString('base64')}`,
    });
    await expect(svc.getCredential(grace)).resolves.toMatchObject({
      authHeader: `Basic ${Buffer.from(`grace@example.com:${SITE_B_TOKEN}`).toString('base64')}`,
    });
  });

  it('a GET /rest/api/3/myself response with no accountId is rejected — nothing is written to the keyring and no ConnectedAccount is returned', async () => {
    const svc = service();
    const fetchImpl = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(200, { displayName: 'Ada Lovelace' }),
    });

    await expect(
      svc.connect({
        siteUrl: 'https://myteam.atlassian.net',
        email: 'ada@example.com',
        apiToken: SITE_A_TOKEN,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(JiraIdentityError);

    await expect(
      svc.getCredential({
        host: 'myteam.atlassian.net',
        secretRef: 'connected-account-token:jira:myteam.atlassian.net:acc-ada',
        credentialSource: 'api_token',
      }),
    ).resolves.toBeUndefined();
  });

  it('bad credentials (401) are rejected without writing anything to the keyring', async () => {
    const svc = service();
    const fetchImpl = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(401, { message: 'Unauthorized' }),
    });

    await expect(
      svc.connect({
        siteUrl: 'https://myteam.atlassian.net',
        email: 'ada@example.com',
        apiToken: 'wrong-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(JiraIdentityError);
  });

  it('getCredential returns undefined for an account this node never connected', async () => {
    const svc = service();

    await expect(
      svc.getCredential({
        host: 'myteam.atlassian.net',
        secretRef: 'connected-account-token:jira:myteam.atlassian.net:acc-nobody',
        credentialSource: 'api_token',
      }),
    ).resolves.toBeUndefined();
  });

  it('getCredential throws JiraConnectError for a non-api_token credentialSource — oauth_3lo has no resolver here yet', async () => {
    const svc = service();

    await expect(
      svc.getCredential({
        host: 'myteam.atlassian.net',
        secretRef: 'connected-account-token:jira:myteam.atlassian.net:acc-ada',
        credentialSource: 'oauth_3lo',
      }),
    ).rejects.toBeInstanceOf(JiraConnectError);
  });

  it('deleteCredential removes the stored secret so getCredential resolves undefined afterwards', async () => {
    const svc = service();
    const fetchImpl = stubJiraFetch({
      baseUrl: 'https://myteam.atlassian.net',
      response: jsonResponse(200, { accountId: 'acc-ada', displayName: 'Ada Lovelace' }),
    });

    const account = await svc.connect({
      siteUrl: 'https://myteam.atlassian.net',
      email: 'ada@example.com',
      apiToken: SITE_A_TOKEN,
      fetchImpl,
    });
    await expect(svc.getCredential(account)).resolves.toBeDefined();

    await svc.deleteCredential(account);

    await expect(svc.getCredential(account)).resolves.toBeUndefined();
  });
});

describe('normalizeJiraSiteUrl (issue #225)', () => {
  it('derives host and an https baseUrl from a bare host', () => {
    expect(normalizeJiraSiteUrl('myteam.atlassian.net')).toEqual({
      host: 'myteam.atlassian.net',
      baseUrl: 'https://myteam.atlassian.net',
    });
  });

  it('derives host and baseUrl from a full https URL, stripping a trailing slash', () => {
    expect(normalizeJiraSiteUrl('https://myteam.atlassian.net/')).toEqual({
      host: 'myteam.atlassian.net',
      baseUrl: 'https://myteam.atlassian.net',
    });
  });

  it('forces https even when the input explicitly says http', () => {
    expect(normalizeJiraSiteUrl('http://myteam.atlassian.net')).toEqual({
      host: 'myteam.atlassian.net',
      baseUrl: 'https://myteam.atlassian.net',
    });
  });

  it('preserves a Data Center :port, the one part of a composed id allowed to contain a colon', () => {
    expect(normalizeJiraSiteUrl('jira.mycorp.internal:8443')).toEqual({
      host: 'jira.mycorp.internal:8443',
      baseUrl: 'https://jira.mycorp.internal:8443',
    });
  });

  it('rejects an empty siteUrl', () => {
    expect(() => normalizeJiraSiteUrl('   ')).toThrow(JiraConnectError);
  });

  it('rejects an unparseable siteUrl', () => {
    expect(() => normalizeJiraSiteUrl('https://')).toThrow(JiraConnectError);
  });
});
