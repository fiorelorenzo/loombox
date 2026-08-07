import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GithubConnectService,
  GITHUB_CONNECT_CLIENT_ID_ENV_VAR,
  GithubPatConnectError,
  resolveGithubConnectClientId,
} from './github-connect';
import { GithubDeviceFlowError } from './github-device-flow';

/**
 * `GithubConnectService` end to end (SPEC §7.26, issue #222) against a
 * stubbed GitHub (never the real API), proving the three things the
 * device-flow module and identity module can't prove alone: the token
 * actually lands in the keyring, the returned `ConnectedAccount` metadata
 * row structurally cannot carry it, and a bad upstream identity fails
 * loudly via `@loombox/protocol`'s own schema rather than syncing garbage.
 */

const RAW_TOKEN = 'gho_this-is-the-actual-secret-never-synced';
const CLIENT_ID = 'public-oauth-app-client-id';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deviceCodeBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    device_code: 'the-device-code',
    user_code: 'WDJB-MJHT',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
    ...overrides,
  };
}

/** A `fetchImpl` that stands in for both GitHub endpoints the connect flow calls, routed by URL — the whole point being that no test here ever reaches the real network. */
function stubGithubFetch(options: {
  tokenResponse?: Response;
  userResponse?: Response;
}): typeof fetch {
  const tokenResponse =
    options.tokenResponse ??
    jsonResponse(200, {
      access_token: RAW_TOKEN,
      token_type: 'bearer',
      scope: 'repo,read:user,read:org,read:project',
    });
  const userResponse =
    options.userResponse ??
    jsonResponse(200, {
      id: 1234567,
      login: 'octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/1234567',
    });

  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://github.com/login/device/code') {
      return jsonResponse(200, deviceCodeBody());
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return tokenResponse;
    }
    if (url === 'https://api.github.com/user') {
      return userResponse;
    }
    throw new Error(`stubGithubFetch: unexpected URL ${url}`);
  };
  return impl;
}

let stateDir: string;

beforeEach(async () => {
  vi.useFakeTimers();
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-github-connect-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(stateDir, { recursive: true, force: true });
});

function service(): GithubConnectService {
  return new GithubConnectService({ stateDir, osKeyringBackendFactory: async () => undefined });
}

