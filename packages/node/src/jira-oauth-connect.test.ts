import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildJiraOauthAuthorizeUrl,
  exchangeJiraOauthCode,
  JIRA_OAUTH_CLIENT_ID_ENV_VAR,
  JIRA_OAUTH_CLIENT_SECRET_ENV_VAR,
  JIRA_OAUTH_SCOPES,
  JiraOauthConnectService,
  JiraOauthError,
  listJiraAccessibleResources,
  refreshJiraOauthToken,
  resolveJiraOauthClientId,
  resolveJiraOauthClientSecret,
  resolveJiraOauthIdentity,
} from './jira-oauth-connect';

/**
 * `JiraOauthConnectService` end to end (SPEC §7.26, issue #226) against
 * stubbed Atlassian 3LO endpoints (never the real API — see the PR
 * description for exactly what remains unverified against real
 * Atlassian): proves the redirect-code exchange, the `accessible-
 * resources` multi-site discovery, persisting the user's site choice as
 * one `ConnectedAccount` per site, transparent refresh on an expired
 * token, and — the correctness property duplicated per-site token
 * storage would break — that a refresh performed while resolving ONE
 * site's credential is immediately visible to a SIBLING site's next
 * credential resolution, with no second refresh call.
 */

const CLIENT_ID = 'jira-oauth-app-client-id';
const CLIENT_SECRET = 'jira-oauth-app-client-secret-never-synced';
const ACCESS_TOKEN_1 = 'atlassian-access-token-1-never-synced';
const REFRESH_TOKEN_1 = 'atlassian-refresh-token-1-never-synced';
const ACCESS_TOKEN_2 = 'atlassian-access-token-2-after-refresh-never-synced';
const REFRESH_TOKEN_2 = 'atlassian-refresh-token-2-after-refresh-never-synced';
const AUTH_CODE = 'the-callback-authorization-code';
const REDIRECT_URI = 'https://node.example.com/jira/oauth/callback';
const BASE_TIME = 1_700_000_000_000;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function tokenSuccessBody(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    access_token: ACCESS_TOKEN_1,
    refresh_token: REFRESH_TOKEN_1,
    expires_in: 3600,
    scope: JIRA_OAUTH_SCOPES.join(' '),
    ...overrides,
  };
}

function siteA(): Record<string, unknown> {
  return {
    id: 'cloud-id-site-a',
    url: 'https://team-a.atlassian.net',
    name: 'Team A',
    scopes: ['read:jira-work', 'write:jira-work'],
    avatarUrl: 'https://avatar.example.com/team-a.png',
  };
}

function siteB(): Record<string, unknown> {
  return {
    id: 'cloud-id-site-b',
    url: 'https://team-b.atlassian.net',
    name: 'Team B',
    scopes: ['read:jira-work'],
  };
}

function identityBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    account_type: 'atlassian',
    account_id: 'atlassian-account-ada',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    picture: 'https://avatar.example.com/ada.png',
    ...overrides,
  };
}

interface JiraOauthFetchStub {
  fetchImpl: typeof fetch;
  tokenCallBodies: Record<string, unknown>[];
  accessibleResourcesCalls: number;
  identityCalls: number;
}

/** Routes by URL, exactly like `./jira-connect.test.ts`'s `stubJiraFetch` — the whole point being that no test here ever reaches a real Atlassian endpoint. `tokenResponses` is consumed in call order, so a test can hand back the exchange result first and the refresh result second. */
function stubJiraOauthFetch(options: {
  tokenResponses?: Response[];
  accessibleResources?: Response;
  identity?: Response;
}): JiraOauthFetchStub {
  const tokenResponses = options.tokenResponses ?? [jsonResponse(200, tokenSuccessBody())];
  const accessibleResources = options.accessibleResources ?? jsonResponse(200, [siteA()]);
  const identity = options.identity ?? jsonResponse(200, identityBody());

  const stub: JiraOauthFetchStub = {
    fetchImpl: async () => {
      throw new Error('unreachable');
    },
    tokenCallBodies: [],
    accessibleResourcesCalls: 0,
    identityCalls: 0,
  };

  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://auth.atlassian.com/oauth/token') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      stub.tokenCallBodies.push(body);
      const response = tokenResponses[stub.tokenCallBodies.length - 1];
      if (!response) {
        throw new Error(
          `stubJiraOauthFetch: unexpected token call #${stub.tokenCallBodies.length}`,
        );
      }
      return response;
    }
    if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
      stub.accessibleResourcesCalls += 1;
      return accessibleResources;
    }
    if (url === 'https://api.atlassian.com/me') {
      stub.identityCalls += 1;
      return identity;
    }
    throw new Error(`stubJiraOauthFetch: unexpected URL ${url}`);
  };
  stub.fetchImpl = impl;

  return stub;
}

