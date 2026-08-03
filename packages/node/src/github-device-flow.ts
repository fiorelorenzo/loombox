/* ---------------------------------------------------------------------
 * The RFC 8628 device authorization grant against GitHub itself (SPEC
 * §7.26's "connect flow (default: OAuth App Device Authorization Grant)",
 * issue #222) — `POST /login/device/code`, then polling
 * `POST /login/oauth/access_token` with
 * `grant_type=urn:ietf:params:oauth:grant-type:device_code` until the
 * operator approves, denies, or the code expires.
 *
 * This is a distinct client from `./device-login.ts`'s device flow: that
 * one talks to loombox's own relay (`POST /device/authorize` /
 * `POST /device/token`, issue #387, this node linking itself to a loombox
 * account) and never touches GitHub. This module is the more-privileged,
 * separate credential SPEC §7.26 calls out ("connecting a GitHub account
 * here" vs. "logging into loombox") — same *shape* of flow (RFC 8628), two
 * unrelated authorization servers, two unrelated tokens. Deliberately not
 * shared code: GitHub's actual error vocabulary
 * (`authorization_pending`/`slow_down`/`expired_token`/`access_denied`) is
 * the real RFC 8628 set, while the relay's own `/device/token` today only
 * ever sends `authorization_pending`/`denied`/`expired` (see that module's
 * doc comment) — collapsing both into one client would either lose GitHub's
 * real states or invent states the relay doesn't have.
 *
 * Clean-room (AGENTS.md): built from RFC 8628 and GitHub's own device-flow
 * docs, not from emdash's `github-device-flow-service.ts` (SPEC §16 cites it
 * as design inspiration only).
 * --------------------------------------------------------------------- */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** The exact four scopes SPEC §7.26 / issue #222 require — `read:project` is new versus emdash, added for §7.10's Projects v2 support. Order is stable so a request body/log is deterministic. */
export const GITHUB_CONNECT_SCOPES = ['repo', 'read:user', 'read:org', 'read:project'] as const;

/** GitHub's `slow_down` error response adds 5 seconds to the last interval (GitHub's own docs); used only when the response itself carries no explicit `interval` to use instead. */
const SLOW_DOWN_INCREMENT_MS = 5000;

/** What a caller shows the operator right after GitHub returns the device/user code — never a secret, this is the whole point of the flow. */
export interface GithubDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  /** GitHub's optional pre-filled-code URL, when present, is the friendlier link to show. */
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface GithubDeviceFlowResult {
  accessToken: string;
  tokenType: string;
  /** Space-separated scopes GitHub actually granted — echoed back by the token endpoint; can differ from what was requested if an org restricts one. */
  grantedScope: string;
}

/** The three ways this flow ends without a token, each a distinct, named outcome (issue #222's acceptance: "end the flow with a named error"). `cancelled` covers a caller-initiated `signal` abort; the operator simply walking away past `expires_in` surfaces as `expired_token`, both from GitHub's own token endpoint and from this module's local deadline check (belt-and-suspenders in case GitHub never sends the error itself). */
export type GithubDeviceFlowFailureReason = 'expired_token' | 'access_denied' | 'cancelled';

export class GithubDeviceFlowError extends Error {
  readonly reason: GithubDeviceFlowFailureReason;
  constructor(reason: GithubDeviceFlowFailureReason, message: string) {
    super(message);
    this.name = 'GithubDeviceFlowError';
    this.reason = reason;
  }
}