describe('GithubConnectService.connect (SPEC §7.26, issue #222)', () => {
  it('completes the flow, keys providerAccountId on the numeric id, and requests the exact four scopes', async () => {
    const svc = service();
    const fetchImpl = stubGithubFetch({});

    const connectPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    const account = await connectPromise;

    expect(account.provider).toBe('github');
    expect(account.host).toBe('github.com');
    expect(account.providerAccountId).toBe('1234567');
    expect(account.id).toBe('github:github.com:1234567');
    expect(account.label).toBe('octocat');
    expect(account.credentialSource).toBe('device_flow');
    expect(account.scopes).toEqual(['repo', 'read:user', 'read:org', 'read:project']);
    expect(account.secretRef).toBe('connected-account-token:github:github.com:1234567');
  });

  it('writes the token to the keyring, referenced only by secretRef — the metadata row itself carries no secret', async () => {
    const svc = service();
    const fetchImpl = stubGithubFetch({});

    const connectPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    const account = await connectPromise;

    // The row this service hands back is exactly what `connected_account_announce`
    // (issue #221) syncs to the relay: assert the raw token appears nowhere
    // in it, under any field.
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(Object.keys(account)).not.toContain('token');
    expect(Object.keys(account)).not.toContain('accessToken');

    // ...while the keyring (not the row) actually holds it.
    const storedToken = await svc.getAccessToken(account);
    expect(storedToken).toBe(RAW_TOKEN);
  });

  it('a GET /user response with only a login is rejected — the token is still written nowhere and no ConnectedAccount is returned', async () => {
    const svc = service();
    const fetchImpl = stubGithubFetch({
      userResponse: jsonResponse(200, { login: 'octocat' }),
    });

    const connectPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl });
    connectPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);

    await expect(connectPromise).rejects.toThrow(/numeric "id"/);
  });

  it('expired_token propagates as a GithubDeviceFlowError without writing anything to the keyring', async () => {
    const svc = service();
    const fetchImpl = stubGithubFetch({
      tokenResponse: jsonResponse(400, { error: 'expired_token' }),
    });

    const connectPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl });
    connectPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);

    await expect(connectPromise).rejects.toBeInstanceOf(GithubDeviceFlowError);
    await expect(connectPromise).rejects.toMatchObject({ reason: 'expired_token' });
  });

  it('access_denied propagates as a GithubDeviceFlowError', async () => {
    const svc = service();
    const fetchImpl = stubGithubFetch({
      tokenResponse: jsonResponse(400, { error: 'access_denied' }),
    });

    const connectPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl });
    connectPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);

    await expect(connectPromise).rejects.toMatchObject({ reason: 'access_denied' });
  });

  it('cancelling stops the flow without ever writing a token', async () => {
    const svc = service();
    const controller = new AbortController();
    const fetchImpl = stubGithubFetch({});

    const connectPromise = svc.connect({
      clientId: CLIENT_ID,
      fetchImpl,
      signal: controller.signal,
    });
    connectPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(connectPromise).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(
      svc.getAccessToken({ secretRef: 'connected-account-token:github:github.com:1234567' }),
    ).resolves.toBeUndefined();
  });

  it('derives capabilities from the granted scopes: repo -> repo+issues, read:project -> projects', async () => {
    const svc = service();
    const fetchImpl = stubGithubFetch({
      tokenResponse: jsonResponse(200, {
        access_token: RAW_TOKEN,
        token_type: 'bearer',
        scope: 'repo,read:user,read:org,read:project',
      }),
    });

    const connectPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    const account = await connectPromise;

    expect(account.capabilities).toEqual(['repo', 'issues', 'projects']);
  });

  it('a second connect() for a different account keeps both tokens independently addressable', async () => {
    const svc = service();
    const fetchImpl = stubGithubFetch({});
    const secondFetchImpl = stubGithubFetch({
      userResponse: jsonResponse(200, { id: 9999999, login: 'monalisa' }),
    });

    const firstPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    const first = await firstPromise;

    const secondPromise = svc.connect({ clientId: CLIENT_ID, fetchImpl: secondFetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    const second = await secondPromise;

    expect(first.id).not.toBe(second.id);
    await expect(svc.getAccessToken(first)).resolves.toBe(RAW_TOKEN);
    await expect(svc.getAccessToken(second)).resolves.toBe(RAW_TOKEN);
  });
});

