import type { EncryptedEnvelope, SessionMetaPublic, TargetDescriptor } from '@loombox/protocol';

/**
 * In-memory and Postgres-backed relay stores (SPEC §16 relay stack;
 * `docs/v1-plan.md` Wave B, Wave B.2a). The relay is a blind router (issue
 * #315 decision 1): every store here holds only routing metadata and opaque
 * ciphertext, never plaintext. Each store is a small interface so a
 * Postgres-backed implementation (device registry #112, blob store #99,
 * session resync ring #98/#254 — see `store-postgres.ts`) slots in behind
 * the same interface `relay.ts` already calls.
 *
 * `DeviceStore`/`SessionStore`/`BlobStore` methods return {@link Awaitable}
 * rather than a bare value: the in-memory implementation below still
 * returns plain, synchronous values (so its callers, including this
 * package's own tests that read straight off a `RelayStore` instance right
 * after triggering an action, keep working unchanged), but a genuine
 * Postgres implementation is inescapably asynchronous — real network I/O
 * has no synchronous form in Node. `relay.ts` awaits every store call
 * uniformly, which is a no-op (a same-tick microtask) for the in-memory
 * store and real I/O for the Postgres one; both satisfy the same contract.
 * `TargetStore` is the one exception and stays fully synchronous: targets
 * are live routing state a node re-announces on every reconnect, so there
 * is nothing to persist across a relay restart (see `store-postgres.ts`'s
 * doc comment).
 */

/** A value a store method may return either synchronously or via a Promise — see the module doc comment above. */
export type Awaitable<T> = T | Promise<T>;

/** A registered device's identity (SPEC §8). Never holds the AMK or a recovery code. */
export interface DeviceRecord {
  deviceId: string;
  devicePublicKey: string;
  label?: string;
  accountId: string;
  status: 'active' | 'revoked';
  registeredAt: number;
  lastSeenAt: number;
}

export interface DeviceStore {
  /** Registers a new device or refreshes an existing one's label/last-seen. */
  upsert(
    record: Omit<DeviceRecord, 'registeredAt' | 'lastSeenAt' | 'status'>,
  ): Awaitable<DeviceRecord>;
  get(deviceId: string): Awaitable<DeviceRecord | undefined>;
  touch(deviceId: string): Awaitable<void>;
  revoke(deviceId: string): Awaitable<void>;
  rotate(deviceId: string, newDevicePublicKey: string): Awaitable<void>;
}

/** One node's currently-announced execution targets (SPEC §5.2), keyed by nodeId. */
export interface TargetStore {
  announce(nodeId: string, targets: readonly TargetDescriptor[]): void;
  /** Which nodeId owns a given targetId, for routing `session_create` (relay side of #66). */
  findNodeForTarget(targetId: string): string | undefined;
  listForNode(nodeId: string): readonly TargetDescriptor[];
}

/** A session's public routing metadata plus its opaque title/path envelope (the §8 metadata boundary). */
export interface SessionRecord {
  meta: SessionMetaPublic;
  privateEnvelope: EncryptedEnvelope;
}

/** One buffered ciphertext transcript update, for resync replay (SPEC §7.16, §7.22). */
export interface RingEntry {
  seq: number;
  envelope: EncryptedEnvelope;
}

/** The result of a resync lookup: what's still buffered, plus the gap the ring already evicted (if any). */
export interface ResyncResult {
  entries: readonly RingEntry[];
  /** Set only when the ring already evicted entries the caller asked for — the client missed frames in `[droppedFromSeq, droppedToSeq]`. */
  droppedFromSeq?: number;
  droppedToSeq?: number;
}

export interface SessionStore {
  announce(record: SessionRecord): Awaitable<void>;
  get(sessionId: string): Awaitable<SessionRecord | undefined>;
  /** Account-scoped listing (SPEC §8's OAuth-alone listing) — never returns another account's sessions. */
  listForAccount(accountId: string): Awaitable<readonly SessionRecord[]>;
  /** Assigns the next monotonic seq for a session's update stream, creating the counter on first use. */
  nextSeq(sessionId: string): Awaitable<number>;
  pushRingEntry(sessionId: string, entry: RingEntry): Awaitable<void>;
  getEntriesSince(sessionId: string, sinceSeq: number): Awaitable<ResyncResult>;
}

/** Opaque encrypted-blob store (#99), addressed by a caller-supplied opaque key (relay composes `sessionId:ref`). */
export interface BlobStore {
  upload(key: string, envelope: EncryptedEnvelope): Awaitable<void>;
  download(key: string): Awaitable<EncryptedEnvelope | undefined>;
}

export interface RelayStore {
  devices: DeviceStore;
  targets: TargetStore;
  sessions: SessionStore;
  blobs: BlobStore;
}

export interface RelayStoreOptions {
  /** Max buffered ciphertext updates kept per session for resync replay before the oldest is evicted. */
  ringBufferSize?: number;
}

const DEFAULT_RING_BUFFER_SIZE = 200;

/**
 * The in-memory store's concrete, fully-synchronous sub-store shapes —
 * narrower than the public `DeviceStore`/`SessionStore`/`BlobStore`
 * contracts (which allow `Awaitable`, to also fit the Postgres
 * implementation), so a caller holding a `SyncRelayStore` directly — this
 * package's own tests construct one via `createInMemoryRelayStore()` and
 * read its return values straight off, without awaiting, right after
 * triggering an action — keeps that synchronous chaining working. Each is
 * still structurally assignable to its wider public counterpart wherever
 * that's expected (e.g. `CreateRelayOptions.store: RelayStore`).
 */
