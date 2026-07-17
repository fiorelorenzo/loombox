import {
  ReconnectingTransport,
  type ReconnectingTransportOptions,
  type TransportHealth,
} from './reconnecting-transport';
import type { RemoteTransport } from './remote-transport';

export interface SshTransportPoolOptions {
  /** Reconnect tuning (backoff, retry classification, ...) applied to every pooled connection. */
  reconnect?: ReconnectingTransportOptions;
}

/**
 * A per-target `RemoteTransport` pool (issue #71, SPEC §5.2/§7.23's "pooled
 * ... SSH transport"): every call to {@link get} for the same `key` (a target
 * id) reuses the single {@link ReconnectingTransport} already open for it —
 * "multiple operations against the same host reuse a single pooled
 * connection rather than opening a new one each time" — and that connection
 * transparently reconnects with backoff across a mid-session drop, rather
 * than the pool tearing it down and forcing the caller to redo setup.
 */
export class SshTransportPool {
  private readonly entries = new Map<string, ReconnectingTransport>();

  constructor(private readonly options: SshTransportPoolOptions = {}) {}

  /**
   * Gets (opening on first use) the pooled, reconnecting transport for
   * `key`. `createTransport` is only ever consulted for a `key` this pool
   * hasn't seen before, or after that key's connection has been {@link close}d
   * — every other call reuses the existing pooled connection, matching
   * `NodeDaemon`'s prior per-target `Map<targetId, ...>` behavior exactly,
   * now with reconnection underneath it.
   */
  async get(key: string, createTransport: () => RemoteTransport): Promise<RemoteTransport> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = new ReconnectingTransport(createTransport, this.options.reconnect);
      this.entries.set(key, entry);
    }
    await entry.connect();
    return entry;
  }

  /** Queryable health/status for `key`'s pooled connection, or `undefined` if this pool has never opened one for it. */
  health(key: string): TransportHealth | undefined {
    return this.entries.get(key)?.getHealth();
  }

  /** Closes and forgets `key`'s pooled connection, if any; a later `get()` for the same key opens a fresh one. */
  async close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.close();
  }

  /** Closes every pooled connection (`NodeDaemon.close()`'s shutdown path). Best-effort: a single target's close failure doesn't stop the others from closing. */
  async closeAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(
      keys.map((key) =>
        this.close(key).catch(() => {
          /* best-effort shutdown, matches the prior `transport.close().catch(() => {})` behavior */
        }),
      ),
    );
  }
}
