import { describe, expect, it, vi } from 'vitest';

import { approveDevice, denyDevice } from './device-approve';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe('approveDevice (#387)', () => {
  it('POSTs the user_code as a Bearer-authenticated request to /device/approve, and reports approved on 2xx', async () => {
    const fetchImpl = fakeFetch(200, { status: 'approved' });

    const result = await approveDevice({
      relayBaseUrl: 'http://relay.test',
      authToken: 'bearer-token',
      userCode: 'WXYZ-2345',
      fetchImpl,
    });

    expect(result).toEqual({ status: 'approved' });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('http://relay.test/device/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bearer-token' },
      body: JSON.stringify({ user_code: 'WXYZ-2345' }),
    });
  });

  it('maps 401/404/410/409 to their respective outcomes', async () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthorized'],
      [404, 'invalid_code'],
      [410, 'expired'],
      [409, 'already_resolved'],
    ];
    for (const [status, expected] of cases) {
      const result = await approveDevice({
        relayBaseUrl: 'http://relay.test',
        authToken: 'bearer-token',
        userCode: 'WXYZ-2345',
        fetchImpl: fakeFetch(status, { error: 'whatever' }),
      });
      expect(result.status).toBe(expected);
    }
  });

  it('reports a generic error with the relay message for an unrecognized status', async () => {
    const result = await approveDevice({
      relayBaseUrl: 'http://relay.test',
      authToken: 'bearer-token',
      userCode: 'WXYZ-2345',
      fetchImpl: fakeFetch(500, { error: 'boom' }),
    });
    expect(result).toEqual({ status: 'error', message: 'boom' });
  });

  it('reports an error rather than throwing when the fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await approveDevice({
      relayBaseUrl: 'http://relay.test',
      authToken: 'bearer-token',
      userCode: 'WXYZ-2345',
      fetchImpl,
    });
    expect(result).toEqual({ status: 'error', message: 'network down' });
  });
});

describe('denyDevice (#387)', () => {
  it('POSTs to /device/deny, and reports denied on 2xx', async () => {
    const fetchImpl = fakeFetch(200, { status: 'denied' });

    const result = await denyDevice({
      relayBaseUrl: 'http://relay.test',
      authToken: 'bearer-token',
      userCode: 'WXYZ-2345',
      fetchImpl,
    });

    expect(result).toEqual({ status: 'denied' });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      'http://relay.test/device/deny',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
