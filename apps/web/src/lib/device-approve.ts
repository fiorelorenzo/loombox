/**
 * Client-side calls for the device-authorization approval screen (issue
 * #387's `/device` route): approving or denying a resident node's
 * `user_code` against the relay's `POST /device/approve`/`POST
 * /device/deny`. Mirrors `push-notifications.ts`'s own shape (an injectable
 * `fetchImpl`, defaulting to the real global `fetch`, so the whole flow is
 * unit-testable in the `node` vitest environment without a real browser).
 */

export type DeviceApprovalOutcome =
  | { status: 'approved' }
  | { status: 'denied' }
  | { status: 'invalid_code' }
  | { status: 'expired' }
  | { status: 'already_resolved' }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string };

export interface DeviceApprovalOptions {
  /** The relay's HTTP(S) origin (same one `AuthStore`/`RelayClient` already point at). */
  relayBaseUrl: string;
  /** This browser's own Better Auth bearer — the same one every other authenticated relay call in this app uses. */
  authToken: string;
  /** The operator-typed (or query-string-prefilled) user_code; sent as-is, the relay normalizes it. */
  userCode: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

async function postDeviceAction(
  path: '/device/approve' | '/device/deny',
  options: DeviceApprovalOptions,
): Promise<DeviceApprovalOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.relayBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.authToken}`,
      },
      body: JSON.stringify({ user_code: options.userCode }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', message };
  }

  if (response.ok)
    return path === '/device/approve' ? { status: 'approved' } : { status: 'denied' };
  if (response.status === 401) return { status: 'unauthorized' };
  if (response.status === 404) return { status: 'invalid_code' };
  if (response.status === 410) return { status: 'expired' };
  if (response.status === 409) return { status: 'already_resolved' };

  const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  return { status: 'error', message: body?.error ?? `HTTP ${response.status}` };
}

/** Approves a pending device-authorization request (SPEC §387: "the operator approves it in the browser"). */
export function approveDevice(options: DeviceApprovalOptions): Promise<DeviceApprovalOutcome> {
  return postDeviceAction('/device/approve', options);
}

/** Denies a pending device-authorization request the operator doesn't recognize/trust. */
export function denyDevice(options: DeviceApprovalOptions): Promise<DeviceApprovalOutcome> {
  return postDeviceAction('/device/deny', options);
}
