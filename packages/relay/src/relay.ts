import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket, { type WebSocket as WsWebSocket } from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  PROTOCOL_V1,
  initialize,
  negotiateVersion,
  safeParseWireMessageV1,
  type AmkEpochFetchResponse,
  type BlobDownloadResponse,
  type InitializeResult,
  type LeaseReleaseResult,
  type LeaseResult,
  type NewDeviceBootstrapResponse,
  type ResyncMarker,
  type SessionAnnounceV1,
  type SessionListV1,
  type SessionUpdateEnvelopeV1,
  type TargetList,
  type TargetListEntry,
  type WireMessageV1,
} from '@loombox/protocol';

import {
  deriveAccountIdStub,
  mountBetterAuth,
  resolveAccountIdViaBetterAuth,
  type RelayAuth,
} from './auth';
import { createInProcessFanOutBackend, type FanOutBackend } from './fanout';
import { BoundedClientOutbox, type OutboxItem } from './outbox';
import { createWebPushSender, type PushPayload, type PushSender } from './push';
import {
  createInMemoryRelayStore,
  envelopeByteSize,
  type RelayStore,
  type VapidKeyPair,
} from './store';

/**
 * Resolves the WS handshake's `authToken` to an `accountId`, or `undefined`
 * to reject the connection (#121). May return synchronously or via a
 * Promise — see `store.ts`'s `Awaitable` doc comment for why. Defaults to
 * {@link deriveAccountIdStub} (dev/hermetic mode); `main.ts` supplies
 * `resolveAccountIdViaBetterAuth` bound to a real Better Auth instance once
 * `DATABASE_URL` is configured.
 */
export type AccountResolver = (
  authToken: string,
) => string | undefined | Promise<string | undefined>;

/** Path the WS route is mounted on; both nodes and clients connect here. */
export const RELAY_WS_PATH = '/ws';

/**
 * Protocol versions this relay build understands. v1 only for now — the v0
 * relay this supersedes is superseded, not bridged; a v0-only peer fails
 * negotiation and is closed with an "update required" notice (#108).
 */
const RELAY_SUPPORTED_VERSIONS = [PROTOCOL_V1] as const;

/** What this relay build can do, echoed back in `initializeResult` (#108). Purely informational today. */
const RELAY_CAPABILITIES = [
  'devices',
  'targets',
  'sessions',
  'blobs',
  'resync',
  'presence',
] as const;

interface BaseConnection {
  socket: WsWebSocket;
  deviceId: string;
  accountId: string;
}

interface NodeConnection extends BaseConnection {
  kind: 'node';
  /** nodeId(s) this connection has announced as, via `target_announce`/`session_announce`. */
  nodeIds: Set<string>;
}

interface ClientConnection extends BaseConnection {
  kind: 'client';
  subscriptions: Set<string>;
  outbox: BoundedClientOutbox;
  /** One entry per subscribed sessionId — the {@link FanOutBackend}'s own unsubscribe function for this specific connection, released on disconnect (#97). */
  fanOutUnsubscribes: Map<string, () => void>;
}

type Connection = NodeConnection | ClientConnection;

interface Registry {
  nodes: Set<NodeConnection>;
  clients: Set<ClientConnection>;
  /** Live routing target for a nodeId — only ever the most recently connected owner. */
  nodeConnectionsByNodeId: Map<string, NodeConnection>;
}

function createRegistry(): Registry {
  return { nodes: new Set(), clients: new Set(), nodeConnectionsByNodeId: new Map() };
}