let stateDir: string;
let fakeNow: number;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-jira-oauth-connect-test-'));
  fakeNow = BASE_TIME;
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function service(fetchImpl: typeof fetch): JiraOauthConnectService {
  return new JiraOauthConnectService({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl,
    now: () => fakeNow,
  });
}

describe('JiraOauthConnectService.discoverSites / connectSites (SPEC §7.26, issue #226)', () => {
  it('happy path: exchanges the code, discovers one site, and registers one oauth_3lo ConnectedAccount', async () => {
    const stub = stubJiraOauthFetch({});
    const svc = service(stub.fetchImpl);

    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });
    expect(discovery.sites).toHaveLength(1);
    expect(discovery.identity.accountId).toBe('atlassian-account-ada');

    const [account] = await svc.connectSites({ discovery, cloudIds: ['cloud-id-site-a'] });

    expect(account.provider).toBe('jira');
    expect(account.host).toBe('team-a.atlassian.net');
    expect(account.providerAccountId).toBe('atlassian-account-ada');
    expect(account.id).toBe('jira:team-a.atlassian.net:atlassian-account-ada');
    expect(account.label).toBe('Ada Lovelace');
    expect(account.avatarUrl).toBe('https://avatar.example.com/ada.png');
    expect(account.credentialSource).toBe('oauth_3lo');
    expect(account.scopes).toEqual([...JIRA_OAUTH_SCOPES]);
    expect(account.capabilities).toEqual(
      expect.arrayContaining(['comments', 'transitions', 'boards', 'sprints']),
    );

    // Exactly one token call (the exchange) — connecting never refreshes.
    expect(stub.tokenCallBodies).toHaveLength(1);
    expect(stub.tokenCallBodies[0]).toMatchObject({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: AUTH_CODE,
      redirect_uri: REDIRECT_URI,
    });

    // Neither the raw access token, refresh token, nor client secret is
    // ever assigned to any field of the ConnectedAccount returned.
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain(ACCESS_TOKEN_1);
    expect(serialized).not.toContain(REFRESH_TOKEN_1);
    expect(serialized).not.toContain(CLIENT_SECRET);
  });

  it('multi-site account: one consent registers two sites as two separate ConnectedAccount rows', async () => {
    const stub = stubJiraOauthFetch({
      accessibleResources: jsonResponse(200, [siteA(), siteB()]),
    });
    const svc = service(stub.fetchImpl);

    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });
    expect(discovery.sites).toHaveLength(2);

    const accounts = await svc.connectSites({
      discovery,
      cloudIds: ['cloud-id-site-a', 'cloud-id-site-b'],
    });

    expect(accounts).toHaveLength(2);
    expect(accounts[0].id).not.toBe(accounts[1].id);
    expect(accounts[0].host).toBe('team-a.atlassian.net');
    expect(accounts[1].host).toBe('team-b.atlassian.net');
    // Same underlying Atlassian identity for both rows.
    expect(accounts[0].providerAccountId).toBe(accounts[1].providerAccountId);

    const credentialA = await svc.getCredential(accounts[0]);
    const credentialB = await svc.getCredential(accounts[1]);
    expect(credentialA?.baseUrl).toBe('https://api.atlassian.com/ex/jira/cloud-id-site-a');
    expect(credentialB?.baseUrl).toBe('https://api.atlassian.com/ex/jira/cloud-id-site-b');
    expect(credentialA?.authHeader).toBe(`Bearer ${ACCESS_TOKEN_1}`);
    expect(credentialB?.authHeader).toBe(`Bearer ${ACCESS_TOKEN_1}`);

    // Only the one exchange call — resolving both sites' credentials did
    // not need another token call since neither is near expiry.
    expect(stub.tokenCallBodies).toHaveLength(1);
  });

  it('connectSites lets the caller register only a subset of the discovered sites', async () => {
    const stub = stubJiraOauthFetch({
      accessibleResources: jsonResponse(200, [siteA(), siteB()]),
    });
    const svc = service(stub.fetchImpl);
    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });

    const accounts = await svc.connectSites({ discovery, cloudIds: ['cloud-id-site-b'] });

    expect(accounts).toHaveLength(1);
    expect(accounts[0].host).toBe('team-b.atlassian.net');
  });

  it('rejects a cloudId that accessible-resources never returned, and persists nothing (not even the valid sites in the same call)', async () => {
    const stub = stubJiraOauthFetch({
      accessibleResources: jsonResponse(200, [siteA(), siteB()]),
    });
    const svc = service(stub.fetchImpl);
    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });

    await expect(
      svc.connectSites({ discovery, cloudIds: ['cloud-id-site-a', 'cloud-id-not-in-grant'] }),
    ).rejects.toBeInstanceOf(JiraOauthError);

    // Nothing was written for site A either, even though it was valid —
    // the whole selection is all-or-nothing.
    await expect(
      svc.getCredential({
        host: 'team-a.atlassian.net',
        secretRef: 'connected-account-token:jira:team-a.atlassian.net:atlassian-account-ada',
        credentialSource: 'oauth_3lo',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an empty cloudIds selection', async () => {
    const stub = stubJiraOauthFetch({});
    const svc = service(stub.fetchImpl);
    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });

    await expect(svc.connectSites({ discovery, cloudIds: [] })).rejects.toBeInstanceOf(
      JiraOauthError,
    );
  });

  it('discoverSites rejects when accessible-resources returns zero sites', async () => {
    const stub = stubJiraOauthFetch({ accessibleResources: jsonResponse(200, []) });
    const svc = service(stub.fetchImpl);

    await expect(
      svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI }),
    ).rejects.toBeInstanceOf(JiraOauthError);
  });
});