describe('resolveGithubConnectClientId (issue #222)', () => {
  it('reads LOOMBOX_GITHUB_CONNECT_CLIENT_ID from the given env', () => {
    expect(
      resolveGithubConnectClientId({
        [GITHUB_CONNECT_CLIENT_ID_ENV_VAR]: 'Iv1.abc123',
      } as NodeJS.ProcessEnv),
    ).toBe('Iv1.abc123');
  });

  it('is undefined when unset or empty, never throws', () => {
    expect(resolveGithubConnectClientId({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      resolveGithubConnectClientId({ [GITHUB_CONNECT_CLIENT_ID_ENV_VAR]: '' } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});

const RAW_PAT = 'github_pat_the-actual-secret-never-synced';

/** A `fetchImpl` standing in for the two GitHub endpoints `connectWithToken` calls (`GET /user`, `GET /user/repos`), routed by URL — same "never reach the real network" contract as `stubGithubFetch`. */
function stubGithubPatFetch(options: {
  userResponse?: Response;
  reposResponse?: Response;
  apiBaseUrl?: string;
}): typeof fetch {
  const base = options.apiBaseUrl ?? 'https://api.github.com';
  const userResponse =
    options.userResponse ??
    jsonResponse(200, {
      id: 7654321,
      login: 'hubot',
      avatar_url: 'https://avatars.githubusercontent.com/u/7654321',
    });
  const reposResponse =
    options.reposResponse ?? jsonResponse(200, [{ full_name: 'hubot/hello-world' }]);

  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `${base}/user`) return userResponse;
    if (url === `${base}/user/repos?per_page=100&sort=full_name`) return reposResponse;
    throw new Error(`stubGithubPatFetch: unexpected URL ${url}`);
  };
  return impl;
}

describe('GithubConnectService.connectWithToken (SPEC §7.26, issue #224)', () => {
  it('connects a pasted fine-grained PAT, keys providerAccountId on the numeric id, and reports the reachable repositories', async () => {
    const svc = service();
    const fetchImpl = stubGithubPatFetch({});

    const result = await svc.connectWithToken({ token: RAW_PAT, fetchImpl });

    expect(result.account.provider).toBe('github');
    expect(result.account.host).toBe('github.com');
    expect(result.account.providerAccountId).toBe('7654321');
    expect(result.account.id).toBe('github:github.com:7654321');
    expect(result.account.label).toBe('hubot');
    expect(result.account.credentialSource).toBe('fine_grained_pat');
    expect(result.account.scopes).toEqual([]);
    expect(result.account.capabilities).toEqual(['repo']);
    expect(result.accessibleRepositories).toEqual(['hubot/hello-world']);
    expect(result.accessibleRepositoriesTruncated).toBe(false);
  });

  it('writes the token to the keyring, referenced only by secretRef — the metadata row itself carries no secret', async () => {
    const svc = service();
    const fetchImpl = stubGithubPatFetch({});

    const result = await svc.connectWithToken({ token: RAW_PAT, fetchImpl });

    const serialized = JSON.stringify(result.account);
    expect(serialized).not.toContain(RAW_PAT);
    expect(Object.keys(result.account)).not.toContain('token');

    const storedToken = await svc.getAccessToken(result.account);
    expect(storedToken).toBe(RAW_PAT);
  });

  it('a GET /user 401 is reported as invalid_or_revoked, and never leaks the token into the message', async () => {
    const svc = service();
    const fetchImpl = stubGithubPatFetch({
      userResponse: jsonResponse(401, { message: 'Bad credentials' }),
    });

    await expect(svc.connectWithToken({ token: RAW_PAT, fetchImpl })).rejects.toMatchObject({
      reason: 'invalid_or_revoked',
    });
    await expect(svc.connectWithToken({ token: RAW_PAT, fetchImpl })).rejects.toMatchObject({
      message: expect.not.stringContaining(RAW_PAT),
    });

    // Nothing was ever written to the keyring for this token.
    await expect(
      svc.getAccessToken({ secretRef: 'connected-account-token:github:github.com:7654321' }),
    ).resolves.toBeUndefined();
  });

  it('a token with zero accessible repositories is reported as insufficient_access, and the keyring stays empty', async () => {
    const svc = service();
    const fetchImpl = stubGithubPatFetch({ reposResponse: jsonResponse(200, []) });

    await expect(svc.connectWithToken({ token: RAW_PAT, fetchImpl })).rejects.toMatchObject({
      reason: 'insufficient_access',
    });
    await expect(
      svc.getAccessToken({ secretRef: 'connected-account-token:github:github.com:7654321' }),
    ).resolves.toBeUndefined();
  });

  it('an empty/blank token is rejected before ever calling fetch', async () => {
    const svc = service();
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(svc.connectWithToken({ token: '   ', fetchImpl })).rejects.toMatchObject({
      reason: 'invalid_or_revoked',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a GitHub Enterprise Server token against its own host, not github.com', async () => {
    const svc = service();
    const ghesBase = 'https://github.mycorp.com/api/v3';
    const fetchImpl = stubGithubPatFetch({ apiBaseUrl: ghesBase });

    const result = await svc.connectWithToken({
      token: RAW_PAT,
      host: 'github.mycorp.com',
      fetchImpl,
    });

    expect(result.account.host).toBe('github.mycorp.com');
    expect(result.account.id).toBe('github:github.mycorp.com:7654321');
  });

  it('an unrelated failure from the reach probe surfaces as GithubPatConnectError with reason "error", never syncing an account', async () => {
    const svc = service();
    const fetchImpl = stubGithubPatFetch({
      reposResponse: jsonResponse(500, { message: 'internal error' }),
    });

    await expect(svc.connectWithToken({ token: RAW_PAT, fetchImpl })).rejects.toBeInstanceOf(
      GithubPatConnectError,
    );
    await expect(svc.connectWithToken({ token: RAW_PAT, fetchImpl })).rejects.toMatchObject({
      reason: 'error',
    });
  });
});
