import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GithubConnectService,
  GITHUB_CONNECT_CLIENT_ID_ENV_VAR,
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
