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

/**
 * Approximate stored-byte size of an opaque ciphertext envelope (#101, #102):
 * the sum of its base64 fields' string lengths. This is a deliberate
 * approximation (base64 text length, not decoded byte length, and it ignores
 * `alg`) rather than an exact accounting — good enough for a storage quota/
 * retention budget, not a byte-perfect billing meter, and it never needs to
 * decode ciphertext to compute (staying true to the relay's blind-router
 * rule: it reasons about envelope *sizes*, never content).
 */
export function envelopeByteSize(envelope: EncryptedEnvelope): number {
  return envelope.resourceId.length + envelope.iv.length + envelope.ciphertext.length;
}

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

/** One ring entry's account/size, without its ciphertext — for size-cap retention pruning (#102). No `createdAt`: ring entries are pushed strictly in increasing `seq` order, so `seq` is already a correct "oldest first" ordering key without needing a wall-clock column. */
export interface RingEntryRetentionMeta {
  sessionId: string;
  accountId: string;
  seq: number;
  bytes: number;
}

export interface SessionStore {
  announce(record: SessionRecord): Awaitable<void>;
  get(sessionId: string): Awaitable<SessionRecord | undefined>;
  /** Account-scoped listing (SPEC §8's OAuth-alone listing) — never returns another account's sessions. */
  listForAccount(accountId: string): Awaitable<readonly SessionRecord[]>;
  /** Every session's public metadata, across every account — retention pruning only (#102); never used for a client-facing listing (that's the account-scoped `listForAccount` above). */
  listAllMeta(): Awaitable<readonly SessionMetaPublic[]>;
  /** Deletes a session and all its ring/seq-counter state (#102). Idempotent: deleting an already-gone sessionId is a no-op. */
  deleteSession(sessionId: string): Awaitable<void>;
  /** Assigns the next monotonic seq for a session's update stream, creating the counter on first use. */
  nextSeq(sessionId: string): Awaitable<number>;
  /** `accountId` is the owning session's account (relay.ts already has it from `sessions.get`) — charged against that account's storage quota/usage (#101, #102). */
  pushRingEntry(sessionId: string, entry: RingEntry, accountId: string): Awaitable<void>;
  getEntriesSince(sessionId: string, sinceSeq: number): Awaitable<ResyncResult>;
  /** Every buffered ring entry's account/seq/size across all sessions — size-cap retention pruning only (#102). */
  listRingEntriesForRetention(): Awaitable<readonly RingEntryRetentionMeta[]>;
  /**
   * Prunes a session's ring entries with `seq <= throughSeq`, oldest-first from
   * the front (the same "drop-oldest" bookkeeping `pushRingEntry`'s
   * capacity eviction already does, so `lastEvictedSeq` still advances and a
   * client resyncing across a pruned range still gets a correct
   * `dropped`-range marker instead of silently missing frames). Idempotent:
   * calling again with an already-passed `throughSeq` deletes nothing more.
   * Returns how many entries were actually deleted (#102).
   */
  pruneRingEntriesThrough(sessionId: string, throughSeq: number): Awaitable<number>;
}

/** One blob's account/size/age, without its ciphertext — retention pruning only (#101, #102). */
export interface BlobRetentionMeta {
  key: string;
  accountId: string;
  bytes: number;
  /**
   * Undefined for a blob written before the `created_at` column existed
   * (#102's migration backfills nothing, deliberately — see `migrations.ts`):
   * treated as "unknown age, never TTL-pruned" rather than guessed, so a
   * freshly-migrated live relay never mass-deletes its existing ciphertext
   * the first time the retention CLI runs.
   */
  createdAt: number | undefined;
}

/** Opaque encrypted-blob store (#99), addressed by a caller-supplied opaque key (relay composes `sessionId:ref`). */
export interface BlobStore {
  /** `accountId` is charged against that account's storage quota/usage (#101, #102). */
  upload(key: string, envelope: EncryptedEnvelope, accountId: string): Awaitable<void>;
  download(key: string): Awaitable<EncryptedEnvelope | undefined>;
  /** Every blob's retention metadata — never its ciphertext (#102). */
  listForRetention(): Awaitable<readonly BlobRetentionMeta[]>;
  /** Deletes a blob by key. Idempotent: deleting an already-gone key is a no-op (#102). */
  delete(key: string): Awaitable<void>;
}

