import type { FastifyInstance } from 'fastify';

import {
  DEFAULT_APP_URL,
  DEVICE_AUTH_EXPIRES_IN_SECONDS,
  DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  generateDeviceCode,
  generateDeviceTokenSecret,
  generateUserCode,
  hashDeviceSecret,
  normalizeUserCode,
} from './device-auth';
import type { RelayStore } from './store';

/** Resolves an `Authorization: Bearer <token>` header to an accountId, or `undefined` — the same shape `relay.ts`'s own `accountIdFromBearer` closure already has; passed in rather than imported to avoid a circular module dependency (`relay.ts` is what registers these routes). */
export type BearerAccountResolver = (
  header: string | string[] | undefined,
) => Promise<string | undefined>;

export interface DeviceAuthRoutesOptions {
  /** The app's own origin (`LOOMBOX_APP_URL`, `main.ts`) — `verification_uri` is built from this. Defaults to {@link DEFAULT_APP_URL}. */
  appUrl?: string;
}

/** How many times {@link registerDeviceAuthRoutes}'s `/device/authorize` retries on a freshly-generated `user_code` colliding with a still-live pending request — astronomically unlikely (32^8 codes over a 10-minute window), but never silently overwrite a live request rather than retry. */
const USER_CODE_COLLISION_RETRIES = 5;

function isUserCodeBody(body: unknown): body is { user_code: string } {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = (body as Record<string, unknown>).user_code;
  return typeof candidate === 'string' && candidate.length > 0;
}

function isDeviceCodeBody(body: unknown): body is { device_code: string } {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = (body as Record<string, unknown>).device_code;
  return typeof candidate === 'string' && candidate.length > 0;
}

/**
 * The device-authorization-grant HTTP endpoints (issue #387, RFC 8628-shaped
 * — see `device-auth.ts`'s module doc comment): `/device/authorize` (the
 * node's opening call), `/device/approve`/`/device/deny` (the operator's
 * browser, authenticated), and `/device/token` (the node's poll). Registered
 * from `relay.ts`'s `createRelay` alongside the other REST routes — see that
 * file for why these three, not the WS wire protocol, are the right layer
 * (a resident node has no bearer yet when it calls `/device/authorize`, so
 * this can never be a `WireMessageV1`).
 */
export function registerDeviceAuthRoutes(
  app: FastifyInstance,
  store: RelayStore,
  accountIdFromBearer: BearerAccountResolver,
  opts: DeviceAuthRoutesOptions = {},
): void {
  const appUrl = (opts.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, '');

  app.post('/device/authorize', async (_request, reply) => {
    const deviceCode = generateDeviceCode();
    const deviceCodeHash = hashDeviceSecret(deviceCode);

    let userCode = generateUserCode();
    for (
      let attempt = 0;
      attempt < USER_CODE_COLLISION_RETRIES && (await store.deviceAuth.getByUserCode(userCode));
      attempt += 1
    ) {
      userCode = generateUserCode();
    }

    const now = Date.now();
    const expiresAt = now + DEVICE_AUTH_EXPIRES_IN_SECONDS * 1000;
    await store.deviceAuth.create({ deviceCodeHash, userCode, createdAt: now, expiresAt });

    return reply.code(200).send({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${appUrl}/device`,
      verification_uri_complete: `${appUrl}/device?user_code=${encodeURIComponent(userCode)}`,
      interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
      expires_in: DEVICE_AUTH_EXPIRES_IN_SECONDS,
    });
  });

  app.post('/device/approve', async (request, reply) => {
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });
    if (!isUserCodeBody(request.body)) {
      return reply.code(400).send({ error: 'user_code is required' });
    }
    const userCode = normalizeUserCode(request.body.user_code);
    const now = Date.now();

    const existing = await store.deviceAuth.getByUserCode(userCode);
    if (!existing) return reply.code(404).send({ error: 'invalid_user_code' });
    if (now > existing.expiresAt) return reply.code(410).send({ error: 'expired' });
    if (existing.status !== 'pending') {
      return reply.code(409).send({ error: `already_${existing.status}` });
    }

    const rawToken = generateDeviceTokenSecret();
    const tokenHash = hashDeviceSecret(rawToken);
    await store.deviceTokens.create({
      tokenHash,
      accountId,
      label: 'Resident node (device authorization)',
      createdAt: now,
    });

    const approved = await store.deviceAuth.approve(userCode, accountId, rawToken, now);
    if (!approved) {
      // Lost a race against a concurrent approve/deny/expiry between the
      // checks above and this call — the freshly-minted device token above
      // is simply never revealed to any node (no `pendingToken` references
      // it), so it's harmlessly orphaned rather than handed out twice.
      return reply.code(409).send({ error: 'could_not_approve' });
    }
    return reply.code(200).send({ status: 'approved' });
  });

  app.post('/device/deny', async (request, reply) => {
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });
    if (!isUserCodeBody(request.body)) {
      return reply.code(400).send({ error: 'user_code is required' });
    }
    const userCode = normalizeUserCode(request.body.user_code);
    const now = Date.now();

    const existing = await store.deviceAuth.getByUserCode(userCode);
    if (!existing) return reply.code(404).send({ error: 'invalid_user_code' });
    if (now > existing.expiresAt) return reply.code(410).send({ error: 'expired' });
    if (existing.status !== 'pending') {
      return reply.code(409).send({ error: `already_${existing.status}` });
    }

    const denied = await store.deviceAuth.deny(userCode, now);
    if (!denied) return reply.code(409).send({ error: 'could_not_deny' });
    return reply.code(200).send({ status: 'denied' });
  });

  app.post('/device/token', async (request, reply) => {
    if (!isDeviceCodeBody(request.body)) {
      return reply.code(400).send({ error: 'device_code is required' });
    }
    const deviceCodeHash = hashDeviceSecret(request.body.device_code);
    const record = await store.deviceAuth.getByDeviceCodeHash(deviceCodeHash);
    const now = Date.now();

    if (!record) return reply.code(400).send({ error: 'invalid_grant' });
    if (now > record.expiresAt) return reply.code(400).send({ error: 'expired' });
    if (record.status === 'denied') return reply.code(400).send({ error: 'denied' });
    if (record.status === 'pending') {
      return reply.code(400).send({ error: 'authorization_pending' });
    }
    // status === 'approved': `pendingToken` is `undefined` once a prior poll
    // already revealed it (one-time reveal) — treat a replay the same as an
    // expired grant rather than hand the token out twice.
    if (!record.pendingToken) return reply.code(400).send({ error: 'expired' });

    const accessToken = record.pendingToken;
    await store.deviceAuth.consumeToken(deviceCodeHash);
    return reply.code(200).send({ access_token: accessToken });
  });
}
