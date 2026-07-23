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
  it("GETs the relay's Better Auth /api/auth/get-session with the bearer token, and returns user.id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { session: { id: 'sess-1' }, user: { id: 'user-abc-123' } }),
      );

    const accountId = await resolveAccountIdViaRelay(
      'wss://relay.loombox.dev/ws',
      'the-bearer-token',
      fetchImpl,
    );

    expect(accountId).toBe('user-abc-123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.loombox.dev/api/auth/get-session');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer the-bearer-token');
  });

  it('converts ws:// (not just wss://) to http://', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { session: {}, user: { id: 'user-1' } }));

    await resolveAccountIdViaRelay('ws://127.0.0.1:8787/ws', 'tok', fetchImpl);

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8787/api/auth/get-session');
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

  it('throws a ConfigError on a non-2xx response (e.g. Better Auth not mounted on this relay)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));

    await expect(
      resolveAccountIdViaRelay('ws://127.0.0.1:8787/ws', 'tok', fetchImpl),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('throws a ConfigError when the session is null (invalid/expired/unrecognized token) rather than falling back to the raw token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, null));

    await expect(
      resolveAccountIdViaRelay('ws://127.0.0.1:8787/ws', 'bad-token', fetchImpl),
    ).rejects.toThrow(ConfigError);
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
      resolveAccountIdViaRelay('ws://127.0.0.1:8787/ws', 'tok', fetchImpl),
    ).rejects.toThrow(/valid JSON/);
  });

  it('never returns the raw authToken as a fallback accountId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { session: {}, user: {} }));

    await expect(
      resolveAccountIdViaRelay('ws://127.0.0.1:8787/ws', 'the-token-itself', fetchImpl),
    ).rejects.toThrow(ConfigError);
  });
});