describe('JiraOauthConnectService.getCredential refresh (SPEC §7.26, issue #226)', () => {
  it('refreshes an expired token transparently and persists the rotated pair', async () => {
    const stub = stubJiraOauthFetch({
      tokenResponses: [
        jsonResponse(200, tokenSuccessBody()),
        jsonResponse(
          200,
          tokenSuccessBody({ access_token: ACCESS_TOKEN_2, refresh_token: REFRESH_TOKEN_2 }),
        ),
      ],
    });
    const svc = service(stub.fetchImpl);
    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });
    const [account] = await svc.connectSites({ discovery, cloudIds: ['cloud-id-site-a'] });

    const fresh = await svc.getCredential(account);
    expect(fresh?.authHeader).toBe(`Bearer ${ACCESS_TOKEN_1}`);
    expect(stub.tokenCallBodies).toHaveLength(1);

    // Advance past expiresAt (connected at BASE_TIME + 3600s TTL) into
    // the default 60s refresh-skew window.
    fakeNow = BASE_TIME + 3600 * 1000 - 30_000;

    const refreshed = await svc.getCredential(account);
    expect(refreshed?.authHeader).toBe(`Bearer ${ACCESS_TOKEN_2}`);
    expect(stub.tokenCallBodies).toHaveLength(2);
    expect(stub.tokenCallBodies[1]).toMatchObject({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN_1,
    });

    // A second call at the same instant reuses the just-refreshed token —
    // no redundant refresh.
    const again = await svc.getCredential(account);
    expect(again?.authHeader).toBe(`Bearer ${ACCESS_TOKEN_2}`);
    expect(stub.tokenCallBodies).toHaveLength(2);
  });

  it('a refresh triggered while resolving one site is immediately visible to its sibling site — no second refresh', async () => {
    const stub = stubJiraOauthFetch({
      accessibleResources: jsonResponse(200, [siteA(), siteB()]),
      tokenResponses: [
        jsonResponse(200, tokenSuccessBody()),
        jsonResponse(
          200,
          tokenSuccessBody({ access_token: ACCESS_TOKEN_2, refresh_token: REFRESH_TOKEN_2 }),
        ),
      ],
    });
    const svc = service(stub.fetchImpl);
    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });
    const [accountA, accountB] = await svc.connectSites({
      discovery,
      cloudIds: ['cloud-id-site-a', 'cloud-id-site-b'],
    });

    fakeNow = BASE_TIME + 3600 * 1000 - 30_000;

    const refreshedA = await svc.getCredential(accountA);
    expect(refreshedA?.authHeader).toBe(`Bearer ${ACCESS_TOKEN_2}`);
    expect(stub.tokenCallBodies).toHaveLength(2);

    // Site B was never itself refreshed, but shares the same underlying
    // grant secret, so it observes the rotated token with no additional
    // token-endpoint call — duplicating the pair per site would instead
    // make this either stale or an invalid_grant on B's own next refresh.
    const stillFreshB = await svc.getCredential(accountB);
    expect(stillFreshB?.authHeader).toBe(`Bearer ${ACCESS_TOKEN_2}`);
    expect(stillFreshB?.baseUrl).toBe('https://api.atlassian.com/ex/jira/cloud-id-site-b');
    expect(stub.tokenCallBodies).toHaveLength(2);
  });

  it('getCredential returns undefined for an account this node never connected', async () => {
    const stub = stubJiraOauthFetch({});
    const svc = service(stub.fetchImpl);

    await expect(
      svc.getCredential({
        host: 'myteam.atlassian.net',
        secretRef: 'connected-account-token:jira:myteam.atlassian.net:acc-nobody',
        credentialSource: 'oauth_3lo',
      }),
    ).resolves.toBeUndefined();
  });

  it('getCredential throws JiraOauthError for a non-oauth_3lo credentialSource', async () => {
    const stub = stubJiraOauthFetch({});
    const svc = service(stub.fetchImpl);

    await expect(
      svc.getCredential({
        host: 'myteam.atlassian.net',
        secretRef: 'connected-account-token:jira:myteam.atlassian.net:acc-ada',
        credentialSource: 'api_token',
      }),
    ).rejects.toBeInstanceOf(JiraOauthError);
  });

  it('deleteCredential removes only the disconnected site — its sibling (same grant) still resolves', async () => {
    const stub = stubJiraOauthFetch({
      accessibleResources: jsonResponse(200, [siteA(), siteB()]),
    });
    const svc = service(stub.fetchImpl);
    const discovery = await svc.discoverSites({ code: AUTH_CODE, redirectUri: REDIRECT_URI });
    const [accountA, accountB] = await svc.connectSites({
      discovery,
      cloudIds: ['cloud-id-site-a', 'cloud-id-site-b'],
    });

    await svc.deleteCredential(accountA);

    await expect(svc.getCredential(accountA)).resolves.toBeUndefined();
    await expect(svc.getCredential(accountB)).resolves.toMatchObject({
      authHeader: `Bearer ${ACCESS_TOKEN_1}`,
    });
  });
});

