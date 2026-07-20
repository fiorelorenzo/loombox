import type { Duplex } from 'node:stream';

/**
 * The narrow capability `./port-forward-tunnel.ts` needs beyond
 * `RemoteTransport`'s `connect`/`exec`/`close` (issue #92): opening an
 * SSH "direct-tcpip" channel — the wire-protocol primitive behind a local
 * port forward (`ssh -L`) — from `srcHost:srcPort` (as seen by the remote
 * end; typically the forwarding socket's own peer address, informational
 * only) to `dstHost:dstPort` on the far side of the connection. A separate
 * interface rather than folding this into `RemoteTransport` itself: not
 * every `RemoteTransport` (e.g. the hermetic `FakeTransport`/
 * `LocalProcessTransport` doubles used across this directory's other tests)
 * needs to support it, and `RemoteTransport`'s own doc comment is explicit
 * about staying "deliberately narrow".
 *
 * Implemented by {@link Ssh2Transport} (via `ssh2`'s `Client.forwardOut`) and
 * by `ReconnectingTransport` (delegating to whichever concrete transport is
 * currently connected, with the same reconnect-and-retry seam `exec()`
 * already uses) — so a tunnel opened against the pooled transport
 * `SshTransportPool` hands out rides on that same reconnecting connection,
 * exactly like every other operation in this directory.
 */
export interface PortForwardTransport {
  openForwardChannel(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
  ): Promise<Duplex>;
}

/** Runtime check for whether `transport` also implements {@link PortForwardTransport} — used where a plain `RemoteTransport` is held but forwarding is optionally needed (e.g. `ReconnectingTransport`, delegating to its current inner transport). */
export function supportsPortForward(transport: unknown): transport is PortForwardTransport {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as Partial<PortForwardTransport>).openForwardChannel === 'function'
  );
}