/**
 * Read-only view of an account's total ciphertext storage (blobs + buffered
 * resync-ring entries), the two write paths a per-account quota gates
 * (#101). Policy (the byte budget itself, and what to do when a write would
 * exceed it) lives in `relay.ts`/`prune.ts`, same as every other
 * authorization decision in this package — this store only ever reports
 * usage, it never enforces anything itself.
 */
export interface QuotaStore {
  getUsageBytes(accountId: string): Awaitable<number>;
}

/**
 * The account's escrowed wrapped-AMK blob (SPEC §8 path 2 "recovery-code
 * escrow", §16; issues #114/#115), one opaque blob per account. `wrappedAmk`
 * is exactly what `@loombox/crypto`'s `packWrappedAmkForWire` produced —
 * this store, like every other one here, never parses or decrypts it, it
 * only ever stores/returns the base64 string as-is. `amk_escrow` overwrites
 * any previous blob for the account (re-escrowing after generating a fresh
 * AMK is expected to replace, not accumulate).
 */
export interface EscrowStore {
  /** `accountId` is the OAuth-authenticated account the blob is scoped to (`connection.accountId`, never client-supplied). */
  put(accountId: string, wrappedAmk: string): Awaitable<void>;
  /** Returns `undefined` if this account has never escrowed an AMK — `new_device_bootstrap_request`'s "nothing to bootstrap from yet" case. */
  get(accountId: string): Awaitable<string | undefined>;
}

/**
 * A client's registered Web Push subscription (SPEC §7.11/§16 "self-owned
 * VAPID push"; issues #161/#163), one per `(accountId, deviceId)` — a device
 * re-subscribing (e.g. the browser rotated its push endpoint) overwrites its
 * previous row rather than accumulating stale ones. `endpoint`/`p256dh`/
 * `auth` are exactly the three fields of the browser's own
 * `PushSubscription.toJSON()`; this store, like every other one in this
 * file, never inspects or transforms them.
 */
