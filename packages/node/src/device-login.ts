import { relayHttpBaseUrl } from './resolve-account-id';

/** The relay's `POST /device/authorize` response shape (`@loombox/relay`'s `device-auth-routes.ts`). */
interface AuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

/** The relay's `POST /device/token` error-body shape while a poll hasn't succeeded yet. */
interface TokenErrorBody {
  error?: string;
}

export interface RunDeviceLoginOptions {
  /** This node's configured relay URL (ws(s)://...) — the same one it will connect to once logged in. */
  relayUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Where the operator-facing instructions (the user_code + verification_uri) are printed; defaults to `console.log`. */
  print?: (line: string) => void;
}

export interface DeviceLoginResult {
  accessToken: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs this node's device-authorization login (issue #387, `gh auth
 * login`-shaped): calls the relay's `POST /device/authorize`, prints the
 * `user_code`/`verification_uri` the operator needs to open in a signed-in
 * browser tab, then polls `POST /device/token` at the server-given
 * `interval` until the operator approves (returns the minted device token),
 * denies, or the code expires (both throw a clear `Error`).
 *
 * Never talks to Better Auth or holds a browser session itself — this is
 * the whole point of the device-authorization grant (SPEC §16's RFC 8628
 * grounding note): a headless node obtains its own relay-native bearer
 * without ever needing a browser locally.
 */
export async function runDeviceLogin(options: RunDeviceLoginOptions): Promise<DeviceLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const print = options.print ?? ((line: string) => console.log(line));
  const baseUrl = relayHttpBaseUrl(options.relayUrl);

  const authorizeResponse = await fetchImpl(`${baseUrl}/device/authorize`, { method: 'POST' });
  if (!authorizeResponse.ok) {
    throw new Error(
      `device login: ${baseUrl}/device/authorize responded with HTTP ${authorizeResponse.status}`,
    );
  }
  const authorized = (await authorizeResponse.json()) as AuthorizeResponse;

  print('');
  print('loombox: this node needs to be linked to your account.');
  print(`  1. Open: ${authorized.verification_uri_complete ?? authorized.verification_uri}`);
  print(`  2. Enter code: ${authorized.user_code}`);
  print('');

  let intervalMs = Math.max(authorized.interval, 1) * 1000;
  const deadline = Date.now() + authorized.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const tokenResponse = await fetchImpl(`${baseUrl}/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: authorized.device_code }),
    });

    if (tokenResponse.ok) {
      const body = (await tokenResponse.json()) as { access_token: string };
      print('loombox: device authorized.');
      return { accessToken: body.access_token };
    }

    const errorBody = (await tokenResponse.json().catch(() => undefined)) as
      TokenErrorBody | undefined;
    const error = errorBody?.error;

    if (error === 'authorization_pending') continue;
    // Not a real server response today (the relay never sends slow_down),
    // but handling it costs nothing and keeps this client RFC 8628-compliant
    // if that's ever added.
    if (error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (error === 'denied') {
      throw new Error('device login: the operator denied this device');
    }
    if (error === 'expired') {
      throw new Error('device login: the code expired before it was approved');
    }
    throw new Error(
      `device login: ${baseUrl}/device/token responded with HTTP ${tokenResponse.status}` +
        (error ? ` (${error})` : ''),
    );
  }

  throw new Error('device login: timed out waiting for operator approval');
}
