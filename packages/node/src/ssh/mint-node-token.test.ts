import { afterEach, describe, expect, it } from 'vitest';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { mintNodeToken } from './mint-node-token';

/**
 * `mintNodeToken` against a REAL hermetic relay (`startRelay()`, no Better
 * Auth mounted — the relay's dev/hermetic bearer resolver treats any
 * non-empty bearer as its own accountId, exactly like
 * `packages/relay/src/node-token-routes.test.ts` and this package's own
 * `device-login.test.ts`), proving this node-side helper actually interops
 * with the relay's `POST /account/node-tokens` (issue #401/#398).
 */

let relay: StartedRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe('mintNodeToken (#401/#408)', () => {
  it("mints a fresh device token for this account using this node's own bearer", async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });

    const result = await mintNodeToken({
      relayUrl: relay.url,
      authToken: 'acct_1',
      label: 'devbox (auto-provisioned)',
    });

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(16);
    // The minted token is itself a usable bearer against the SAME endpoint
    // family (mirrors node-token-routes.test.ts's own "usable device token"
    // assertion) — confirming this isn't a stub/placeholder string.
    const listResponse = await fetch(
      `${relay.url.replace(/^ws/, 'http').replace(/\/ws$/, '')}/account/node-tokens`,
      {
        headers: { authorization: `Bearer ${result.token}` },
      },
    );
    expect(listResponse.status).toBe(200);
  });

  it('throws a clear error when the relay rejects the bearer', async () => {
    relay = await startRelay({ host: '127.0.0.1', port: 0 });

    await expect(mintNodeToken({ relayUrl: relay.url, authToken: '', label: 'x' })).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it('throws a clear error on an unreachable relay', async () => {
    await expect(
      mintNodeToken({ relayUrl: 'ws://127.0.0.1:1/ws', authToken: 'acct_1' }),
    ).rejects.toThrow(/mintNodeToken/);
  });
});
