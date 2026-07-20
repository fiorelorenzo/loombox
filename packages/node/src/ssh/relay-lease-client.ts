import { PROTOCOL_V1, type LeaseRequestAction, type WireMessageV1 } from '@loombox/protocol';

/**
 * The minimal surface `RelayLeaseClient` needs off this node's *existing*
 * relay connection — never a new one, mirroring `attachments.ts`'s
 * `RelayLike` (issue #156's precedent). `RelayConnection` (this package's
 * real production connection) already satisfies this shape; a test
 * substitutes a tiny fake with no WebSocket/network involved at all.
 */
export interface RelayLike {
  send(message: WireMessageV1): void;
  on(event: 'message', listener: (message: WireMessageV1) => void): void;
  off(event: 'message', listener: (message: WireMessageV1) => void): void;
}

export type RelayLeaseOutcome =
  { granted: true; expiresAt: number } | { granted: false; heldBy?: string; expiresAt?: number };

export interface RelayLeaseClientOptions {
  /** How long to wait for the matching `lease_result`/`lease_release_result` before rejecting (default 10s, mirrors `RelayBlobSource`). */
  timeoutMs?: number;
  /**
   * Resolves once the underlying relay connection is actually open, so a
   * request made immediately after construction is never silently dropped
   * (`RelayConnection.send()` drops a message when the socket isn't open
   * yet). Defaults to an already-resolved promise, for a caller/test that
   * already knows the connection is live; `NodeDaemon` passes its own
   * `whenConnected()`.
   */
  whenReady?: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

let requestCounter = 0;

function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}-${Date.now()}`;
}

/**
 * The node-side client half of session-ownership leasing across nodes
 * (SPEC §9: "a session is owned by one node via a renewable lease... so a
 * Mac node and a devbox node never fight over the same supervisor"; issues
 * #82/#104), talking directly to the relay's own `lease_request`/
 * `lease_release` arbiter (`packages/relay/src/relay.ts`'s
 * `handleLeaseRequest`/`handleLeaseRelease`, backed by `store.ts`'s
 * account-scoped `LeaseStore`) over this node's existing relay connection —
 * no new socket (mirrors `RelayBlobSource`, issue #156's precedent).
 *
 * This is layered ADDITIVELY alongside `./session-lease.ts`'s local,
 * in-memory `SessionLeaseManager` rather than replacing it: that class's own
 * `LeaseStore` interface (`read`/`compareAndSwap`/`release`) is a
 * synchronous-flavored compare-and-swap abstraction with no `nodeId`-free
 * status query and no acquire/renew distinction — both of which the relay's
 * wire contract needs (a `renew` is arbitrated strictly as "only the current
 * holder may extend it", server-side, not just trusted from a caller's own
 * prior local check). So this is a small, purpose-built client against
 * exactly the four lease wire messages, not a `LeaseStore` implementation —
 * `NodeDaemon` calls both: the local manager stays the always-available,
 * same-process fast path (and the seam every existing hermetic ssh: test
 * already exercises), and this client is the actual cross-process arbiter
 * once a node is relay-connected.
 */
export class RelayLeaseClient {
  private readonly relay: RelayLike;
  private readonly timeoutMs: number;
  private readonly whenReady: () => Promise<void>;

  constructor(relay: RelayLike, options: RelayLeaseClientOptions = {}) {
    this.relay = relay;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.whenReady = options.whenReady ?? (() => Promise.resolve());
  }

  /** Requests a fresh lease. Granted immediately if the session is unheld, already expired, or already held by this same `nodeId` (idempotent re-acquire). */
  acquire(sessionId: string, nodeId: string, ttlMs?: number): Promise<RelayLeaseOutcome> {
    return this.request('acquire', sessionId, nodeId, ttlMs);
  }

  /** Extends an already-held lease. The relay denies this (without granting) if `nodeId` is not the session's current live holder — a renewal is never a back-door acquire. */
  renew(sessionId: string, nodeId: string, ttlMs?: number): Promise<RelayLeaseOutcome> {
    return this.request('renew', sessionId, nodeId, ttlMs);
  }

  /** Deliberately gives up a lease this node holds (session stop, node exit). Resolves `false` (a no-op, not an error) if `nodeId` doesn't currently hold it. */
  async release(sessionId: string, nodeId: string): Promise<boolean> {
    await this.whenReady();
    const requestId = nextRequestId('lease-release');
    return new Promise((resolve, reject) => {
      const onMessage = (message: WireMessageV1): void => {
        if (message.type === 'lease_release_result' && message.requestId === requestId) {
          clearTimeout(timer);
          this.relay.off('message', onMessage);
          resolve(message.released);
        }
      };
      this.relay.on('message', onMessage);
      const timer = setTimeout(() => {
        this.relay.off('message', onMessage);
        reject(
          new Error(
            `RelayLeaseClient: timed out waiting for lease_release_result (session ${sessionId})`,
          ),
        );
      }, this.timeoutMs);

      this.relay.send({
        type: 'lease_release',
        protocolVersion: PROTOCOL_V1,
        requestId,
        sessionId,
        nodeId,
      });
    });
  }

  /**
   * Best-effort, synchronous fire-and-forget release: sends `lease_release`
   * immediately — no `whenReady()` gate, no waiting for the matching
   * `lease_release_result` — and returns. `release()` above awaits
   * `whenReady()` first, which (even when already resolved) still defers
   * the actual `send()` behind at least one microtask; that is wrong for a
   * synchronous teardown path (`NodeDaemon.close()`) that closes the
   * underlying relay connection immediately afterward in the same call
   * stack, since the deferred `send()` would then race a socket that is
   * already closing and can lose. This method assumes the caller already
   * knows the connection is live (a session's lease heartbeat only ever
   * runs after this node successfully connected in the first place); if it
   * isn't, the message is silently dropped exactly like any other
   * `RelayConnection.send()` call on a closed socket.
   */
  releaseBestEffort(sessionId: string, nodeId: string): void {
    this.relay.send({
      type: 'lease_release',
      protocolVersion: PROTOCOL_V1,
      requestId: nextRequestId('lease-release-sync'),
      sessionId,
      nodeId,
    });
  }

  private async request(
    action: LeaseRequestAction,
    sessionId: string,
    nodeId: string,
    ttlMs: number | undefined,
  ): Promise<RelayLeaseOutcome> {
    await this.whenReady();
    const requestId = nextRequestId(`lease-${action}`);
    return new Promise((resolve, reject) => {
      const onMessage = (message: WireMessageV1): void => {
        if (message.type === 'lease_result' && message.requestId === requestId) {
          clearTimeout(timer);
          this.relay.off('message', onMessage);
          resolve(
            message.result.outcome === 'granted'
              ? { granted: true, expiresAt: message.result.expiresAt }
              : {
                  granted: false,
                  heldBy: message.result.heldBy,
                  expiresAt: message.result.expiresAt,
                },
          );
        }
      };
      this.relay.on('message', onMessage);
      const timer = setTimeout(() => {
        this.relay.off('message', onMessage);
        reject(
          new Error(
            `RelayLeaseClient: timed out waiting for lease_result (session ${sessionId}, action ${action})`,
          ),
        );
      }, this.timeoutMs);

      this.relay.send({
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        sessionId,
        nodeId,
        action,
        ttlMs,
      });
    });
  }
}
