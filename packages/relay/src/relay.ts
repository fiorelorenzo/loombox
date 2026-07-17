import fastifyWebsocket, { type WebSocket as WsWebSocket } from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  PROTOCOL_V1,
  initialize,
  negotiateVersion,
  safeParseWireMessageV1,
  type BlobDownloadResponse,
  type InitializeResult,
  type ResyncMarker,
  type SessionAnnounceV1,
  type SessionListV1,
  type SessionUpdateEnvelopeV1,
  type WireMessageV1,
} from '@loombox/protocol';

import {
  deriveAccountIdStub,
  mountBetterAuth,
  resolveAccountIdViaBetterAuth,
  type RelayAuth,
} from './auth';
import { BoundedClientOutbox, type OutboxItem } from './outbox';
import { createInMemoryRelayStore, type RelayStore } from './store';

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
}

const DEFAULT_MAX_CLIENT_QUEUE_DEPTH = 64;

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
  const resolveAccountId: AccountResolver =
    opts.resolveAccountId ??
    (opts.auth
      ? (authToken) => resolveAccountIdViaBetterAuth(opts.auth as RelayAuth, authToken)
      : deriveAccountIdStub);

  if (opts.auth) mountBetterAuth(app, opts.auth);

  /** Direct, unbounded send — used for control/reply traffic that must never be dropped. */
  function sendDirect(connection: Connection, message: WireMessageV1): void {
    sendJson(connection.socket, message);
  }

  function fanOutSessionUpdate(sessionId: string, item: OutboxItem): void {
    for (const client of registry.clients) {
      if (!client.subscriptions.has(sessionId)) continue;
      client.outbox.enqueue(item);
    }
  }

  /** Direct fan-out (no bounded queue) for lower-volume session-scoped control traffic (permission requests, blob refs, ...). */
  function fanOutDirect(sessionId: string, message: WireMessageV1): void {
    for (const client of registry.clients) {
      if (client.subscriptions.has(sessionId)) sendDirect(client, message);
    }
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
        await store.devices.revoke(message.deviceId);
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
      case 'new_device_bootstrap_request':
      case 'new_device_bootstrap_response':
      case 'qr_pairing_request':
      case 'qr_pairing_response':
        // Deliberately deferred to #113/#114/#115 (AMK escrow + QR pairing) — not in this PR's scope.
        app.log.warn({ type: message.type }, 'relay: device-pairing message not yet implemented');
        return true;
      default:
        return false;
    }
  }

  async function handleNodeMessage(
    connection: NodeConnection,
    message: WireMessageV1,
  ): Promise<void> {
    if (await handleDeviceMessage(connection, message)) return;

    switch (message.type) {
      case 'target_announce': {
        store.targets.announce(message.nodeId, message.targets);
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
        await store.sessions.pushRingEntry(message.sessionId, { seq, envelope: message.envelope });
        fanOutSessionUpdate(message.sessionId, finalized);
        return;
      }
      case 'permission_request':
      case 'blob_ref':
        fanOutDirect(message.sessionId, message);
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
        connection.subscriptions.add(message.sessionId);
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
        await store.blobs.upload(`${message.sessionId}:${message.ref}`, message.envelope);
        return;
      }
      case 'blob_download': {
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
        return;
      }
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
    }
  }

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
