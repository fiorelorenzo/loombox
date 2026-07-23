import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { runDeviceLogin } from './device-login';

/**
 * `runDeviceLogin` against a REAL hermetic relay (`startRelay()`, no
 * Postgres/Better Auth — the relay's `/device/*` routes are registered
 * unconditionally, see `packages/relay/src/relay.ts`), proving this
 * package's client half actually interops with the relay's server half
 * (issue #387): prints the operator instructions, polls until approved, and
 * returns the minted device token. The operator-approval step itself is
 * simulated by hitting the relay's own `/device/approve` directly with a
 * bearer (exactly what `apps/web`'s `/device` page will do), never a UI.
 */

let relay: StartedRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

function relayHttpUrl(url: string): string {
  return url.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

async function approveViaRelay(httpUrl: string, userCode: string, bearer: string): Promise<void> {
  const response = await fetch(`${httpUrl}/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ user_code: userCode }),
  });
  if (!response.ok) throw new Error(`test setup: approve failed with ${response.status}`);
}

describe('runDeviceLogin (#387)', () => {
  it('prints the user_code/verification_uri, polls until approved, and returns the minted device token', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });
    const httpUrl = relayHttpUrl(relay.url);
    const printed: string[] = [];
    let userCodeSeen: string | undefined;

    const loginPromise = runDeviceLogin({
      relayUrl: relay.url,
      print: (line) => printed.push(line),
      sleep: async () => {
        // The first poll always reports authorization_pending (nothing has
        // approved yet) — approve on this first "tick" so the very next
        // poll succeeds, keeping the test fast without a real interval wait.
        if (!userCodeSeen) {
          const match = printed.join('\n').match(/Enter code: ([A-Z0-9-]+)/);
          userCodeSeen = match?.[1];
          if (userCodeSeen) await approveViaRelay(httpUrl, userCodeSeen, 'acct_1');
        }
      },
    });

    const result = await loginPromise;
    expect(typeof result.accessToken).toBe('string');
    expect(result.accessToken.length).toBeGreaterThan(32);
    expect(printed.some((line) => line.includes('Enter code:'))).toBe(true);
    expect(printed.some((line) => line.includes('Open:'))).toBe(true);
    expect(printed.some((line) => line.includes('authorized'))).toBe(true);
  });

  it('throws a clear error when the operator denies the request', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });
    const httpUrl = relayHttpUrl(relay.url);
    let userCode: string | undefined;

    const loginPromise = runDeviceLogin({
      relayUrl: relay.url,
      print: (line) => {
        const match = line.match(/Enter code: ([A-Z0-9-]+)/);
        if (match) userCode = match[1];
      },
      sleep: async () => {
        if (userCode) {
          await fetch(`${httpUrl}/device/deny`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer acct_1' },
            body: JSON.stringify({ user_code: userCode }),
          });
        }
      },
    });

    await expect(loginPromise).rejects.toThrow(/denied/);
  });

  it('throws a clear error on timeout, without ever approving', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });

    // Simulate an already-past deadline by fetching the authorize response
    // through a fetchImpl that rewrites expires_in to 0, so the poll loop's
    // `while (Date.now() < deadline)` never runs a single iteration.
    const realFetch = fetch;
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await realFetch(input, init);
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/device/authorize')) {
        const body = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, expires_in: 0 }), {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    };

    await expect(
      runDeviceLogin({
        relayUrl: relay.url,
        fetchImpl,
        print: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('reuses a custom sleep for the poll interval, and stops as soon as authorization_pending flips to a token', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });
    const httpUrl = relayHttpUrl(relay.url);
    const sleep = vi.fn(async () => {});

    let userCode: string | undefined;
    const loginPromise = runDeviceLogin({
      relayUrl: relay.url,
      print: (line) => {
        const match = line.match(/Enter code: ([A-Z0-9-]+)/);
        if (match) userCode = match[1];
      },
      sleep: async (...args: Parameters<typeof sleep>) => {
        await sleep(...args);
        if (userCode) {
          await approveViaRelay(httpUrl, userCode, 'acct_1');
          userCode = undefined; // approve only once
        }
      },
    });

    await loginPromise;
    expect(sleep.mock.calls.length).toBeGreaterThan(0);
  });
});
