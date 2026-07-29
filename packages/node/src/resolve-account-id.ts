import { ConfigError } from './config';

/**
 * Resolves this node's `authToken` to the `accountId` it belongs to. The token
 * is whatever bearer the relay accepts: usually a relay-native device token
 * this node minted for itself (#387/#398), or a Better Auth session (SPEC §8).
 * Injected as `StartOptions.resolveAccountId` (`main.ts`) so tests never have
 * to make a real network call; production uses
 * {@link resolveAccountIdViaRelay}, the real HTTP-backed implementation below.
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
 * The real, HTTP-backed {@link AccountIdResolver} (issue #380). Asks the relay
 * itself, via `GET /account`, which account the presented bearer belongs to.
 *
 * That endpoint is the only correct place to ask, because the relay accepts
 * more than one kind of bearer and only it knows the whole set: a
 * relay-native device token (#387's approval grant, #398's zero-touch mint),
 * a Better Auth session, or - on a relay deliberately run without Postgres -
 * the dev stub. `GET /account` resolves all of them through the exact same
 * `resolveAccountId` the WS handshake uses, so a node always agrees with the
 * relay about which account it is, and the relay's own
 * `session.accountId !== connection.accountId` check never drops a real
 * session.
 *
 * This used to call Better Auth's `/api/auth/get-session` directly, which
 * knows about browser sessions and nothing else. The result was that a node
 * which bootstrapped the intended way - `device-login.ts`, operator approves
 * a code in the browser, token persisted - then died on startup complaining
 * its token was "not a valid, active Better Auth session", while holding a
 * token the relay accepted on the WS seconds later. The only way through was
 * setting `LOOMBOX_ACCOUNT_ID` by hand, defeating the point of the flow.
 *
 * Never falls back to any stub value: an unreachable relay, a non-2xx
 * response, or a token the relay does not recognize (missing, expired,
 * revoked, never issued) all throw a {@link ConfigError} rather than let the
 * node start up scoped to the wrong account.
 */
export async function resolveAccountIdViaRelay(
  relayUrl: string,
  authToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = relayHttpBaseUrl(relayUrl);
  const url = `${base}/account`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${authToken}` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`could not resolve accountId: request to ${url} failed: ${message}`);
  }

  // A relay older than this node has no `/account` route. Self-hosters
  // upgrade the two independently, so fall back to the Better Auth session
  // lookup this function used to do rather than break a working deployment.
  // That path cannot resolve a device token, which is why it is the fallback
  // and not the primary.
  if (response.status === 404) {
    return resolveAccountIdViaBetterAuthSession(base, authToken, fetchImpl);
  }

  if (!response.ok) {
    throw new ConfigError(
      `could not resolve accountId: ${url} responded with HTTP ${response.status}` +
        (response.status === 401
          ? ' - the relay does not recognize this authToken (LOOMBOX_AUTH_TOKEN). If it was' +
            ' minted for a different relay, or has been revoked, delete the persisted' +
            ' device token and let the node link again.'
          : ''),
    );
  }

  const accountId = await readAccountId(response, url);
  if (accountId === undefined) {
    throw new ConfigError(`could not resolve accountId: ${url} returned no accountId`);
  }
  return accountId;
}

/**
 * The pre-`GET /account` resolution, kept only for a relay older than this
 * node (see the 404 branch above). Reads `user.id` out of Better Auth's
 * `GET /api/auth/get-session`, so it works for a browser session token and
 * fails for every relay-native device token.
 */
async function resolveAccountIdViaBetterAuthSession(
  base: string,
  authToken: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const url = `${base}/api/auth/get-session`;

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

  let userId: unknown;
  if (body !== null && typeof body === 'object' && 'user' in body) {
    const user = body.user;
    if (user !== null && typeof user === 'object' && 'id' in user) userId = user.id;
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ConfigError(
      'could not resolve accountId: this relay is too old to expose GET /account, and the ' +
        'authToken (LOOMBOX_AUTH_TOKEN) is not a valid, active Better Auth session either - ' +
        'upgrade the relay so device tokens resolve, or set LOOMBOX_ACCOUNT_ID explicitly',
    );
  }

  return userId;
}

/** Reads `accountId` out of a JSON response body, or `undefined` when the body is not an object or the field is absent/empty. */
async function readAccountId(response: Response, url: string): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConfigError(`could not resolve accountId: ${url} did not return valid JSON`);
  }
  if (body === null || typeof body !== 'object' || !('accountId' in body)) return undefined;
  const value = body.accountId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