interface SyncDeviceStore extends DeviceStore {
  upsert(record: Omit<DeviceRecord, 'registeredAt' | 'lastSeenAt' | 'status'>): DeviceRecord;
  get(deviceId: string): DeviceRecord | undefined;
  touch(deviceId: string): void;
  revoke(deviceId: string): void;
  rotate(deviceId: string, newDevicePublicKey: string): void;
}

interface SyncSessionStore extends SessionStore {
  announce(record: SessionRecord): void;
  get(sessionId: string): SessionRecord | undefined;
  listForAccount(accountId: string): readonly SessionRecord[];
  nextSeq(sessionId: string): number;
  pushRingEntry(sessionId: string, entry: RingEntry): void;
  getEntriesSince(sessionId: string, sinceSeq: number): ResyncResult;
}

interface SyncBlobStore extends BlobStore {
  upload(key: string, envelope: EncryptedEnvelope): void;
  download(key: string): EncryptedEnvelope | undefined;
}

/** The concrete return type of {@link createInMemoryRelayStore} — see {@link SyncDeviceStore}'s doc comment. */
export interface SyncRelayStore extends RelayStore {
  devices: SyncDeviceStore;
  targets: TargetStore;
  sessions: SyncSessionStore;
  blobs: SyncBlobStore;
}

function createDeviceStore(): SyncDeviceStore {
  const devices = new Map<string, DeviceRecord>();
  return {
    upsert(input) {
      const existing = devices.get(input.deviceId);
      const record: DeviceRecord = {
        ...input,
        status: existing?.status ?? 'active',
        registeredAt: existing?.registeredAt ?? Date.now(),
        lastSeenAt: Date.now(),
      };
      devices.set(input.deviceId, record);
      return record;
    },
    get(deviceId) {
      return devices.get(deviceId);
    },
    touch(deviceId) {
      const record = devices.get(deviceId);
      if (record) record.lastSeenAt = Date.now();
    },
    revoke(deviceId) {
      const record = devices.get(deviceId);
      if (record) record.status = 'revoked';
    },
    rotate(deviceId, newDevicePublicKey) {
      const record = devices.get(deviceId);
      if (record) record.devicePublicKey = newDevicePublicKey;
    },
  };
}

/**
 * Always in-memory, even inside a Postgres-backed `RelayStore` — see the
 * module doc comment above for why targets are never persisted.
 */
export function createTargetStore(): TargetStore {
  const byNode = new Map<string, TargetDescriptor[]>();
  const nodeByTarget = new Map<string, string>();
  return {
    announce(nodeId, targets) {
      const previous = byNode.get(nodeId) ?? [];
      for (const target of previous) {
        if (nodeByTarget.get(target.id) === nodeId) nodeByTarget.delete(target.id);
      }
      byNode.set(nodeId, [...targets]);
      for (const target of targets) {
        nodeByTarget.set(target.id, nodeId);
      }
    },
    findNodeForTarget(targetId) {
      return nodeByTarget.get(targetId);
    },
    listForNode(nodeId) {
      return byNode.get(nodeId) ?? [];
    },
  };
}

interface SessionRing {
  entries: RingEntry[];
  capacity: number;
  /** Highest seq ever evicted from this ring, or undefined if nothing has been evicted yet. */
  lastEvictedSeq?: number;
}

function createSessionStore(ringBufferSize: number): SyncSessionStore {
  const sessions = new Map<string, SessionRecord>();
  const seqCounters = new Map<string, number>();
  const rings = new Map<string, SessionRing>();

  function ringFor(sessionId: string): SessionRing {
    let ring = rings.get(sessionId);
    if (!ring) {
      ring = { entries: [], capacity: ringBufferSize };
      rings.set(sessionId, ring);
    }
    return ring;
  }

  return {
    announce(record) {
      sessions.set(record.meta.id, record);
    },
    get(sessionId) {
      return sessions.get(sessionId);
    },
    listForAccount(accountId) {
      return Array.from(sessions.values()).filter((entry) => entry.meta.accountId === accountId);
    },
    nextSeq(sessionId) {
      const next = (seqCounters.get(sessionId) ?? 0) + 1;
      seqCounters.set(sessionId, next);
      return next;
    },
    pushRingEntry(sessionId, entry) {
      const ring = ringFor(sessionId);
      ring.entries.push(entry);
      while (ring.entries.length > ring.capacity) {
        const evicted = ring.entries.shift();
        if (evicted) ring.lastEvictedSeq = evicted.seq;
      }
    },
    getEntriesSince(sessionId, sinceSeq) {
      const ring = rings.get(sessionId);
      if (!ring) return { entries: [] };
      if (ring.lastEvictedSeq !== undefined && sinceSeq < ring.lastEvictedSeq) {
        return {
          entries: ring.entries,
          droppedFromSeq: sinceSeq + 1,
          droppedToSeq: ring.lastEvictedSeq,
        };
      }
      return { entries: ring.entries.filter((entry) => entry.seq > sinceSeq) };
    },
  };
}

function createBlobStore(): SyncBlobStore {
  const blobs = new Map<string, EncryptedEnvelope>();
  return {
    upload(key, envelope) {
      blobs.set(key, envelope);
    },
    download(key) {
      return blobs.get(key);
    },
  };
}

/** Builds a fresh, per-instance in-memory `RelayStore`. Never shared across `createRelay()` calls. */
export function createInMemoryRelayStore(opts: RelayStoreOptions = {}): SyncRelayStore {
  return {
    devices: createDeviceStore(),
    targets: createTargetStore(),
    sessions: createSessionStore(opts.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE),
    blobs: createBlobStore(),
  };
}
