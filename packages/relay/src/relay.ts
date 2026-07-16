import fastifyWebsocket, { type WebSocket as WsWebSocket } from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  PROTOCOL_VERSION,
  safeParseWireMessage,
  type SessionMeta,
  type WireMessage,
} from '@loombox/protocol';

/** Path the WS route is mounted on; both nodes and clients connect here. */
export const RELAY_WS_PATH = '/ws';

interface NodeConnection {
  kind: 'node';
  nodeId: string;
  socket: WsWebSocket;
  /** Session ids this node has announced, so we can drop them on disconnect. */
  sessionIds: Set<string>;
}

interface ClientConnection {
  kind: 'client';
  clientId: string;
  socket: WsWebSocket;
}

interface SessionEntry {
  meta: SessionMeta;
  node: NodeConnection;
}

/** In-memory, per-instance relay state. Never shared across `createRelay()` calls. */
interface RelayRegistry {
  nodes: Set<NodeConnection>;
  clients: Set<ClientConnection>;
  sessions: Map<string, SessionEntry>;
}

function createRegistry(): RelayRegistry {
  return { nodes: new Set(), clients: new Set(), sessions: new Map() };
}

function sendMessage(socket: WsWebSocket, message: WireMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToClients(registry: RelayRegistry, message: WireMessage): void {
  for (const client of registry.clients) {
    sendMessage(client.socket, message);
  }
}

function sendSessionListSnapshot(registry: RelayRegistry, socket: WsWebSocket): void {
  sendMessage(socket, {
    type: 'session_list',
    protocolVersion: PROTOCOL_VERSION,
    sessions: Array.from(registry.sessions.values()).map((entry) => entry.meta),
  });
}

/** Removes a node and every session it owns from the registry. */
function dropNode(registry: RelayRegistry, node: NodeConnection): void {
  registry.nodes.delete(node);
  for (const sessionId of node.sessionIds) {
    registry.sessions.delete(sessionId);
  }
}

function dropClient(registry: RelayRegistry, client: ClientConnection): void {
  registry.clients.delete(client);
}

/**
 * Builds the Fastify instance for the v0 relay: an in-memory, transport-only
 * WS fan-out between agent nodes and PWA clients (SPEC §5.3, §8's
 * "transport-only fallback", §16 relay stack minus Postgres/Redis for v0).
 * Does not call `listen`; see {@link startRelay} for that.
 */
export function createRelay(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const registry = createRegistry();

  app.register(fastifyWebsocket);

  app.register(async (instance) => {
    instance.get(RELAY_WS_PATH, { websocket: true }, (socket: WsWebSocket) => {
      let connection: NodeConnection | ClientConnection | undefined;

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          app.log.warn('relay: dropped a non-JSON frame');
          return;
        }

        const result = safeParseWireMessage(parsed);
        if (!result.success) {
          app.log.warn({ issues: result.error.issues }, 'relay: dropped an invalid wire frame');
          return;
        }
        const message = result.data;

        if (!connection) {
          if (message.type === 'node_hello') {
            connection = { kind: 'node', nodeId: message.nodeId, socket, sessionIds: new Set() };
            registry.nodes.add(connection);
          } else if (message.type === 'client_hello') {
            connection = { kind: 'client', clientId: message.clientId, socket };
            registry.clients.add(connection);
            sendSessionListSnapshot(registry, socket);
          } else {
            app.log.warn({ type: message.type }, 'relay: first frame was not a hello');
          }
          return;
        }

        if (connection.kind === 'node') {
          if (message.type === 'session_announce') {
            const entry: SessionEntry = { meta: message.session, node: connection };
            registry.sessions.set(message.session.id, entry);
            connection.sessionIds.add(message.session.id);
            broadcastToClients(registry, message);
          } else if (message.type === 'session_update') {
            broadcastToClients(registry, message);
          }
          return;
        }

        // connection.kind === 'client'
        if (message.type === 'prompt_inject') {
          const entry = registry.sessions.get(message.sessionId);
          if (entry) {
            sendMessage(entry.node.socket, message);
          } else {
            app.log.warn(
              { sessionId: message.sessionId },
              'relay: prompt_inject for unknown session',
            );
          }
        }
      });

      socket.on('close', () => {
        if (!connection) return;
        if (connection.kind === 'node') {
          dropNode(registry, connection);
        } else {
          dropClient(registry, connection);
        }
      });
    });
  });

  return app;
}

export interface StartRelayOptions {
  /** Defaults to 127.0.0.1 — never bind a public interface without an explicit opt-in. */
  host?: string;
  /** Defaults to an ephemeral port (0) when omitted. */
  port?: number;
  logger?: boolean;
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
  const app = createRelay({ logger: opts.logger });

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
