/**
 * Session ownership leasing across nodes (issue #82, SPEC.md §9: "a session
 * is owned by one node via a renewable lease; a second node may attach
 * read-only while the lease is live and reclaim it on expiry"). The actual
 * lock primitive is expected to live server-side eventually (the relay
 * epic's Postgres `pg_advisory_lock`/Redis `SET NX PX`, per SPEC.md §16 —
 * "the lock primitive itself may live server-side; this issue is the
 * node/supervisor-side leasing client and enforcement"); `LeaseStore` is that
 * seam, so a real distributed backend can be dropped in later without
 * touching `SessionLeaseManager`'s acquire/renew/expire/reclaim semantics.
 * {@link InMemoryLeaseStore} is a complete, correct implementation of the
 * interface — useful standalone for a single-node deployment or as the
 * hermetic default in tests — not a mock.
 */

export interface Lease {
  sessionId: string;
  holderNodeId: string;
  expiresAt: number;
}

/**
 * Compare-and-swap lease storage. Every method is a single atomic operation
 * from the caller's point of view (a real Redis/Postgres-backed
 * implementation would use `SET NX PX`/`pg_advisory_lock` accordingly to
 * keep that true across multiple relay processes).
 */
export interface LeaseStore {
  /** Reads the current lease for `sessionId`, if any (including an already-expired one — expiry is a `now`-relative judgement the caller/manager makes, not something the store hides). */
  read(sessionId: string): Promise<Lease | undefined>;
  /** Atomically writes `lease`, but only if the store currently has no lease for this session, or the existing one's `holderNodeId` matches `lease.holderNodeId` (a renewal), or the existing one is already expired as of `now` (a reclaim). Returns `true` if the write happened. */
  compareAndSwap(lease: Lease, now: number): Promise<boolean>;
  /** Removes the lease for `sessionId`, but only if it's still held by `holderNodeId` (so a node can't release a lease it no longer holds). */
  release(sessionId: string, holderNodeId: string): Promise<boolean>;
}

export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();

  async read(sessionId: string): Promise<Lease | undefined> {
    return this.leases.get(sessionId);
  }

  async compareAndSwap(lease: Lease, now: number): Promise<boolean> {
    const current = this.leases.get(lease.sessionId);
    if (current && current.holderNodeId !== lease.holderNodeId && current.expiresAt > now) {
      return false; // held by someone else and still live: refuse
    }
    this.leases.set(lease.sessionId, lease);
    return true;
  }

  async release(sessionId: string, holderNodeId: string): Promise<boolean> {
    const current = this.leases.get(sessionId);
    if (!current || current.holderNodeId !== holderNodeId) return false;
    this.leases.delete(sessionId);
    return true;
  }
}

export interface SessionLeaseManagerOptions {
  store?: LeaseStore;
  /** How long an acquired/renewed lease is valid for, in ms (default 30s — long enough to survive a missed heartbeat, short enough that a crashed node's session becomes reclaimable quickly). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export type LeaseAcquireResult =
  { granted: true; lease: Lease } | { granted: false; heldBy: string; expiresAt: number };

/**
 * The node/supervisor-side leasing client (issue #82): call `acquire()`
 * before driving a session's supervisor, `renew()` periodically while
 * driving it, `release()` when deliberately done, and `reclaim()` once
 * another node's lease has actually expired (never before — that's what
 * keeps two nodes from double-driving the same supervisor).
 */
export class SessionLeaseManager {
  private readonly store: LeaseStore;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SessionLeaseManagerOptions = {}) {
    this.store = options.store ?? new InMemoryLeaseStore();
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Acquires the lease for `sessionId` on behalf of `nodeId`. Succeeds immediately if unheld, already expired, or already held by this same node (idempotent re-acquire). */
  async acquire(sessionId: string, nodeId: string): Promise<LeaseAcquireResult> {
    return this.acquireOrRenew(sessionId, nodeId);
  }

  /** Extends an already-held lease's expiry. Fails (without granting) if this node doesn't currently hold it — a renewal is not a back-door acquire. */
  async renew(sessionId: string, nodeId: string): Promise<LeaseAcquireResult> {
    const now = this.now();
    const current = await this.store.read(sessionId);
    if (!current || current.holderNodeId !== nodeId || current.expiresAt <= now) {
      return {
        granted: false,
        heldBy: current?.holderNodeId ?? 'nobody',
        expiresAt: current?.expiresAt ?? 0,
      };
    }
    return this.acquireOrRenew(sessionId, nodeId);
  }

  private async acquireOrRenew(sessionId: string, nodeId: string): Promise<LeaseAcquireResult> {
    const now = this.now();
    const lease: Lease = { sessionId, holderNodeId: nodeId, expiresAt: now + this.ttlMs };
    const ok = await this.store.compareAndSwap(lease, now);
    if (ok) return { granted: true, lease };

    const current = await this.store.read(sessionId);
    return {
      granted: false,
      heldBy: current?.holderNodeId ?? 'unknown',
      expiresAt: current?.expiresAt ?? 0,
    };
  }

  /** Deliberately gives up a lease this node holds. A no-op (returns `false`) if it doesn't currently hold it. */
  async release(sessionId: string, nodeId: string): Promise<boolean> {
    return this.store.release(sessionId, nodeId);
  }

  /**
   * Reclaims a session's lease for `nodeId` — the explicit handoff action
   * (SPEC.md §9: "an explicit action in the PWA"). Only succeeds once the
   * current holder's lease has actually expired; a live lease held by
   * another node is never overridden by this method (that's the whole
   * point — two nodes never fight over the same supervisor).
   */
  async reclaim(sessionId: string, nodeId: string): Promise<LeaseAcquireResult> {
    const now = this.now();
    const current = await this.store.read(sessionId);
    if (current && current.holderNodeId !== nodeId && current.expiresAt > now) {
      return { granted: false, heldBy: current.holderNodeId, expiresAt: current.expiresAt };
    }
    return this.acquireOrRenew(sessionId, nodeId);
  }

  /** Whether `nodeId` is currently the live (non-expired) leaseholder for `sessionId` — the read/write gate: only the leaseholder may send prompts/control, per SPEC.md §9. A second node attaching while this is `false` gets read-only access at the caller's layer (this method is exactly that check). */
  async isLeaseholder(sessionId: string, nodeId: string): Promise<boolean> {
    const now = this.now();
    const current = await this.store.read(sessionId);
    return current !== undefined && current.holderNodeId === nodeId && current.expiresAt > now;
  }
}
