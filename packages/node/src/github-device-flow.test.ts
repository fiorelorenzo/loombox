import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_CONNECT_SCOPES,
  GithubDeviceFlowError,
  runGithubDeviceFlow,
  type GithubDeviceCodeInfo,
} from './github-device-flow';

/**
 * `runGithubDeviceFlow` against a fully stubbed `fetchImpl` (issue #222's
 * acceptance: never hit the real GitHub API from a test) and a fake clock
 * (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`, never a real
 * `sleep`) — proving the four real RFC 8628 states GitHub's token endpoint
 * returns, plus cancellation, are all handled by actually waiting the right
 * amount of time rather than by luck or a lenient retry loop.
 */

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deviceCodeBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    device_code: 'the-device-code',
    user_code: 'WDJB-MJHT',
    verification_uri: 'https://github.com/login/device',
    verification_uri_complete: 'https://github.com/login/device?user_code=WDJB-MJHT',
    expires_in: 900,
    interval: 5,
    ...overrides,
  };
}

const CLIENT_ID = 'public-oauth-app-client-id';

describe('runGithubDeviceFlow (SPEC §7.26, issue #222)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests exactly the four required scopes and no client secret, and reports the user code', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, deviceCodeBody()));
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'gho_secret',
        token_type: 'bearer',
        scope: 'repo,read:user,read:org,read:project',
      }),
    );

    let seenUserCode: GithubDeviceCodeInfo | undefined;
    const resultPromise = runGithubDeviceFlow({
      clientId: CLIENT_ID,
      fetchImpl,
      onUserCode: (info) => {
        seenUserCode = info;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await resultPromise;
    expect(result.accessToken).toBe('gho_secret');
    expect(result.grantedScope).toBe('repo,read:user,read:org,read:project');

    expect(seenUserCode?.userCode).toBe('WDJB-MJHT');
    expect(seenUserCode?.verificationUri).toBe('https://github.com/login/device');

    const [codeUrl, codeInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(codeUrl).toBe('https://github.com/login/device/code');
    const codeBody = JSON.parse(codeInit.body as string) as Record<string, unknown>;
    expect(codeBody.client_id).toBe(CLIENT_ID);
    expect(codeBody.scope).toBe('repo read:user read:org read:project');
    expect(codeBody).toEqual({ client_id: CLIENT_ID, scope: GITHUB_CONNECT_SCOPES.join(' ') });
    expect(JSON.stringify(codeBody)).not.toContain('secret');

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(tokenUrl).toBe('https://github.com/login/oauth/access_token');
    const tokenBody = JSON.parse(tokenInit.body as string) as Record<string, unknown>;
    expect(tokenBody).toEqual({
      client_id: CLIENT_ID,
      device_code: 'the-device-code',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(tokenBody.client_secret).toBeUndefined();
  });

  it('authorization_pending: keeps polling at the returned interval, not before it elapses', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, deviceCodeBody({ interval: 5 })));
    fetchImpl.mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }));
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'gho_secret', token_type: 'bearer', scope: 'repo' }),
    );

    const resultPromise = runGithubDeviceFlow({ clientId: CLIENT_ID, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the device-code call so far

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // interval hasn't elapsed yet

    await vi.advanceTimersByTimeAsync(1); // the 5000ms interval elapses
    expect(fetchImpl).toHaveBeenCalledTimes(2); // first poll: authorization_pending

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // still waiting out the same interval

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // second poll: success

    await expect(resultPromise).resolves.toMatchObject({ accessToken: 'gho_secret' });
  });

  it('slow_down: increases the interval to an explicit server-given value rather than retrying at the old cadence', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, deviceCodeBody({ interval: 5 })));
    fetchImpl.mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down', interval: 20 }));
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'gho_secret', token_type: 'bearer', scope: 'repo' }),
    );

    const resultPromise = runGithubDeviceFlow({ clientId: CLIENT_ID, fetchImpl });
    await vi.advanceTimersByTimeAsync(5000); // original 5s interval elapses
    expect(fetchImpl).toHaveBeenCalledTimes(2); // first poll: slow_down(interval: 20)

    await vi.advanceTimersByTimeAsync(19999);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the new 20s interval hasn't elapsed yet

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // second poll, after the full new interval

    await expect(resultPromise).resolves.toMatchObject({ accessToken: 'gho_secret' });
  });

  it("slow_down without an explicit interval: adds 5s to the previous interval (GitHub's documented default)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, deviceCodeBody({ interval: 5 })));
    fetchImpl.mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }));
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'gho_secret', token_type: 'bearer', scope: 'repo' }),
    );

    const resultPromise = runGithubDeviceFlow({ clientId: CLIENT_ID, fetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // first poll: slow_down, no interval field

    await vi.advanceTimersByTimeAsync(9999); // old 5s + the 5s slow_down bump = 10s
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await expect(resultPromise).resolves.toMatchObject({ accessToken: 'gho_secret' });
  });

  it('expired_token from GitHub itself: ends the flow with a named error', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, deviceCodeBody({ interval: 5 })));
    fetchImpl.mockResolvedValueOnce(jsonResponse(400, { error: 'expired_token' }));

    const resultPromise = runGithubDeviceFlow({ clientId: CLIENT_ID, fetchImpl });
    resultPromise.catch(() => {}); // attached immediately; the real assertion is below
    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).rejects.toBeInstanceOf(GithubDeviceFlowError);
    await expect(resultPromise).rejects.toMatchObject({ reason: 'expired_token' });
  });

  it('the operator simply walking away: the local expires_in deadline ends the flow with expired_token even if GitHub keeps saying authorization_pending', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, deviceCodeBody({ interval: 5, expires_in: 12 })),
    );
    fetchImpl.mockResolvedValue(jsonResponse(400, { error: 'authorization_pending' }));

    const resultPromise = runGithubDeviceFlow({ clientId: CLIENT_ID, fetchImpl });
    resultPromise.catch(() => {}); // attached immediately; the real assertion is below
    // Two 5s polls (10s) land inside the 12s window and both come back
    // pending; the third poll would fire at 15s, past the 12s deadline, so
    // the deadline check (not another HTTP error) is what ends this.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // device-code + 2 pending polls

    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).rejects.toMatchObject({ reason: 'expired_token' });
    // No third poll: the deadline is checked before waiting out the next
    // interval, not after another round-trip to GitHub.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('access_denied: ends the flow with a named error', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, deviceCodeBody({ interval: 5 })));
    fetchImpl.mockResolvedValueOnce(jsonResponse(400, { error: 'access_denied' }));

    const resultPromise = runGithubDeviceFlow({ clientId: CLIENT_ID, fetchImpl });
    resultPromise.catch(() => {}); // attached immediately; the real assertion is below
    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).rejects.toBeInstanceOf(GithubDeviceFlowError);
    await expect(resultPromise).rejects.toMatchObject({ reason: 'access_denied' });
  });

  it('cancelling stops the polling immediately, without waiting out the current interval', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, deviceCodeBody({ interval: 5 })));

    const resultPromise = runGithubDeviceFlow({
      clientId: CLIENT_ID,
      fetchImpl,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0); // device-code call settles; now waiting out the 5s interval

    controller.abort();
    await expect(resultPromise).rejects.toBeInstanceOf(GithubDeviceFlowError);
    await expect(resultPromise).rejects.toMatchObject({ reason: 'cancelled' });

    // Never polled: only the initial device-code request happened, proving
    // cancellation actually cut the wait short rather than the interval
    // just happening to be zero.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal cancels before any request is made', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runGithubDeviceFlow({ clientId: CLIENT_ID, fetchImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