function sendJson(socket: WsWebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export interface CreateRelayOptions {
  logger?: boolean;
  /** Injectable for tests/Postgres swap; defaults to a fresh in-memory store per relay instance. */
  store?: RelayStore;
  /** Bounded per-client output-queue depth for `session_update` fan-out (SPEC §7.16, #98/#254). */
  maxClientQueueDepth?: number;
  /**
   * How the WS handshake's `authToken` resolves to an `accountId` (#121).
   * Defaults to {@link deriveAccountIdStub} — every existing hermetic test in
   * this package, and `scripts/v1-e2e-harness.mjs`, rely on that default
   * (any non-empty token accepted as its own account) and construct
   * `startRelay()`/`createRelay()` without this option.
   */
  resolveAccountId?: AccountResolver;
  /**
   * A Better Auth instance to mount at `/api/auth/*` on this Fastify
   * instance (#119). When supplied and `resolveAccountId` is not
   * explicitly given, the resolver defaults to validating bearer tokens
   * against this instance instead of the dev stub — see `main.ts` for the
   * production wiring.
   */
  auth?: RelayAuth;
  /**
   * Per-IP abuse protection for the public relay endpoint (#101, SPEC §8's
   * "public-relay abuse limits"): caps requests per IP per window across
   * every HTTP/upgrade route this Fastify instance serves — the WS upgrade
   * (`/ws`), and Better Auth's own routes when mounted — except `/health`,
   * which stays exempt (see that route's own comment). Defaults to
   * {@link DEFAULT_RATE_LIMIT_MAX}/{@link DEFAULT_RATE_LIMIT_WINDOW_MS}.
   */
  rateLimit?: {
    /** Max requests per IP per window. */
    max?: number;
    /** Window length — a number of milliseconds, or `@fastify/rate-limit`'s own duration-string format (e.g. `'1 minute'`). */
    timeWindow?: number | string;
  };
  /**
   * Per-account total ciphertext-storage budget in bytes — blobs plus
   * buffered resync-ring entries, the same two write paths #102's retention
   * CLI reclaims from (#101, SPEC §8's "storage-exhaustion cap"). A write
   * that would push the account over this is rejected (see
   * `envelopeByteSize`/the `blob_upload`/`session_update` handlers below);
   * it is never enforced retroactively here — see `prune.ts` for the
   * reclaim-what's-already-over-budget path. Defaults to
   * {@link DEFAULT_MAX_ACCOUNT_STORAGE_BYTES}.
   */
  maxAccountStorageBytes?: number;
  /**
   * How `session_update`/session-scoped control messages reach subscribed
   * clients (#97). Defaults to {@link createInProcessFanOutBackend} — a
   * same-process, synchronous stand-in that reproduces this relay's
   * pre-#97 direct-iteration fan-out exactly, for the single deployed
   * instance case. `main.ts` supplies a Redis-backed backend instead when
   * `REDIS_URL` is set, so multiple relay processes share one fan-out plane.
   */
  fanOutBackend?: FanOutBackend;
  /**
   * Self-owned Web Push (SPEC §7.11/§16, RFC 8291/8292; issues #161/#163).
   * Undefined disables the feature entirely (`/push/*` routes 404, and a
   * `permission_request` never triggers a push) — the shape every existing
   * hermetic test in this package and `scripts/v1-e2e-harness.mjs` already
   * rely on by constructing `startRelay()`/`createRelay()` without this
   * option. `main.ts` resolves `vapidKeys` once at boot (`push.ts`'s
   * `resolveVapidKeys`, generating + persisting on first setup) and passes
   * the result here — key resolution needs the store's own `Awaitable`
   * (genuinely async against Postgres), which `createRelay` itself, unlike
   * `startRelay`, deliberately stays synchronous to construct.
   */
  push?: {
    vapidKeys: VapidKeyPair;
    /** The VAPID JWT's `sub` claim (RFC 8292) — a `mailto:` address or `https:` URL identifying the relay operator. */
    subject: string;
    /** Defaults to {@link createWebPushSender} — injectable so #163's presence-aware delivery is testable without a real Web Push network call. */
    sender?: PushSender;
  };
  /**
   * Session-ownership lease TTL bounds (SPEC §9; issues #82/#104). A
   * `lease_request`'s own `ttlMs` (if any) is clamped into `[1, max]`, then
   * defaults to `default` when omitted entirely — the relay is always the
   * final authority on how long a grant actually lasts, never a bare
   * pass-through of whatever a node asks for. Defaults to
   * {@link DEFAULT_LEASE_TTL_MS}/{@link DEFAULT_MAX_LEASE_TTL_MS}; tests lower
   * both to keep expiry-then-grant assertions fast.
   */
  leaseTtlMs?: {
    default?: number;
    max?: number;
  };
}

const DEFAULT_MAX_CLIENT_QUEUE_DEPTH = 64;

/** Sane default for {@link CreateRelayOptions.rateLimit}'s `max` — generous enough for a single self-hoster's own devices reconnecting in a burst, tight enough to blunt a public-endpoint scan/enrollment flood (#101). */
export const DEFAULT_RATE_LIMIT_MAX = 120;
/** Sane default for {@link CreateRelayOptions.rateLimit}'s `timeWindow` (#101). */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
/** Sane default for {@link CreateRelayOptions.maxAccountStorageBytes} — 50 MiB (#101). */
export const DEFAULT_MAX_ACCOUNT_STORAGE_BYTES = 50 * 1024 * 1024;
/** Sane default for {@link CreateRelayOptions.leaseTtlMs}'s `default` — 30s, matching `packages/node/src/ssh/session-lease.ts`'s own historical local default (issues #82/#104). */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** Sane default for {@link CreateRelayOptions.leaseTtlMs}'s `max` — 5 minutes, long enough for a slow renew cycle to catch up, short enough that a crashed/misbehaving node's session becomes reclaimable in a bounded time even if it requested an enormous TTL. */
export const DEFAULT_MAX_LEASE_TTL_MS = 5 * 60_000;

/**
 * Builds the Fastify instance for the v1 relay: an in-memory, blind-router
 * WS fan-out between agent nodes and PWA clients (SPEC §5.3, §8, §16;
 * issue #315's locked v1 architecture). The relay never decrypts — every
 * session/resource payload it stores or forwards is an opaque
 * `EncryptedEnvelope`; it only ever indexes clear routing metadata
 * (`SessionMetaPublic`: id, nodeId, targetId, accountId, provider, seq).
 * Does not call `listen`; see {@link startRelay} for that.
 */
export function createRelay(opts: CreateRelayOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const registry = createRegistry();
  const store = opts.store ?? createInMemoryRelayStore();
  const maxClientQueueDepth = opts.maxClientQueueDepth ?? DEFAULT_MAX_CLIENT_QUEUE_DEPTH;
  const maxAccountStorageBytes = opts.maxAccountStorageBytes ?? DEFAULT_MAX_ACCOUNT_STORAGE_BYTES;
  const defaultLeaseTtlMs = opts.leaseTtlMs?.default ?? DEFAULT_LEASE_TTL_MS;
  const maxLeaseTtlMs = opts.leaseTtlMs?.max ?? DEFAULT_MAX_LEASE_TTL_MS;
  const fanOutBackend = opts.fanOutBackend ?? createInProcessFanOutBackend();
  const pushSender = opts.push ? (opts.push.sender ?? createWebPushSender()) : undefined;
  app.addHook('onClose', async () => {
    await fanOutBackend.close();
  });
  const resolveAccountId: AccountResolver =
    opts.resolveAccountId ??
    (opts.auth
      ? (authToken) => resolveAccountIdViaBetterAuth(opts.auth as RelayAuth, authToken)
      : deriveAccountIdStub);

  // #101: registered before any route, so its `onRequest` hook covers every
  // HTTP/upgrade request this instance serves (all Fastify hooks run ahead
  // of the WS upgrade — the `/ws` route below is no exception). `/health`
  // opts back out individually (see that route), since it's meant for an
  // external uptime prober hitting it far more often than any real device
  // would ever legitimately reconnect.
  app.register(fastifyRateLimit, {
    max: opts.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX,
    timeWindow: opts.rateLimit?.timeWindow ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  });

  if (opts.auth) mountBetterAuth(app, opts.auth);

  /** Current usage + incoming write, checked against `maxAccountStorageBytes` before any blob/ring-entry write (#101). */
  async function hasQuotaFor(accountId: string, incomingBytes: number): Promise<boolean> {
    const used = await store.quota.getUsageBytes(accountId);
    return used + incomingBytes <= maxAccountStorageBytes;
  }

  /** Direct, unbounded send — used for control/reply traffic that must never be dropped. */
  function sendDirect(connection: Connection, message: WireMessageV1): void {
    sendJson(connection.socket, message);
  }

  // #97: publishing goes through the fan-out backend rather than iterating
  // `registry.clients` directly — with the default in-process backend this
  // is exactly the old direct-iteration fan-out (see
  // `subscribeClientToSession` below for the other half: registering each
  // subscribed client's own delivery). With a Redis-backed backend, this is
  // what lets a client connected to a different relay process receive an
  // update whose owning node is connected here.
  function fanOutSessionUpdate(sessionId: string, item: OutboxItem): void {
    fanOutBackend.publish(sessionId, { kind: 'update', item });
  }

  /** Direct fan-out (no bounded queue) for lower-volume session-scoped control traffic (permission requests, blob refs, ...). */
  function fanOutDirect(sessionId: string, message: WireMessageV1): void {
    fanOutBackend.publish(sessionId, { kind: 'direct', message });
  }

  /**
   * Registers this client connection's own delivery for `sessionId` with
   * the fan-out backend (#97) — the other half of `fanOutSessionUpdate`/
   * `fanOutDirect` above. Idempotent: a client resuming the same session
   * twice does not double-subscribe. The registration is undone in
   * `dropConnection` on disconnect, which is also what releases the
   * backend's own channel subscription once the last local client for a
   * session goes away (see `FanOutBackend.subscribe`'s doc comment).
   */
  function subscribeClientToSession(client: ClientConnection, sessionId: string): void {
    if (client.subscriptions.has(sessionId)) return;
    client.subscriptions.add(sessionId);
    const unsubscribe = fanOutBackend.subscribe(sessionId, (payload) => {
      if (payload.kind === 'update') client.outbox.enqueue(payload.item);
      else sendDirect(client, payload.message);
    });
    client.fanOutUnsubscribes.set(sessionId, unsubscribe);
  }

  async function routeToOwningNode(sessionId: string, message: WireMessageV1): Promise<void> {
    const record = await store.sessions.get(sessionId);
    if (!record) {
      app.log.warn({ sessionId }, 'relay: message for unknown session');
      return;
    }
    const nodeConnection = registry.nodeConnectionsByNodeId.get(record.meta.nodeId);
    if (!nodeConnection) {
      app.log.warn({ sessionId, nodeId: record.meta.nodeId }, 'relay: owning node not connected');
      return;
    }
    sendDirect(nodeConnection, message);
  }

  /** True when `deviceId` (under `accountId`) currently has a live *client* connection — a node connection (the daemon side) never counts, only a PWA client "seeing it live" is what #163's presence check suppresses push for. */
  function hasLiveClientConnection(accountId: string, deviceId: string): boolean {
    for (const client of registry.clients) {
      if (client.accountId === accountId && client.deviceId === deviceId) return true;
    }
    return false;
  }

  /**
   * Presence-aware Web Push delivery (SPEC §7.11 "events go to the device
   * you are actively using, fall back to push on the others"; issues
   * #163/#170). Fires for every `PushPayload` kind visible to this blind
   * relay in cleartext-routable form: `'permission_required'` (from a real
   * `permission_request`) and, as of #170, `'awaiting_input'`/
   * `'session_outcome'` (from an `attention_hint`, mirroring that same
   * mechanism — see `push.ts`'s `PushPayload` doc comment for why CI/review
   * aren't reachable here yet). Never blocks/affects the live WS fan-out
   * this runs alongside; a delivery failure to one device's subscription is
   * logged and does not stop delivery to the account's other devices.
   */
  async function maybeSendAttentionPush(accountId: string, payload: PushPayload): Promise<void> {
    if (!pushSender || !opts.push) return;
    const subscriptions = await store.pushSubscriptions.listForAccount(accountId);
    for (const subscription of subscriptions) {
      // The device that's currently open/connected already sees this live
      // over the WS fan-out above — pushing to it too would just be a
      // redundant OS notification for something already on screen.
      if (hasLiveClientConnection(accountId, subscription.deviceId)) continue;
      try {
        const result = await pushSender.send(
          subscription,
          opts.push.vapidKeys,
          opts.push.subject,
          payload,
        );
        if (result.expired) {
          // The browser itself dropped this subscription (410/404) — self-clean
          // rather than keep trying it on every future attention event (#163).
          await store.pushSubscriptions.delete(accountId, subscription.deviceId);
        }
      } catch (error) {
        app.log.warn(
          { error, accountId, deviceId: subscription.deviceId, sessionId: payload.sessionId },
          'relay: push delivery failed',
        );
      }
    }
  }

  /** Closes every live connection registered under `deviceId`/`accountId`, e.g. on revoke (#112). */
  function closeConnectionsForDevice(deviceId: string, accountId: string): void {
    for (const node of registry.nodes) {
      if (node.deviceId === deviceId && node.accountId === accountId) {
        node.socket.close(4403, 'device revoked');
      }
    }
    for (const client of registry.clients) {
      if (client.deviceId === deviceId && client.accountId === accountId) {
        client.socket.close(4403, 'device revoked');
      }
    }
  }

  async function handleInitialize(
    socket: WsWebSocket,
    raw: string,
  ): Promise<Connection | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      app.log.warn('relay: dropped a non-JSON first frame');
      socket.close(4400, 'invalid frame');
      return undefined;
    }

    const candidate =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    if (candidate.type !== 'initialize') {
      app.log.warn({ type: candidate.type }, 'relay: first frame was not initialize');
      socket.close(4401, 'first frame must be initialize');
      return undefined;
    }

    const remoteVersion = candidate.protocolVersion;
    const negotiated = negotiateVersion(
      RELAY_SUPPORTED_VERSIONS,
      typeof remoteVersion === 'number' ? [remoteVersion] : [],
    );
    if (negotiated === null) {
      // #108: never silently drop an incompatible peer — tell it, then close.
      sendJson(socket, {
        type: 'update_required',
        message: `relay supports protocol version(s) ${RELAY_SUPPORTED_VERSIONS.join(', ')}`,
      });
      socket.close(4400, 'update required');
      return undefined;
    }

    const result = initialize.safeParse(parsed);
    if (!result.success) {
      app.log.warn({ issues: result.error.issues }, 'relay: invalid initialize payload');
      socket.close(4400, 'invalid initialize payload');
      return undefined;
    }
    const message = result.data;

    // #121: validate the bearer authToken (Better Auth-backed in production,
    // the dev/hermetic stub otherwise — see `resolveAccountId`'s construction
    // above) and reject/close on an invalid or absent token.
    const accountId = await resolveAccountId(message.authToken);
    if (!accountId) {
      app.log.warn('relay: rejected initialize with an invalid/absent auth token');
      socket.close(4401, 'invalid or missing auth token');
      return undefined;
    }

    const existingDevice = await store.devices.get(message.deviceId);
    if (existingDevice?.status === 'revoked') {
      socket.close(4403, 'device revoked');
      return undefined;
    }
    if (existingDevice && existingDevice.accountId !== accountId) {
      app.log.warn({ deviceId: message.deviceId }, 'relay: deviceId reused under another account');
      socket.close(4403, 'device/account mismatch');
      return undefined;
    }
    await store.devices.upsert({
      deviceId: message.deviceId,
      devicePublicKey: message.devicePublicKey,
      accountId,
    });

    const connection: Connection =
      message.role === 'node'
        ? { kind: 'node', socket, deviceId: message.deviceId, accountId, nodeIds: new Set() }
        : {
            kind: 'client',
            socket,
            deviceId: message.deviceId,
            accountId,
            subscriptions: new Set(),
            outbox: new BoundedClientOutbox((item, done) => {
              sendJson(socket, item);
              done();
            }, maxClientQueueDepth),
            fanOutUnsubscribes: new Map(),
          };

    if (connection.kind === 'node') registry.nodes.add(connection);
    else registry.clients.add(connection);

    const initResult: InitializeResult = {
      type: 'initialize_result',
      protocolVersion: PROTOCOL_V1,
      negotiatedVersion: negotiated,
      capabilities: [...RELAY_CAPABILITIES],
    };
    sendDirect(connection, initResult);
    return connection;
  }

  async function handleDeviceMessage(
    connection: Connection,
    message: WireMessageV1,
  ): Promise<boolean> {
    switch (message.type) {
      case 'device_register':
        await store.devices.upsert({
          deviceId: message.deviceId,
          devicePublicKey: message.devicePublicKey,
          label: message.label,
          accountId: connection.accountId,
        });
        return true;
      case 'device_revoke': {
        const device = await store.devices.get(message.deviceId);
        if (!device || device.accountId !== connection.accountId) {
          app.log.warn({ deviceId: message.deviceId }, 'relay: revoke for unknown/foreign device');
          return true;
        }
        // #116: the acting device's `newEpoch` must be exactly one past the
        // account's current epoch — the relay's own defense against a
        // stale/duplicate/out-of-order revoke setting a wrong epoch. A
        // mismatch rejects the *whole* revoke (nothing below runs): the
        // device stays registered and no envelope is stored, rather than
        // silently accepting an inconsistent epoch number.
        const advanced = await store.amkRotation.advanceEpoch(
          connection.accountId,
          message.newEpoch,
        );
        if (!advanced) {
          app.log.warn(
            { accountId: connection.accountId, newEpoch: message.newEpoch },
            'relay: device_revoke newEpoch is not exactly one past the account current epoch; rejecting',
          );
          return true;
        }
        await store.devices.revoke(message.deviceId);
        // Wrap-fan-out delivery (SPEC §8): park each surviving device's own
        // rewrapped-AMK-epoch envelope for it to fetch on next connect
        // (`amk_epoch_fetch_request` below). Defensively skips any entry
        // that targets the revoked device itself or a device this account
        // doesn't actually own, rather than trusting the sender's list
        // wholesale.
        for (const entry of message.rewrappedAmk) {
          if (entry.deviceId === message.deviceId) {
            app.log.warn(
              { deviceId: entry.deviceId },
              'relay: device_revoke rewrappedAmk entry targets the revoked device itself; ignoring',
            );
            continue;
          }
          const survivor = await store.devices.get(entry.deviceId);
          if (!survivor || survivor.accountId !== connection.accountId) {
            app.log.warn(
              { deviceId: entry.deviceId },
              'relay: device_revoke rewrappedAmk entry targets an unknown/foreign device; ignoring',
            );
            continue;
          }
          await store.amkRotation.putPending(connection.accountId, entry.deviceId, {
            epoch: message.newEpoch,
            fromDeviceId: connection.deviceId,
            envelope: entry.envelope,
          });
        }
        closeConnectionsForDevice(message.deviceId, connection.accountId);
        return true;
      }
      case 'device_rotate': {
        const device = await store.devices.get(message.deviceId);
        if (!device || device.accountId !== connection.accountId) {
          app.log.warn({ deviceId: message.deviceId }, 'relay: rotate for unknown/foreign device');
          return true;
        }
        await store.devices.rotate(message.deviceId, message.newDevicePublicKey);
        return true;
      }
      case 'amk_escrow':
        // SPEC §8 path 2 "recovery-code escrow": the relay only ever stores
        // this as an opaque base64 blob (`@loombox/crypto`'s
        // `packWrappedAmkForWire` output) — it never parses, decrypts, or
        // otherwise learns anything from it. Scoped to `connection.accountId`
        // (the OAuth-authenticated account from this connection's own
        // `initialize` handshake), never a client-supplied account id.
        await store.escrow.put(connection.accountId, message.wrappedAmk);
        return true;
      case 'new_device_bootstrap_request': {
        // A new device, having proven identity via OAuth alone (this
        // connection's own handshake), asks for its account's escrowed
        // wrapped-AMK blob. Scoped to `connection.accountId` exactly like
        // `amk_escrow` above — a device can only ever fetch its own
        // account's blob, never another account's.
        const wrappedAmk = await store.escrow.get(connection.accountId);
        if (!wrappedAmk) {
          app.log.warn(
            { accountId: connection.accountId },
            'relay: new_device_bootstrap_request but this account has never escrowed an AMK',
          );
          return true;
        }
        const response: NewDeviceBootstrapResponse = {
          type: 'new_device_bootstrap_response',
          protocolVersion: PROTOCOL_V1,
          wrappedAmk,
        };
        sendDirect(connection, response);
        return true;
      }
      case 'amk_epoch_fetch_request': {
        // #116: a surviving device, on reconnect, asks whether the relay is
        // holding a rewrapped-AMK-epoch envelope for it. Always answered for
        // *this connection's own* authenticated deviceId — `message.deviceId`
        // is never trusted for the actual lookup (only logged if it disagrees,
        // e.g. a stale client), so a spoofed `deviceId` in the request body
        // can never fetch another device's envelope. Still always replies
        // (never silently drops), since this is a request/response pair a
        // caller waits on, exactly like `new_device_bootstrap_request` above.
        if (message.deviceId !== connection.deviceId) {
          app.log.warn(
            { deviceId: message.deviceId, connectionDeviceId: connection.deviceId },
            "relay: amk_epoch_fetch_request deviceId does not match the requesting connection; answering for the connection's own device instead",
          );
        }
        const pending = await store.amkRotation.getPending(
          connection.accountId,
          connection.deviceId,
        );
        let responsePending: AmkEpochFetchResponse['pending'];
        if (pending) {
          // `fromDevicePublicKey` is looked up fresh from the device
          // registry here, never trusted from whatever the original
          // `device_revoke` sender claimed — the acting device's current
          // registered public key is the only one `unwrapAmkEpochForDevice`
          // can actually derive the right ECDH shared secret against.
          const fromDevice = await store.devices.get(pending.fromDeviceId);
          if (fromDevice && fromDevice.accountId === connection.accountId) {
            responsePending = {
              epoch: pending.epoch,
              fromDeviceId: pending.fromDeviceId,
              fromDevicePublicKey: fromDevice.devicePublicKey,
              envelope: pending.envelope,
            };
          } else {
            app.log.warn(
              { deviceId: connection.deviceId, fromDeviceId: pending.fromDeviceId },
              'relay: amk_epoch_fetch_request has a pending envelope whose wrapping device is no longer known; withholding',
            );
          }
        }
        const response: AmkEpochFetchResponse = {
          type: 'amk_epoch_fetch_response',
          protocolVersion: PROTOCOL_V1,
          deviceId: connection.deviceId,
          pending: responsePending,
        };
        sendDirect(connection, response);
        return true;
      }
      case 'new_device_bootstrap_response':
      case 'qr_pairing_request':
      case 'qr_pairing_response':
      case 'amk_epoch_fetch_response':
        // `new_device_bootstrap_response`/`amk_epoch_fetch_response` are only
        // ever relay->client (this relay's own replies above); QR pairing
        // (#113) is deliberately device-to-device over an out-of-band
        // channel with "no relay unwrap" (SPEC §8 path 1) and never needs
        // relay-side wiring at all. None of these are messages this relay
        // legitimately receives.
        app.log.warn({ type: message.type }, 'relay: unexpected inbound device-pairing message');
        return true;
      default:
        return false;
    }
  }

  // Serving an opaque blob back to the requester. Used by BOTH a client
  // (fetching an attachment the executing host produced) and a node/executing
  // host (fetching an attachment a client uploaded — #156): the relay stays
  // blind, it only matches the ciphertext blob to the requester's own account.
  async function handleBlobDownload(
    connection: Connection,
    message: Extract<WireMessageV1, { type: 'blob_download' }>,
  ): Promise<void> {
    const record = await store.sessions.get(message.sessionId);
    if (!record || record.meta.accountId !== connection.accountId) {
      app.log.warn(
        { sessionId: message.sessionId },
        'relay: blob_download for unknown/foreign session',
      );
      return;
    }
    const envelope = await store.blobs.download(`${message.sessionId}:${message.ref}`);
    if (!envelope) {
      app.log.warn({ sessionId: message.sessionId, ref: message.ref }, 'relay: blob not found');
      return;
    }
    const response: BlobDownloadResponse = {
      type: 'blob_download_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: message.sessionId,
      ref: message.ref,
      envelope,
    };
    sendDirect(connection, response);
  }

  /** Clamps a `lease_request`'s optional `ttlMs` into `[1, maxLeaseTtlMs]`, defaulting to `defaultLeaseTtlMs` when omitted (issues #82/#104) — the relay is always the final authority on how long a grant actually lasts. */
  function resolveLeaseTtlMs(requested: number | undefined): number {
    const base = requested ?? defaultLeaseTtlMs;
    return Math.min(Math.max(base, 1), maxLeaseTtlMs);
  }

  /**
   * Session-ownership leasing (SPEC §9; issues #82/#104): a node acquires or
   * renews a session's lease, arbitrated by `store.leases` account-scoped to
   * this connection's own `accountId` (never a client-supplied one, exactly
   * like every other store lookup in this file). Always replies — a caller
   * is waiting on `requestId` — whether granted or denied.
   */
  async function handleLeaseRequest(
    connection: NodeConnection,
    message: Extract<WireMessageV1, { type: 'lease_request' }>,
  ): Promise<void> {
    const ttlMs = resolveLeaseTtlMs(message.ttlMs);
    const now = Date.now();
    const outcome =
      message.action === 'acquire'
        ? await store.leases.acquire(
            connection.accountId,
            message.sessionId,
            message.nodeId,
            ttlMs,
            now,
          )
        : await store.leases.renew(
            connection.accountId,
            message.sessionId,
            message.nodeId,
            ttlMs,
            now,
          );
    const response: LeaseResult = {
      type: 'lease_result',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      sessionId: message.sessionId,
      result: outcome.granted
        ? { outcome: 'granted', expiresAt: outcome.lease.expiresAt }
        : { outcome: 'denied', heldBy: outcome.heldBy, expiresAt: outcome.expiresAt },
    };
    sendDirect(connection, response);
  }

  /** A node deliberately releasing a lease it holds (session stop, node exit — SPEC §9). Account-scoped exactly like `handleLeaseRequest`. */
  async function handleLeaseRelease(
    connection: NodeConnection,
    message: Extract<WireMessageV1, { type: 'lease_release' }>,
  ): Promise<void> {
    const released = await store.leases.release(
      connection.accountId,
      message.sessionId,
      message.nodeId,
    );
    const response: LeaseReleaseResult = {
      type: 'lease_release_result',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      sessionId: message.sessionId,
      released,
    };
    sendDirect(connection, response);
  }

  async function handleNodeMessage(
    connection: NodeConnection,
    message: WireMessageV1,
  ): Promise<void> {
    if (await handleDeviceMessage(connection, message)) return;

    switch (message.type) {
      case 'target_announce': {
        store.targets.announce(message.nodeId, connection.accountId, message.targets);
        connection.nodeIds.add(message.nodeId);
        registry.nodeConnectionsByNodeId.set(message.nodeId, connection);
        return;
      }
      case 'session_announce': {
        if (message.session.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.session.id },
            'relay: session_announce account mismatch',
          );
          return;
        }
        await store.sessions.announce({
          meta: message.session,
          privateEnvelope: message.privateEnvelope,
        });
        connection.nodeIds.add(message.session.nodeId);
        registry.nodeConnectionsByNodeId.set(message.session.nodeId, connection);
        return;
      }
      case 'session_update': {
        const record = await store.sessions.get(message.sessionId);
        if (!record) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: session_update for unknown session',
          );
          return;
        }
        const seq = await store.sessions.nextSeq(message.sessionId);
        const finalized: SessionUpdateEnvelopeV1 = { ...message, seq };
        // #101: an over-quota account still gets its update fanned out live
        // (the relay's real-time delivery promise isn't gated on storage
        // headroom) — only the resync-ring *durability* of this update is
        // skipped, and the node is told so, since a client that reconnects
        // and asks to resync past this seq will not get it replayed.
        if (await hasQuotaFor(record.meta.accountId, envelopeByteSize(message.envelope))) {
          await store.sessions.pushRingEntry(
            message.sessionId,
            { seq, envelope: message.envelope },
            record.meta.accountId,
          );
        } else {
          app.log.warn(
            { accountId: record.meta.accountId, sessionId: message.sessionId, seq },
            'relay: ring entry not buffered for resync, account storage quota exceeded',
          );
          sendJson(connection.socket, {
            type: 'quota_exceeded',
            scope: 'session_update',
            sessionId: message.sessionId,
            seq,
          });
        }
        fanOutSessionUpdate(message.sessionId, finalized);
        return;
      }
      case 'permission_request':
        fanOutDirect(message.sessionId, message);
        // #163: presence-aware push — a tool call awaiting approval is one
        // of SPEC §7.11/§7.13's attention-worthy events, and `connection`
        // (the announcing node) always belongs to the same account the
        // session itself is scoped to.
        await maybeSendAttentionPush(connection.accountId, {
          kind: 'permission_required',
          sessionId: message.sessionId,
        });
        return;
      case 'attention_hint':
        // #170: the metadata-only mirror of the permission_request push
        // trigger above, for the two other attention-inbox classes that
        // have a live source at v1 (SPEC §7.13) — `awaiting_input` and
        // `session_outcome` (finished/errored). This message carries
        // nothing else: no `fanOutDirect` here, unlike `permission_request`,
        // because a client never needs to render this hint itself — it
        // already gets the real `session_status` transition, encrypted,
        // over the ordinary `session_update` fan-out this rides alongside.
        // This message exists solely to give the relay a trigger to push
        // on without ever decrypting that session_update.
        await maybeSendAttentionPush(connection.accountId, {
          kind: message.class,
          sessionId: message.sessionId,
        });
        return;
      case 'blob_ref':
        fanOutDirect(message.sessionId, message);
        return;
      case 'blob_download':
        // The executing host fetching an attachment blob a client uploaded (#156).
        await handleBlobDownload(connection, message);
        return;
      case 'fs_list_response':
        // The owning node's reply to a client's fs_list_request (SPEC §7.4;
        // issue #171/#160) — fanned out to this session's subscribed
        // clients exactly like blob_ref/permission_request above; the
        // relay never opens the envelope, so it never learns the path or
        // directory contents (SPEC §8's metadata boundary). A requesting
        // client matches its own pending request by `requestId`; any other
        // subscribed client simply has no pending request with that id.
        fanOutDirect(message.sessionId, message);
        return;
      case 'terminal_opened':
      case 'terminal_output':
      case 'terminal_closed':
        // The owning node's terminal replies/output/close notification
        // (SPEC §7.5; issues #172/#173/#174) — fanned out exactly like
        // fs_list_response above; the relay never opens any of these
        // envelopes, so it never sees a byte of typed input, shell output,
        // or even the negotiated cols/rows (SPEC §8's metadata boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'lease_request':
        // SPEC §9; issues #82/#104: a session is owned by a node, never a
        // client — only a node connection ever sends this.
        await handleLeaseRequest(connection, message);
        return;
      case 'lease_release':
        await handleLeaseRelease(connection, message);
        return;
      default:
        app.log.warn({ type: message.type }, 'relay: unexpected message from a node connection');
    }
  }

  async function handleClientMessage(
    connection: ClientConnection,
    message: WireMessageV1,
  ): Promise<void> {
    if (await handleDeviceMessage(connection, message)) return;

    switch (message.type) {
      case 'target_list_request': {
        // #383: account-scoped, exactly like session_list_request below —
        // `store.targets.listForAccount` only ever returns nodes whose
        // announcing connection's `accountId` matched this account, so one
        // account can never see another's nodes/targets. `reachable` is
        // true only while that nodeId still has a live relay connection
        // (`registry.nodeConnectionsByNodeId`); a node that announced then
        // disconnected still shows up (so a client can see it existed) but
        // as unreachable.
        const perNode = store.targets.listForAccount(connection.accountId);
        const targets: TargetListEntry[] = [];
        for (const { nodeId, targets: nodeTargets } of perNode) {
          const reachable = registry.nodeConnectionsByNodeId.get(nodeId) !== undefined;
          for (const target of nodeTargets) {
            targets.push({
              nodeId,
              targetId: target.id,
              label: target.label,
              kind: target.kind,
              reachable,
            });
          }
        }
        const response: TargetList = {
          type: 'target_list',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          targets,
        };
        sendDirect(connection, response);
        return;
      }
      case 'session_list_request': {
        const records = await store.sessions.listForAccount(connection.accountId);
        const sessions = records.map((record) => ({
          session: record.meta,
          privateEnvelope: record.privateEnvelope,
        }));
        const response: SessionListV1 = {
          type: 'session_list',
          protocolVersion: PROTOCOL_V1,
          sessions,
        };
        sendDirect(connection, response);
        return;
      }
      case 'session_resume': {
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: resume for unknown/foreign session',
          );
          return;
        }
        subscribeClientToSession(connection, message.sessionId);
        const announce: SessionAnnounceV1 = {
          type: 'session_announce',
          protocolVersion: PROTOCOL_V1,
          session: record.meta,
          privateEnvelope: record.privateEnvelope,
        };
        sendDirect(connection, announce);
        return;
      }
      case 'session_create': {
        const nodeId = store.targets.findNodeForTarget(message.targetId);
        const nodeConnection = nodeId ? registry.nodeConnectionsByNodeId.get(nodeId) : undefined;
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { targetId: message.targetId },
            'relay: session_create for unknown/foreign target',
          );
          return;
        }
        sendDirect(nodeConnection, message);
        return;
      }
      case 'prompt_inject':
      case 'permission_response':
      case 'config_option':
      case 'fs_list_request':
        // fs_list_request (SPEC §7.4; issue #171/#160): a client asking the
        // owning node to list a directory inside one of its sessions'
        // projects — routed exactly like prompt_inject/config_option above.
        // The relay only ever sees `sessionId`/`targetId`/`requestId` and an
        // opaque `EncryptedEnvelope`; the requested path never reaches the
        // relay in the clear (SPEC §8's metadata boundary).
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'terminal_open':
      case 'terminal_input':
      case 'terminal_resize':
      case 'terminal_close':
        // A client opening/typing into/resizing/closing an interactive PTY
        // terminal (SPEC §7.5; issues #172/#173) — routed to the owning node
        // exactly like fs_list_request above. The relay only ever sees
        // sessionId/terminalId (and, for terminal_open, targetId/requestId)
        // plus an opaque `EncryptedEnvelope`; not one byte of typed input or
        // the negotiated cols/rows ever reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'blob_upload': {
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: blob_upload for unknown/foreign session',
          );
          return;
        }
        // #101: reject rather than partially accept — the upload is simply
        // not stored, and the client is told exactly why (out-of-band,
        // same as `update_required` above — not a `WireMessageV1`, the
        // protocol isn't changed by adding this).
        if (!(await hasQuotaFor(connection.accountId, envelopeByteSize(message.envelope)))) {
          app.log.warn(
            { accountId: connection.accountId, sessionId: message.sessionId, ref: message.ref },
            'relay: blob_upload rejected, account storage quota exceeded',
          );
          sendJson(connection.socket, {
            type: 'quota_exceeded',
            scope: 'blob_upload',
            sessionId: message.sessionId,
            ref: message.ref,
          });
          return;
        }
        await store.blobs.upload(
          `${message.sessionId}:${message.ref}`,
          message.envelope,
          connection.accountId,
        );
        return;
      }
      case 'blob_download':
        await handleBlobDownload(connection, message);
        return;
      case 'resync_request': {
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: resync for unknown/foreign session',
          );
          return;
        }
        const result = await store.sessions.getEntriesSince(message.sessionId, message.sinceSeq);
        if (result.droppedFromSeq !== undefined && result.droppedToSeq !== undefined) {
          const marker: ResyncMarker = {
            type: 'resync_marker',
            protocolVersion: PROTOCOL_V1,
            sessionId: message.sessionId,
            fromSeq: result.droppedFromSeq,
            toSeq: result.droppedToSeq,
            dropped: true,
          };
          sendDirect(connection, marker);
        }
        for (const entry of result.entries) {
          const replay: SessionUpdateEnvelopeV1 = {
            type: 'session_update',
            protocolVersion: PROTOCOL_V1,
            sessionId: message.sessionId,
            seq: entry.seq,
            envelope: entry.envelope,
          };
          sendDirect(connection, replay);
        }
        return;
      }
      case 'presence': {
        for (const node of registry.nodes) {
          if (node.accountId === connection.accountId) sendDirect(node, message);
        }
        for (const client of registry.clients) {
          if (client !== connection && client.accountId === connection.accountId) {
            sendDirect(client, message);
          }
        }
        return;
      }
      default:
        app.log.warn({ type: message.type }, 'relay: unexpected message from a client connection');
    }
  }

  function dropConnection(connection: Connection): void {
    if (connection.kind === 'node') {
      registry.nodes.delete(connection);
      for (const nodeId of connection.nodeIds) {
        if (registry.nodeConnectionsByNodeId.get(nodeId) === connection) {
          registry.nodeConnectionsByNodeId.delete(nodeId);
        }
      }
    } else {
      registry.clients.delete(connection);
      // #97: release this client's fan-out backend subscriptions — for the
      // Redis backend this is what actually issues UNSUBSCRIBE once no
      // local client cares about a given session anymore.
      for (const unsubscribe of connection.fanOutUnsubscribes.values()) unsubscribe();
      connection.fanOutUnsubscribes.clear();
    }
  }

  // Liveness endpoint for external uptime monitoring (#100). Deliberately a
  // plain 200 that does not touch Postgres: it answers "the relay process is
  // up and serving HTTP", which is what a probe like Caddy/UptimeRobot wants.
  // A DB-dependent readiness check would flap the whole site down on a brief
  // Postgres blip, so that stays out of the liveness path.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  /** Resolves the `Authorization: Bearer <token>` header the same way the WS handshake resolves its `authToken` (#121) — `undefined` if absent/invalid. Used by the `/push/*` REST routes below, which have no WS connection of their own to piggyback auth on. */
  async function accountIdFromBearer(
    header: string | string[] | undefined,
  ): Promise<string | undefined> {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith('Bearer ')) return undefined;
    return resolveAccountId(value.slice('Bearer '.length));
  }

  function isPushSubscribeBody(
    body: unknown,
  ): body is { deviceId: string; endpoint: string; keys: { p256dh: string; auth: string } } {
    if (typeof body !== 'object' || body === null) return false;
    const candidate = body as Record<string, unknown>;
    const keys = candidate.keys as Record<string, unknown> | undefined;
    return (
      typeof candidate.deviceId === 'string' &&
      candidate.deviceId.length > 0 &&
      typeof candidate.endpoint === 'string' &&
      candidate.endpoint.length > 0 &&
      typeof keys === 'object' &&
      keys !== null &&
      typeof keys.p256dh === 'string' &&
      typeof keys.auth === 'string'
    );
  }

  // #161: the documented endpoint a client fetches the relay's self-owned
  // VAPID public key from, to pass into `PushManager.subscribe()`'s
  // `applicationServerKey`. 404 (not disabled-but-empty) when this relay
  // wasn't configured with `push` at all — the same "feature absent, not
  // feature broken" signal `/push/subscribe` below gives.
  app.get('/push/vapid-public-key', async (_request, reply) => {
    if (!opts.push) return reply.code(404).send({ error: 'push not configured' });
    return { publicKey: opts.push.vapidKeys.publicKey };
  });

  // #161/#162: registers (or overwrites, on re-subscribe) this account's
  // device's push subscription — see `store.ts`'s `PushSubscriptionStore`
  // doc comment for the overwrite-not-accumulate behavior.
  app.post('/push/subscribe', async (request, reply) => {
    if (!opts.push) return reply.code(404).send({ error: 'push not configured' });
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });
    if (!isPushSubscribeBody(request.body)) {
      return reply.code(400).send({ error: 'invalid push subscription body' });
    }
    const body = request.body;
    await store.pushSubscriptions.save({
      accountId,
      deviceId: body.deviceId,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    });
    return reply.code(204).send();
  });

  // A client that turned notifications off, or is signing this device out,
  // removes its own subscription — scoped to the bearer's own account, same
  // as every other account-scoped mutation in this file.
  app.delete('/push/subscribe', async (request, reply) => {
    if (!opts.push) return reply.code(404).send({ error: 'push not configured' });
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });
    const body = request.body as { deviceId?: unknown } | undefined;
    if (typeof body?.deviceId !== 'string' || body.deviceId.length === 0) {
      return reply.code(400).send({ error: 'deviceId is required' });
    }
    await store.pushSubscriptions.delete(accountId, body.deviceId);
    return reply.code(204).send();
  });

  app.register(fastifyWebsocket);

  app.register(async (instance) => {
    instance.get(RELAY_WS_PATH, { websocket: true }, (socket: WsWebSocket) => {
      let connection: Connection | undefined;
      // Every store call is now awaited (the Postgres swap makes that
      // unavoidable — see `store.ts`'s `Awaitable` doc comment), so a frame
      // handler is no longer guaranteed to run to completion before the next
      // 'message' event fires. Chaining each frame onto this socket's own
      // promise processes them strictly one at a time, in arrival order —
      // preserving the seq/backpressure ordering guarantees the resync and
      // drop-oldest tests (and real clients) depend on — while still letting
      // different sockets' frames interleave freely.
      let processing: Promise<void> = Promise.resolve();

      async function processFrame(text: string): Promise<void> {
        if (!connection) {
          connection = await handleInitialize(socket, text);
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          app.log.warn('relay: dropped a non-JSON frame');
          return;
        }
        const result = safeParseWireMessageV1(parsed);
        if (!result.success) {
          app.log.warn({ issues: result.error.issues }, 'relay: dropped an invalid wire frame');
          return;
        }
        const message = result.data;

        if (connection.kind === 'node') await handleNodeMessage(connection, message);
        else await handleClientMessage(connection, message);
      }

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const text = raw.toString();
        // `processing` is always fully settled (its own `.catch` below
        // absorbs any failure) by the time the next frame chains onto it, so
        // this `.then` always runs — a prior frame's error never blocks or
        // skips a later one.
        processing = processing
          .then(() => processFrame(text))
          .catch((error: unknown) => {
            app.log.error({ error }, 'relay: error processing frame');
          });
      });

      socket.on('close', () => {
        if (connection) dropConnection(connection);
      });
    });
  });

  return app;
}

export interface StartRelayOptions extends CreateRelayOptions {
  /** Defaults to 127.0.0.1 — never bind a public interface without an explicit opt-in. */
  host?: string;
  /** Defaults to an ephemeral port (0) when omitted. */
  port?: number;
}

export interface StartedRelay {
  /** The base ws:// URL clients/nodes connect to (includes {@link RELAY_WS_PATH}). */
  url: string;
  close: () => Promise<void>;
}

/** Starts the relay listening on `host:port` and resolves once it's bound. */
export async function startRelay(opts: StartRelayOptions = {}): Promise<StartedRelay> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const app = createRelay(opts);

  await app.listen({ host, port });

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('relay: failed to determine listen address');
  }

  const boundHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `ws://${boundHost}:${address.port}${RELAY_WS_PATH}`,
    close: async () => {
      await app.close();
    },
  };
}