export interface GithubDeviceFlowOptions {
  /**
   * A public GitHub OAuth App client id — no client secret is ever sent or
   * accepted anywhere in this module (SPEC §7.26: "safe to ship in an
   * open-source binary"). Deployment-configurable: see
   * `./github-connect.ts`'s `resolveGithubConnectClientId`, which is how a
   * caller actually obtains this value; this module itself stays agnostic
   * about where it came from.
   */
  clientId: string;
  /** Defaults to {@link GITHUB_CONNECT_SCOPES}; overridable only for tests — production callers should not narrow this (issue #222 requires exactly those four). */
  scopes?: readonly string[];
  /** Injectable for tests; defaults to the global `fetch`. Must never be pointed at a real GitHub endpoint from a test (issue #222's acceptance: stub only). */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Makes the poll cancellable (issue #222's acceptance): aborting rejects with a `GithubDeviceFlowError('cancelled', ...)` at the next wait boundary, without waiting out the remaining interval. */
  signal?: AbortSignal;
  /** Called exactly once, right after GitHub returns the device/user code — the operator-facing instructions a caller renders (CLI print, UI dialog, ...). */
  onUserCode?: (info: GithubDeviceCodeInfo) => void;
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Named once because both the immediate pre-flight check and `abortableSleep`'s two abort paths (already-aborted, aborts-while-waiting) must throw the exact same shape (issue #222: cancellation is a named error like the other three outcomes). */
function cancelledError(): GithubDeviceFlowError {
  return new GithubDeviceFlowError('cancelled', 'github device flow: cancelled');
}

/** Races an injectable `sleep` against `signal` aborting, so a cancellation lands immediately rather than waiting out the current poll interval — the property issue #222's acceptance tests with a fake clock, not by sleeping. */
function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(cancelledError());
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = (): void => reject(cancelledError());
  signal.addEventListener('abort', onAbort, { once: true });
  sleep(ms).then(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, reject);
  return promise;
}

interface GithubDeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface GithubAccessTokenSuccessBody {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GithubAccessTokenErrorBody {
  error?: string;
  error_description?: string;
  interval?: number;
}

/** Type guard, not a rename: narrows the token-endpoint's response union so the success branch below can read `.access_token` without a cast. */
function isSuccessBody(
  body: GithubAccessTokenSuccessBody | GithubAccessTokenErrorBody | undefined,
): body is GithubAccessTokenSuccessBody {
  return typeof (body as GithubAccessTokenSuccessBody | undefined)?.access_token === 'string';
}

/**
 * Runs the full RFC 8628 device authorization grant against GitHub (issue
 * #222): requests a device/user code, hands it to `onUserCode`, then polls
 * for the access token at the server-given `interval`, honoring
 * `expires_in` as the hard deadline. Handles every real state GitHub's
 * token endpoint returns:
 *
 * - `authorization_pending` — keep polling at the current interval.
 * - `slow_down` — increase the interval (GitHub: +5s; an explicit `interval`
 *   in the error body wins when present, per RFC 8628 §3.5) and keep going,
 *   never just retrying at the old cadence.
 * - `expired_token` (or the local `expires_in` deadline passing first,
 *   which also covers the operator simply never returning) — throws
 *   `GithubDeviceFlowError('expired_token', ...)`.
 * - `access_denied` — throws `GithubDeviceFlowError('access_denied', ...)`.
 * - `signal` aborting — throws `GithubDeviceFlowError('cancelled', ...)`
 *   immediately, without waiting out the in-flight interval.
 *
 * Never logs or interpolates the resulting token (or the short-lived
 * `device_code`) into any thrown error message.
 */
export async function runGithubDeviceFlow(
  options: GithubDeviceFlowOptions,
): Promise<GithubDeviceFlowResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const scopes = options.scopes ?? GITHUB_CONNECT_SCOPES;
  const signal = options.signal;

  if (signal?.aborted) throw cancelledError();

  const codeResponse = await fetchImpl(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: options.clientId, scope: scopes.join(' ') }),
    signal,
  });
  if (!codeResponse.ok) {
    throw new Error(
      `github device flow: ${DEVICE_CODE_URL} responded with HTTP ${codeResponse.status}`,
    );
  }
  const authorized = (await codeResponse.json()) as GithubDeviceCodeResponse;
  if (
    !authorized.device_code ||
    !authorized.user_code ||
    !authorized.verification_uri ||
    typeof authorized.expires_in !== 'number' ||
    typeof authorized.interval !== 'number'
  ) {
    throw new Error(
      `github device flow: ${DEVICE_CODE_URL} returned an incomplete response (missing device_code/user_code/verification_uri/expires_in/interval)`,
    );
  }

  options.onUserCode?.({
    userCode: authorized.user_code,
    verificationUri: authorized.verification_uri,
    verificationUriComplete: authorized.verification_uri_complete,
    expiresInSeconds: authorized.expires_in,
    intervalSeconds: authorized.interval,
  });

  let intervalMs = Math.max(authorized.interval, 1) * 1000;
  const deadline = Date.now() + authorized.expires_in * 1000;
  const deviceCode = authorized.device_code;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new GithubDeviceFlowError(
        'expired_token',
        'github device flow: the code expired before it was approved',
      );
    }
    await abortableSleep(sleep, intervalMs, signal);
    // Checked again here, not just at the top of the loop: the deadline
    // can fall *during* the sleep just above, and there is no point
    // spending a network round-trip on a poll GitHub would reject anyway.
    if (Date.now() >= deadline) {
      throw new GithubDeviceFlowError(
        'expired_token',
        'github device flow: the code expired before it was approved',
      );
    }

    const tokenResponse = await fetchImpl(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: options.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal,
    });
    const body = (await tokenResponse.json().catch(() => undefined)) as
      GithubAccessTokenSuccessBody | GithubAccessTokenErrorBody | undefined;

    if (tokenResponse.ok && isSuccessBody(body)) {
      return {
        accessToken: body.access_token,
        tokenType: body.token_type,
        grantedScope: body.scope,
      };
    }

    const error = (body as GithubAccessTokenErrorBody | undefined)?.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      const serverInterval = (body as GithubAccessTokenErrorBody | undefined)?.interval;
      intervalMs =
        typeof serverInterval === 'number'
          ? Math.max(serverInterval, 1) * 1000
          : intervalMs + SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    if (error === 'expired_token') {
      throw new GithubDeviceFlowError(
        'expired_token',
        'github device flow: the code expired before it was approved',
      );
    }
    if (error === 'access_denied') {
      throw new GithubDeviceFlowError(
        'access_denied',
        'github device flow: the operator denied this connection',
      );
    }
    throw new Error(
      `github device flow: ${ACCESS_TOKEN_URL} responded with HTTP ${tokenResponse.status}` +
        (error ? ` (${error})` : ''),
    );
  }
}
