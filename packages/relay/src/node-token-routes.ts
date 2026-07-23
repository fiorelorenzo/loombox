import type { FastifyInstance } from 'fastify';

import type { BearerAccountResolver } from './device-auth-routes';
import { mintDeviceToken } from './device-auth';
import type { RelayStore } from './store';

/** A caller-supplied node-token label is free text (SPEC has no format for it) but bounded, so a pathological client can't grow an unbounded string into every future audit-log line and listing response. */
const MAX_LABEL_LENGTH = 200;

function isMintBody(body: unknown): body is { label?: unknown } {
  if (body === undefined || body === null) return true;
  return typeof body === 'object';
}

function parseLabel(body: unknown): { ok: true; label: string | undefined } | { ok: false } {
  if (!isMintBody(body)) return { ok: false };
  const candidate = (body as { label?: unknown }).label;
  if (candidate === undefined) return { ok: true, label: undefined };
  if (typeof candidate !== 'string') return { ok: false };
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return { ok: true, label: undefined };
  if (trimmed.length > MAX_LABEL_LENGTH) return { ok: false };
  return { ok: true, label: trimmed };
}

/**
 * The zero-touch, authenticated node-token endpoints (issue #398). North
 * star: an already-signed-in app (a Better Auth bearer, or itself a
 * relay-native device token — both resolve through the same
 * `accountIdFromBearer` every other authenticated REST route in this
 * package uses) mints a node-scoped bearer for its OWN account in one call,
 * with no RFC 8628 `user_code` human-approval round trip (`device-auth-
 * routes.ts` keeps that flow for the standalone-node case). The human
 * checkpoint this removes moves to a single in-app confirmation the app UI
 * builds later, not here — SPEC §8's trust-model note is mitigated instead
 * by the server-side audit log line every mint emits below, and by these
 * tokens being individually labeled/listable/revocable.
 *
 * Reuses `mintDeviceToken` (`device-auth.ts`) — the exact same store write
 * and hashing `/device/approve` uses — so there is one token scheme, not a
 * second one invented for this endpoint; a token minted here is
 * indistinguishable, once issued, from one minted via the device-
 * authorization grant.
 */
export function registerNodeTokenRoutes(
  app: FastifyInstance,
  store: RelayStore,
  accountIdFromBearer: BearerAccountResolver,
): void {
  app.post('/account/node-tokens', async (request, reply) => {
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });

    const parsedLabel = parseLabel(request.body);
    if (!parsedLabel.ok) {
      return reply.code(400).send({ error: 'label must be a string of reasonable length' });
    }

    const now = Date.now();
    const { id, rawToken } = await mintDeviceToken(store, accountId, parsedLabel.label, now);

    // #398 trust-model mitigation: every node-token mint is logged
    // server-side (accountId, label, timestamp, caller) since this path has
    // no human-visibility checkpoint of its own — see this file's own doc
    // comment. `device-auth-routes.ts`'s `/device/approve` logs its own mint
    // the same way.
    app.log.info(
      {
        accountId,
        callerAccountId: accountId,
        label: parsedLabel.label,
        tokenId: id,
        source: 'authenticated_mint',
      },
      'relay: minted a node token',
    );

    return reply.code(201).send({
      id,
      token: rawToken,
      label: parsedLabel.label,
      createdAt: now,
    });
  });

  // Metadata-only listing (#398's "revocability") — id/label/createdAt/
  // lastUsedAt, never the token or its hash, mirroring `store.ts`'s
  // `DeviceTokenStore.listForAccount` doc comment.
  app.get('/account/node-tokens', async (request, reply) => {
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });

    const tokens = await store.deviceTokens.listForAccount(accountId);
    return reply.code(200).send({
      tokens: tokens.map((token) => ({
        id: token.id,
        label: token.label,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      })),
    });
  });

  // Account-scoped revoke: `store.deviceTokens.revoke` refuses to delete a
  // token id that belongs to a different account, so caller A can never
  // revoke caller B's token even by guessing/reusing an id.
  app.delete('/account/node-tokens/:id', async (request, reply) => {
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });

    const { id } = request.params as { id: string };
    const revoked = await store.deviceTokens.revoke(id, accountId);
    if (!revoked) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