describe('buildJiraOauthAuthorizeUrl / JiraOauthConnectService.buildAuthorizeUrl (issue #226)', () => {
  it('builds the documented https://auth.atlassian.com/authorize URL with every required parameter', () => {
    const url = new URL(
      buildJiraOauthAuthorizeUrl({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        state: 'csrf-bound-state-value',
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe('https://auth.atlassian.com/authorize');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('csrf-bound-state-value');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...JIRA_OAUTH_SCOPES]);
  });

  it('service.buildAuthorizeUrl uses the configured client id and throws without one', () => {
    const stub = stubJiraOauthFetch({});
    const withClient = service(stub.fetchImpl);
    const url = new URL(withClient.buildAuthorizeUrl({ redirectUri: REDIRECT_URI, state: 's' }));
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);

    const withoutClient = new JiraOauthConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
      fetchImpl: stub.fetchImpl,
      clientId: undefined,
      clientSecret: undefined,
    });
    expect(() =>
      withoutClient.buildAuthorizeUrl({ redirectUri: REDIRECT_URI, state: 's' }),
    ).toThrow(JiraOauthError);
  });
});

describe('exchangeJiraOauthCode / refreshJiraOauthToken (issue #226)', () => {
  it('exchangeJiraOauthCode parses a valid token response', async () => {
    const stub = stubJiraOauthFetch({});
    const tokens = await exchangeJiraOauthCode({
      code: AUTH_CODE,
      redirectUri: REDIRECT_URI,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl: stub.fetchImpl,
      now: () => BASE_TIME,
    });
    expect(tokens.accessToken).toBe(ACCESS_TOKEN_1);
    expect(tokens.refreshToken).toBe(REFRESH_TOKEN_1);
    expect(tokens.expiresAt).toBe(BASE_TIME + 3600 * 1000);
    expect(tokens.grantedScopes).toEqual([...JIRA_OAUTH_SCOPES]);
  });

  it('rejects a token response missing refresh_token (offline_access was not actually granted)', async () => {
    const stub = stubJiraOauthFetch({
      tokenResponses: [jsonResponse(200, { access_token: ACCESS_TOKEN_1, expires_in: 3600 })],
    });
    await expect(
      exchangeJiraOauthCode({
        code: AUTH_CODE,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        fetchImpl: stub.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(JiraOauthError);
  });

  it('rejects a non-2xx token endpoint response', async () => {
    const stub = stubJiraOauthFetch({
      tokenResponses: [jsonResponse(403, { error: 'invalid_grant' })],
    });
    await expect(
      refreshJiraOauthToken({
        refreshToken: REFRESH_TOKEN_1,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        fetchImpl: stub.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(JiraOauthError);
  });
});

describe('listJiraAccessibleResources (issue #226)', () => {
  it('parses every {id, url, name, scopes, avatarUrl} entry', async () => {
    const stub = stubJiraOauthFetch({ accessibleResources: jsonResponse(200, [siteA(), siteB()]) });
    const sites = await listJiraAccessibleResources(ACCESS_TOKEN_1, stub.fetchImpl);
    expect(sites).toEqual([
      {
        cloudId: 'cloud-id-site-a',
        url: 'https://team-a.atlassian.net',
        name: 'Team A',
        scopes: ['read:jira-work', 'write:jira-work'],
        avatarUrl: 'https://avatar.example.com/team-a.png',
      },
      {
        cloudId: 'cloud-id-site-b',
        url: 'https://team-b.atlassian.net',
        name: 'Team B',
        scopes: ['read:jira-work'],
        avatarUrl: undefined,
      },
    ]);
  });

  it('rejects a response entry with no "id" field', async () => {
    const stub = stubJiraOauthFetch({
      accessibleResources: jsonResponse(200, [{ url: 'https://x.atlassian.net', name: 'X' }]),
    });
    await expect(
      listJiraAccessibleResources(ACCESS_TOKEN_1, stub.fetchImpl),
    ).rejects.toBeInstanceOf(JiraOauthError);
  });

  it('rejects a non-array response body', async () => {
    const stub = stubJiraOauthFetch({
      accessibleResources: jsonResponse(200, { not: 'an array' }),
    });
    await expect(
      listJiraAccessibleResources(ACCESS_TOKEN_1, stub.fetchImpl),
    ).rejects.toBeInstanceOf(JiraOauthError);
  });
});

describe('resolveJiraOauthIdentity (issue #226)', () => {
  it('resolves {accountId, displayName, avatarUrl} from GET /me', async () => {
    const stub = stubJiraOauthFetch({});
    const identity = await resolveJiraOauthIdentity(ACCESS_TOKEN_1, stub.fetchImpl);
    expect(identity).toEqual({
      accountId: 'atlassian-account-ada',
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://avatar.example.com/ada.png',
    });
  });

  it('rejects a response with no account_id', async () => {
    const stub = stubJiraOauthFetch({
      identity: jsonResponse(200, { name: 'Ada Lovelace' }),
    });
    await expect(resolveJiraOauthIdentity(ACCESS_TOKEN_1, stub.fetchImpl)).rejects.toBeInstanceOf(
      JiraOauthError,
    );
  });
});

describe('resolveJiraOauthClientId / resolveJiraOauthClientSecret (issue #226)', () => {
  it('read their env vars and are undefined when unset or empty', () => {
    expect(
      resolveJiraOauthClientId({ [JIRA_OAUTH_CLIENT_ID_ENV_VAR]: 'abc' } as NodeJS.ProcessEnv),
    ).toBe('abc');
    expect(resolveJiraOauthClientId({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      resolveJiraOauthClientId({ [JIRA_OAUTH_CLIENT_ID_ENV_VAR]: '' } as NodeJS.ProcessEnv),
    ).toBeUndefined();

    expect(
      resolveJiraOauthClientSecret({
        [JIRA_OAUTH_CLIENT_SECRET_ENV_VAR]: 'shh',
      } as NodeJS.ProcessEnv),
    ).toBe('shh');
    expect(resolveJiraOauthClientSecret({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
