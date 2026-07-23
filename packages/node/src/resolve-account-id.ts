import { ConfigError } from './config';

/**
 * Resolves this node's `authToken` (a Better Auth bearer token, SPEC §8) to
 * the `accountId` it belongs to. Injected as `StartOptions.resolveAccountId`
 * (`main.ts`) so tests never have to make a real network call; production
 * uses {@link resolveAccountIdViaRelay}, the real HTTP-backed implementation
 * below.
 */
export type AccountIdResolver = (relayUrl: string, authToken: string) => Promise<string>;

/**
 * `ws://host:port/ws` -> `http://host:port` (and `wss:` -> `https:`).
 * Mirrors `apps/web/src/routes/+page.svelte`'s own `relayHttpBaseUrl` (and
 * its copy in `apps/web/tests-e2e/harness/relay-harness.ts`) — the relay
 * serves Better Auth's `/api/auth/*` routes (and, per issue #387,
 * `/device/*`) over plain HTTP(S) on the same origin as its WS endpoint.
 * Exported so `device-login.ts` (this package) reuses this exact
 * implementation rather than adding yet another copy within the same
 * package boundary.
 */
export function relayHttpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

/**
 * The real, HTTP-backed {@link AccountIdResolver} (issue #380). Calls the
 * relay's Better Auth `GET /api/auth/get-session` with `authToken` as an
 * `Authorization: Bearer` header — the identical resolution
 * `packages/relay/src/auth.ts`'s `resolveAccountIdViaBetterAuth` performs
 * in-process server-side, and `apps/web/src/lib/auth-store.ts` performs the
 * same way over HTTP client-side — and returns the resolved `user.id`. A
 * node that goes through this function therefore always agrees with both
 * the relay and the web client on which account a session belongs to, so
 * the relay's own `session.accountId !== connection.accountId` check
 * (`packages/relay/src/relay.ts`) never drops a real session.
 *
 * Never falls back to any stub value: an unreachable relay, a non-2xx
 * response, or a token Better Auth doesn't recognize (missing, expired,
 * revoked, or simply never issued — "token wiring" is a separate, later
 * concern) all throw a {@link ConfigError} rather than let the node start up
 * scoped to the wrong account.
 */
export async function resolveAccountIdViaRelay(
  relayUrl: string,
  authToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${relayHttpBaseUrl(relayUrl)}/api/auth/get-session`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${authToken}` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`could not resolve accountId: request to ${url} failed: ${message}`);
  }

  if (!response.ok) {
    throw new ConfigError(
      `could not resolve accountId: ${url} responded with HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConfigError(`could not resolve accountId: ${url} did not return valid JSON`);
  }

  const userId =
    body !== null && typeof body === 'object' && 'user' in body
      ? (body as { user?: { id?: unknown } }).user?.id
      : undefined;

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ConfigError(
      'could not resolve accountId: authToken (LOOMBOX_AUTH_TOKEN) is not a valid, active ' +
        'Better Auth session — sign in again and update the token, or set LOOMBOX_ACCOUNT_ID ' +
        'explicitly if this relay intentionally runs without Better Auth',
    );
  }

  return userId;
}