export interface PushSubscriptionRecord {
  accountId: string;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

export interface PushSubscriptionStore {
  save(record: Omit<PushSubscriptionRecord, 'createdAt'>): Awaitable<PushSubscriptionRecord>;
  get(accountId: string, deviceId: string): Awaitable<PushSubscriptionRecord | undefined>;
  /** Every subscription this account has registered, across its devices — the presence-aware delivery fan-out (#163) iterates this. */
  listForAccount(accountId: string): Awaitable<readonly PushSubscriptionRecord[]>;
  /** Idempotent: removing an already-gone `(accountId, deviceId)` pair is a no-op. Called both on an explicit client unsubscribe and self-cleaning after the push service reports a subscription gone (410/404, #163). */
  delete(accountId: string, deviceId: string): Awaitable<void>;
}

/** The relay's own self-owned VAPID keypair (SPEC §7.11/§16, RFC 8292; issue #161) — one per relay deployment, never per-account. */
export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface VapidKeyStore {
  get(): Awaitable<VapidKeyPair | undefined>;
  /**
   * First-writer-wins: persists `keys` only if no keypair is stored yet, and
   * always returns whatever ends up stored (its own `keys` argument on a
   * fresh write, or the pre-existing one on a losing race). This is what
   * lets two relay processes boot concurrently against the same fresh
   * database and still converge on one shared keypair instead of each
   * generating and using its own (#161's "generates and persists ... on
   * first setup").
   */
  saveIfAbsent(keys: VapidKeyPair): Awaitable<VapidKeyPair>;
}

export interface RelayStore {
  devices: DeviceStore;
  targets: TargetStore;
  sessions: SessionStore;
  blobs: BlobStore;
  quota: QuotaStore;
  escrow: EscrowStore;
  pushSubscriptions: PushSubscriptionStore;
  vapidKeys: VapidKeyStore;
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
  listAllMeta(): readonly SessionMetaPublic[];
  deleteSession(sessionId: string): void;
  nextSeq(sessionId: string): number;
  pushRingEntry(sessionId: string, entry: RingEntry, accountId: string): void;
  getEntriesSince(sessionId: string, sinceSeq: number): ResyncResult;
  listRingEntriesForRetention(): readonly RingEntryRetentionMeta[];
  pruneRingEntriesThrough(sessionId: string, throughSeq: number): number;
}

interface SyncBlobStore extends BlobStore {
  upload(key: string, envelope: EncryptedEnvelope, accountId: string): void;
  download(key: string): EncryptedEnvelope | undefined;
  listForRetention(): readonly BlobRetentionMeta[];
  delete(key: string): void;
}

interface SyncQuotaStore extends QuotaStore {
  getUsageBytes(accountId: string): number;
}

interface SyncEscrowStore extends EscrowStore {
  put(accountId: string, wrappedAmk: string): void;
  get(accountId: string): string | undefined;
}

interface SyncPushSubscriptionStore extends PushSubscriptionStore {
  save(record: Omit<PushSubscriptionRecord, 'createdAt'>): PushSubscriptionRecord;
  get(accountId: string, deviceId: string): PushSubscriptionRecord | undefined;
  listForAccount(accountId: string): readonly PushSubscriptionRecord[];
  delete(accountId: string, deviceId: string): void;
}

interface SyncVapidKeyStore extends VapidKeyStore {
  get(): VapidKeyPair | undefined;
  saveIfAbsent(keys: VapidKeyPair): VapidKeyPair;
}

/** The concrete return type of {@link createInMemoryRelayStore} — see {@link SyncDeviceStore}'s doc comment. */
export interface SyncRelayStore extends RelayStore {
  devices: SyncDeviceStore;
  targets: TargetStore;
  sessions: SyncSessionStore;
  blobs: SyncBlobStore;
  quota: SyncQuotaStore;
  escrow: SyncEscrowStore;
  pushSubscriptions: SyncPushSubscriptionStore;
  vapidKeys: SyncVapidKeyStore;
}

/**
 * Tracks each account's running total ciphertext-storage usage (#101, #102),
 * shared between the in-memory blob store and session store so a write in
 * either one updates the same per-account total. A running counter (kept
 * correct by having every mutation point — upload/overwrite, evict,
 * pushRingEntry — adjust it) rather than a scan-on-read sum: the in-memory
 * store already holds everything in `Map`s, so this is just as accurate and
 * avoids an O(n) walk on every quota check.
 */
interface UsageTracker {
  add(accountId: string, deltaBytes: number): void;
  get(accountId: string): number;
}

function createUsageTracker(): UsageTracker {
  const usage = new Map<string, number>();
  return {
    add(accountId, deltaBytes) {
      if (deltaBytes === 0) return;
      const next = (usage.get(accountId) ?? 0) + deltaBytes;
      usage.set(accountId, Math.max(0, next));
    },
    get(accountId) {
      return usage.get(accountId) ?? 0;
    },
  };
}

function createQuotaStore(usage: UsageTracker): SyncQuotaStore {
  return {
    getUsageBytes(accountId) {
      return usage.get(accountId);
    },
  };
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

/** A ring entry plus the account it's charged to, for usage bookkeeping (#101, #102) — never exposed outside this file; `getEntriesSince`'s public `RingEntry[]` result is a structural subset. */
interface StoredRingEntry extends RingEntry {
  accountId: string;
}

interface SessionRing {
  entries: StoredRingEntry[];
  capacity: number;
  /** Highest seq ever evicted from this ring, or undefined if nothing has been evicted yet. */
  lastEvictedSeq?: number;
}

function createSessionStore(ringBufferSize: number, usage: UsageTracker): SyncSessionStore {
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

  function evictOne(ring: SessionRing): void {
    const evicted = ring.entries.shift();
    if (!evicted) return;
    ring.lastEvictedSeq = evicted.seq;
    usage.add(evicted.accountId, -envelopeByteSize(evicted.envelope));
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
    listAllMeta() {
      return Array.from(sessions.values()).map((entry) => entry.meta);
    },
    deleteSession(sessionId) {
      sessions.delete(sessionId);
      seqCounters.delete(sessionId);
      const ring = rings.get(sessionId);
      if (ring) {
        for (const entry of ring.entries)
          usage.add(entry.accountId, -envelopeByteSize(entry.envelope));
      }
      rings.delete(sessionId);
    },
    nextSeq(sessionId) {
      const next = (seqCounters.get(sessionId) ?? 0) + 1;
      seqCounters.set(sessionId, next);
      return next;
    },
    pushRingEntry(sessionId, entry, accountId) {
      const ring = ringFor(sessionId);
      ring.entries.push({ ...entry, accountId });
      usage.add(accountId, envelopeByteSize(entry.envelope));
      while (ring.entries.length > ring.capacity) evictOne(ring);
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
    listRingEntriesForRetention() {
      const result: RingEntryRetentionMeta[] = [];
      for (const [sessionId, ring] of rings) {
        for (const entry of ring.entries) {
          result.push({
            sessionId,
            accountId: entry.accountId,
            seq: entry.seq,
            bytes: envelopeByteSize(entry.envelope),
          });
        }
      }
      return result;
    },
    pruneRingEntriesThrough(sessionId, throughSeq) {
      const ring = rings.get(sessionId);
      if (!ring) return 0;
      let deleted = 0;
      while (ring.entries.length > 0 && ring.entries[0].seq <= throughSeq) {
        evictOne(ring);
        deleted += 1;
      }
      return deleted;
    },
  };
}

/** A blob plus the account it's charged to and when it was written (#101, #102). */
interface StoredBlob {
  envelope: EncryptedEnvelope;
  accountId: string;
  createdAt: number;
}

function createBlobStore(usage: UsageTracker): SyncBlobStore {
  const blobs = new Map<string, StoredBlob>();
  return {
    upload(key, envelope, accountId) {
      const previous = blobs.get(key);
      if (previous) usage.add(previous.accountId, -envelopeByteSize(previous.envelope));
      usage.add(accountId, envelopeByteSize(envelope));
      blobs.set(key, { envelope, accountId, createdAt: Date.now() });
    },
    download(key) {
      return blobs.get(key)?.envelope;
    },
    listForRetention() {
      return Array.from(blobs.entries()).map(([key, blob]) => ({
        key,
        accountId: blob.accountId,
        bytes: envelopeByteSize(blob.envelope),
        createdAt: blob.createdAt,
      }));
    },
    delete(key) {
      const existing = blobs.get(key);
      if (existing) usage.add(existing.accountId, -envelopeByteSize(existing.envelope));
      blobs.delete(key);
    },
  };
}

function createEscrowStore(): SyncEscrowStore {
  const blobs = new Map<string, string>();
  return {
    put(accountId, wrappedAmk) {
      blobs.set(accountId, wrappedAmk);
    },
    get(accountId) {
      return blobs.get(accountId);
    },
  };
}

function pushSubscriptionKey(accountId: string, deviceId: string): string {
  return `${accountId}:${deviceId}`;
}

function createPushSubscriptionStore(): SyncPushSubscriptionStore {
  const subscriptions = new Map<string, PushSubscriptionRecord>();
  return {
    save(input) {
      const record: PushSubscriptionRecord = { ...input, createdAt: Date.now() };
      subscriptions.set(pushSubscriptionKey(input.accountId, input.deviceId), record);
      return record;
    },
    get(accountId, deviceId) {
      return subscriptions.get(pushSubscriptionKey(accountId, deviceId));
    },
    listForAccount(accountId) {
      return Array.from(subscriptions.values()).filter((record) => record.accountId === accountId);
    },
    delete(accountId, deviceId) {
      subscriptions.delete(pushSubscriptionKey(accountId, deviceId));
    },
  };
}

function createVapidKeyStore(): SyncVapidKeyStore {
  let keys: VapidKeyPair | undefined;
  return {
    get() {
      return keys;
    },
    saveIfAbsent(candidate) {
      keys ??= candidate;
      return keys;
    },
  };
}

/** Builds a fresh, per-instance in-memory `RelayStore`. Never shared across `createRelay()` calls. */
export function createInMemoryRelayStore(opts: RelayStoreOptions = {}): SyncRelayStore {
  const usage = createUsageTracker();
  return {
    devices: createDeviceStore(),
    targets: createTargetStore(),
    sessions: createSessionStore(opts.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE, usage),
    blobs: createBlobStore(usage),
    quota: createQuotaStore(usage),
    escrow: createEscrowStore(),
    pushSubscriptions: createPushSubscriptionStore(),
    vapidKeys: createVapidKeyStore(),
  };
}
