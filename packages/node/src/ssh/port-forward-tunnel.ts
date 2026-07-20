import { createServer, type Server, type Socket } from 'node:net';

import type { PortForwardTransport } from './port-forward-transport';

/**
 * The SSH local-port-forward primitive (issue #92, SPEC §7.8/§16: "emdash's
 * port-forward tunnel is the reference; reimplemented clean-room"): a local
 * TCP listener whose every accepted connection is proxied to
 * `remoteHost:remotePort` over an existing {@link PortForwardTransport}'s
 * "direct-tcpip" channel — the foundation a later "forward an agent's dev
 * server" feature builds on, not that feature itself.
 *
 * Rides the transport it's given rather than opening anything of its own:
 * pass the same pooled `ReconnectingTransport` `SshTransportPool.get()`
 * already hands out for a target, and every tunnel opened against it (this
 * one, and any other simultaneous one on the same host) shares that one
 * underlying SSH connection for free — nothing in this module has to know
 * pooling exists.
 */

export interface PortForwardTunnelOptions {
  /** Local interface to bind the listener to (default `127.0.0.1` — never expose a tunnel beyond loopback without the caller opting in explicitly). */
  localHost?: string;
  /** Local TCP port to listen on. `0` picks a free ephemeral port — read it back from {@link PortForwardTunnel.localPort} once opened. */
  localPort?: number;
  /** Remote host to forward each connection to, as resolved by the SSH server (`'localhost'`/`'127.0.0.1'` for the server's own loopback services — the common "forward my dev server" case). */
  remoteHost: string;
  /** Remote port to forward each connection to. */
  remotePort: number;
  /** Called (best-effort, never thrown into the listener) when a single proxied connection fails to open or errors after opening — a tunnel-wide failure instead surfaces from {@link openPortForwardTunnel} itself, before the listener is ever returned. */
  onConnectionError?: (error: Error) => void;
}

export interface PortForwardTunnel {
  readonly localHost: string;
  /** The bound local port — resolved even when `options.localPort` was `0`/omitted. */
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  /** Number of currently-proxied connections (open sockets with a live remote channel). */
  readonly activeConnections: number;
  /** Stops accepting new connections and closes every currently-proxied one. Idempotent. */
  close(): Promise<void>;
}

function pipeAndCleanup(
  socket: Socket,
  channel: NodeJS.ReadWriteStream & { destroy(): void },
): void {
  socket.pipe(channel);
  channel.pipe(socket);

  // Either half closing/erroring tears down the other — a proxied
  // connection is a single logical pipe, not two independent ones.
  const cleanup = (): void => {
    socket.destroy();
    channel.destroy();
  };
  socket.once('error', cleanup);
  socket.once('close', cleanup);
  channel.once('error', cleanup);
  channel.once('close', cleanup);
}

/**
 * Opens a local listener and starts proxying (issue #92's acceptance:
 * "traffic to the local listener is proxied to the remote port over the
 * existing SSH connection; no separate SSH process spawned per tunnel").
 * Rejects if the local listener itself fails to bind (port in use, etc.);
 * once open, a single connection's forward failure only affects that
 * connection (reported via `onConnectionError`, if given), never the tunnel.
 */
export async function openPortForwardTunnel(
  transport: PortForwardTransport,
  options: PortForwardTunnelOptions,
): Promise<PortForwardTunnel> {
  const localHost = options.localHost ?? '127.0.0.1';
  let activeConnections = 0;
  // `server.close()` alone only stops accepting *new* connections — Node
  // never closes already-open sockets for you — so this tunnel tracks every
  // live local socket itself to make `close()` actually tear down currently-
  // proxied connections too, as its doc comment promises.
  const liveSockets = new Set<Socket>();

  const server: Server = createServer((socket: Socket) => {
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));

    const peerHost = socket.remoteAddress ?? localHost;
    const peerPort = socket.remotePort ?? 0;

    transport
      .openForwardChannel(peerHost, peerPort, options.remoteHost, options.remotePort)
      .then((channel) => {
        if (socket.destroyed) {
          // The local side already gave up (e.g. `close()` ran) while the
          // channel was opening — don't resurrect a proxied pair for it.
          channel.destroy();
          return;
        }
        activeConnections += 1;
        socket.once('close', () => {
          activeConnections -= 1;
        });
        pipeAndCleanup(socket, channel);
      })
      .catch((error: unknown) => {
        socket.destroy();
        options.onConnectionError?.(error instanceof Error ? error : new Error(String(error)));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.localPort ?? 0, localHost, () => resolve());
  });

  const address = server.address();
  const localPort =
    typeof address === 'object' && address ? address.port : (options.localPort ?? 0);

  let closed = false;
  return {
    localHost,
    localPort,
    remoteHost: options.remoteHost,
    remotePort: options.remotePort,
    get activeConnections() {
      return activeConnections;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of liveSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
