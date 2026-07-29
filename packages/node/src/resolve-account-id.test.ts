import { describe, expect, it, vi } from 'vitest';

import { ConfigError } from './config';
import { resolveAccountIdViaRelay } from './resolve-account-id';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('resolveAccountIdViaRelay (issue #380)', () => {
  it("GETs the relay's own /account with the bearer token, and returns accountId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'user-abc-123' }));

    const accountId = await resolveAccountIdViaRelay(
      'wss://relay.loombox.dev/ws',
      'the-bearer-token',
      fetchImpl,
    );

    expect(accountId).toBe('user-abc-123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.loombox.dev/account');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer the-bearer-token');
  });

  // The regression this endpoint exists for: a node that linked itself through
  // the device-authorization flow holds a relay-native device token, which is
  // not a Better Auth session at all. Asking Better Auth about it used to fail
  // the node's startup outright while the relay would have accepted the very
  // same token on the WS handshake.
  it('resolves a token Better Auth knows nothing about, without ever asking Better Auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acct-from-node' }));

    const accountId = await resolveAccountIdViaRelay(
      'ws://127.0.0.1:8790/ws',
      'device-token-only-the-relay-knows',
      fetchImpl,
    );

    expect(accountId).toBe('acct-from-node');
    const calledUrls = fetchImpl.mock.calls.map((call) => call[0] as string);
    expect(calledUrls).toEqual(['http://127.0.0.1:8790/account']);
  });

  it('converts ws:// (not just wss://) to http://', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'user-1' }));

    await resolveAccountIdViaRelay('ws://127.0.0.1:8790/ws', 'tok', fetchImpl);

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8790/account');
  });

  it('falls back to Better Auth get-session when the relay is too old to expose /account', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(200, { session: { id: 'sess-1' }, user: { id: 'u-9' } }));

    const accountId = await resolveAccountIdViaRelay('ws://127.0.0.1:8790/ws', 'tok', fetchImpl);

    expect(accountId).toBe('u-9');
    const calledUrls = fetchImpl.mock.calls.map((call) => call[0] as string);
    expect(calledUrls).toEqual([
      'http://127.0.0.1:8790/account',
      'http://127.0.0.1:8790/api/auth/get-session',
    ]);
  });

  it('throws when neither /account nor the Better Auth fallback recognizes the token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { session: null, user: null }));

    await expect(
      resolveAccountIdViaRelay('ws://127.0.0.1:8790/ws', 'bad', fetchImpl),
    ).rejects.toThrow(ConfigError);
  });

  it('does not fall back on a 401: the relay answered, and its answer was no', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'invalid' }));

    await expect(
      resolveAccountIdViaRelay('ws://127.0.0.1:8790/ws', 'revoked', fetchImpl),
    ).rejects.toThrow(/HTTP 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws a ConfigError when the relay request itself fails (e.g. unreachable)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(resolveAccountIdViaRelay('ws://127.0.0.1:1/ws', 'tok', fetchImpl)).rejects.toThrow(
      ConfigError,
    );
    await expect(resolveAccountIdViaRelay('ws://127.0.0.1:1/ws', 'tok', fetchImpl)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('throws a ConfigError when the response body is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);

    await expect(
      resolveAccountIdViaRelay('ws://127.0.0.1:8790/ws', 'tok', fetchImpl),
    ).rejects.toThrow(/valid JSON/);
  });

  it('never returns the raw authToken as a fallback accountId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));

    await expect(
      resolveAccountIdViaRelay('ws://127.0.0.1:8790/ws', 'the-token-itself', fetchImpl),
    ).rejects.toThrow(ConfigError);
  });
});
