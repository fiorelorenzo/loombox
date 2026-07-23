import type {
  EncryptedEnvelope,
  SessionMetaPublic,
  TargetDescriptor,
  TargetHealth,
  TargetResourceSample,
} from '@loombox/protocol';

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

/** One node's targets, plus the account that owns the connection which announced them (issue #383's account-scoping). */
export interface AccountTargets {
  nodeId: string;
  targets: readonly TargetDescriptor[];
}

/** One node's currently-announced execution targets (SPEC §5.2), keyed by nodeId. */
export interface TargetStore {
  announce(nodeId: string, accountId: string, targets: readonly TargetDescriptor[]): void;
  /** Which nodeId owns a given targetId, for routing `session_create` (relay side of #66). */
  findNodeForTarget(targetId: string): string | undefined;
  listForNode(nodeId: string): readonly TargetDescriptor[];
  /** Every node's targets this account owns (issue #383) — the relay's account-scoping for `target_list_request`, mirroring `SessionStore.listForAccount`'s isolation. */
  listForAccount(accountId: string): readonly AccountTargets[];
  /**
   * Records `nodeId`'s latest `target_status` samples (issues #253/#269).
   * Only ever records a sample for a `targetId` this `nodeId` has actually
   * announced via {@link announce} — a stray/stale `targetId` claim (e.g. a
   * late `target_status` for a target the node has since dropped from its
   * announce) is silently ignored rather than trusted, mirroring
   * `findNodeForTarget`'s own routing authority.
   */
  updateHealth(nodeId: string, samples: readonly TargetResourceSample[]): void;
  /**
   * The latest recorded health reading for `nodeId`'s `targetId`, if any has
   * arrived yet. Deliberately keyed by the *pair*, not `targetId` alone:
   * target ids are node-chosen strings (every node's default target is
   * literally `'local'`) and can collide across unrelated accounts, so a
   * lookup by bare `targetId` could return a stale reading recorded for a
   * *different* node that used to own that id — mirrors `session_create`'s
   * own "verify against the live connection, never trust a stored id alone"
   * pattern (`relay.ts`'s `nodeConnection.accountId !== connection.accountId`
   * check) rather than `findNodeForTarget`'s bare-id routing table, which is
   * safe there only because its caller re-checks the resolved node's live
   * account before using it.
   */
  healthForTarget(nodeId: string, targetId: string): TargetHealth | undefined;
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

/** One survivor device's pending rewrapped-AMK-epoch envelope, still parked at the relay awaiting fetch (SPEC §8 wrap-fan-out; issue #116). */
export interface AmkRotationPending {
  epoch: number;
  /** The acting (revoking) device that wrapped this envelope — looked up fresh from the device registry at fetch time in `relay.ts`, not trusted from storage; kept here only as the pointer. */
  fromDeviceId: string;
  envelope: EncryptedEnvelope;
}

/**
 * Per-account AMK epoch counter plus each surviving device's pending
 * rewrapped-AMK-epoch envelope (SPEC §8's wrap-fan-out delivery leg; issue
 * #116). The relay stays blind here exactly like `EscrowStore`: `envelope`
 * is opaque ciphertext, never parsed or decrypted.
 *
 * `advanceEpoch` is the relay's own defense against a stale/duplicate/
 * out-of-order `device_revoke`: it only accepts `newEpoch === currentEpoch +
 * 1`, returning whether it actually advanced, so `relay.ts` can reject the
 * whole revoke (including never persisting `rewrappedAmk`, never revoking
 * the target device) rather than silently accepting a wrong epoch number.
 */
export interface AmkRotationStore {
  /** 0 if this account has never rotated (still on its original, pre-#116 AMK). */
  getCurrentEpoch(accountId: string): Awaitable<number>;
  /** Advances the account's epoch to `newEpoch` only if it is exactly one past the current epoch; returns whether it actually advanced. */
  advanceEpoch(accountId: string, newEpoch: number): Awaitable<boolean>;
  /** Persists (overwriting any earlier pending envelope) one surviving device's rewrapped-AMK-epoch envelope. */
  putPending(accountId: string, deviceId: string, pending: AmkRotationPending): Awaitable<void>;
  /** Returns this device's own pending envelope, or `undefined` if none (already on the latest epoch, or never wrapped-for). Account-scoped: never returns another account's envelope. */
  getPending(accountId: string, deviceId: string): Awaitable<AmkRotationPending | undefined>;
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

/**
 * One session's ownership lease (SPEC §9, §7.2's same-folder safety
 * generalized across processes; issues #82/#104) — routing/coordination
 * metadata only (who owns a session, and until when), never session
 * content, so the relay legitimately arbitrates it exactly like the device
 * registry. Scoped by `accountId` so two different accounts' sessions can
 * never contend for the same lease slot, even in the (practically
 * impossible, since session ids are UUIDs) event of a `sessionId` collision
 * — the same account-isolation discipline every other store here follows.
 */
export interface LeaseRecord {
  sessionId: string;
  accountId: string;
  holderNodeId: string;
  expiresAt: number;
}

/** The result of an `acquire`/`renew` attempt against a `LeaseStore`. */
export type LeaseGrantOutcome =
  { granted: true; lease: LeaseRecord } | { granted: false; heldBy?: string; expiresAt?: number };

/**
 * The relay-side lease arbiter (issues #82/#104). Mirrors
 * `packages/node/src/ssh/session-lease.ts`'s `SessionLeaseManager`/
 * `LeaseStore` semantics — that file's own doc comment names this exact
 * store as the seam a real distributed backend slots into — now scoped by
 * `accountId` and reachable by every node over the wire (`lease_request`/
 * `lease_release`, `packages/protocol/src/v1/lease.ts`), so a Mac node and a
 * devbox node arbitrate through one shared authority instead of each
 * holding its own disconnected local state.
 */
export interface LeaseStore {
  /** Reads the current lease, including an already-expired one — expiry is a `now`-relative judgement the caller (`relay.ts`) makes, not something the store hides. */
  get(accountId: string, sessionId: string): Awaitable<LeaseRecord | undefined>;
  /** Grants iff the lease is currently unheld, already expired as of `now`, or already held by this same `nodeId` (idempotent re-acquire). */
  acquire(
    accountId: string,
    sessionId: string,
    nodeId: string,
    ttlMs: number,
    now: number,
  ): Awaitable<LeaseGrantOutcome>;
  /** Extends only if `nodeId` is the current live holder as of `now`; never grants a fresh lease to a non-holder — a renewal is never a back-door acquire. */
  renew(
    accountId: string,
    sessionId: string,
    nodeId: string,
    ttlMs: number,
    now: number,
  ): Awaitable<LeaseGrantOutcome>;
  /** Frees the lease iff currently held by `nodeId`. Returns whether it actually released — `false` for an already-free lease or one held by a different node (never releases another node's lease). */
  release(accountId: string, sessionId: string, nodeId: string): Awaitable<boolean>;
}

/** Lifecycle of a pending device-authorization request (issue #387, RFC 8628-shaped — see `device-auth.ts`'s module doc comment). */
export type DeviceAuthStatus = 'pending' | 'approved' | 'denied';

/**
 * One pending (or resolved) device-authorization request, keyed by the hash
 * of its `device_code` (issue #387). `pendingToken` is the one place this
 * package intentionally stores a *raw* secret rather than a hash: the
 * relay-minted device token must be handed back to the node verbatim on its
 * next `/device/token` poll, and it can only be revealed once — the
 * permanent record lives hashed in `device_tokens` (see
 * {@link DeviceTokenStore}) from the moment of approval, this field is
 * cleared the instant a poll actually reveals it
 * ({@link DeviceAuthStore.consumeToken}).
 */
export interface DeviceAuthRequestRecord {
  deviceCodeHash: string;
  userCode: string;
  status: DeviceAuthStatus;
  /** Set once approved — the account the resulting device token is bound to. */
  accountId?: string;
  /** See this interface's own doc comment. `undefined` before approval, and again once the node's poll has consumed it. */
  pendingToken?: string;
  createdAt: number;
  expiresAt: number;
}

export interface DeviceAuthStore {
  create(
    record: Pick<
      DeviceAuthRequestRecord,
      'deviceCodeHash' | 'userCode' | 'createdAt' | 'expiresAt'
    >,
  ): Awaitable<DeviceAuthRequestRecord>;
  getByDeviceCodeHash(deviceCodeHash: string): Awaitable<DeviceAuthRequestRecord | undefined>;
  /** Case/format-insensitive lookup is the caller's job (`device-auth.ts`'s `normalizeUserCode`) — this store matches `userCode` exactly as stored. */
  getByUserCode(userCode: string): Awaitable<DeviceAuthRequestRecord | undefined>;
  /**
   * Transitions a request from `'pending'` to `'approved'`, binding
   * `accountId` and stashing `pendingToken` for one-time reveal. Returns
   * `undefined` (no-op) if `userCode` is unknown, already expired as of
   * `now`, or not currently `'pending'` — never overwrites an
   * already-resolved request, so a delayed/duplicate approve can't silently
   * rebind a request to a different account.
   */
  approve(
    userCode: string,
    accountId: string,
    pendingToken: string,
    now: number,
  ): Awaitable<DeviceAuthRequestRecord | undefined>;
  /** Transitions a request from `'pending'` to `'denied'` — same not-found/expired/not-pending guards as {@link approve}. */
  deny(userCode: string, now: number): Awaitable<DeviceAuthRequestRecord | undefined>;
  /** Clears `pendingToken` after a `/device/token` poll has revealed it — the one-time-reveal enforcement point. Idempotent: consuming an already-consumed (or never-approved) request is a no-op. */
  consumeToken(deviceCodeHash: string): Awaitable<void>;
}

/**
 * A relay-native device token (issues #387, #398) — the bearer a resident
 * node presents once it's completed either the RFC 8628 device-authorization
 * flow (#387) or the authenticated zero-touch mint (#398), in place of a
 * Better Auth session token. Never holds the raw token; only its hash.
 * `id` is a separate, stable handle for listing/revoking a token (#398) —
 * deliberately not `tokenHash` itself, so a listing response never has to
 * reason about whether exposing a token's hash is safe.
 */
export interface DeviceTokenRecord {
  id: string;
  tokenHash: string;
  accountId: string;
  label?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface DeviceTokenStore {
  create(
    record: Pick<DeviceTokenRecord, 'id' | 'tokenHash' | 'accountId' | 'label' | 'createdAt'>,
  ): Awaitable<DeviceTokenRecord>;
  /**
   * Resolves an already-hashed device token to the account it's bound to, or
   * `undefined` if unknown — the device-token half of `relay.ts`'s
   * `AccountResolver` (checked ahead of Better Auth on every bearer, WS and
   * HTTP alike). Touches `lastUsedAt` as a side effect on a hit.
   */
  resolveByHash(tokenHash: string): Awaitable<string | undefined>;
  /** Every token minted for this account, metadata only — the raw token and its hash are never returned here (#398's `GET /account/node-tokens`). Never another account's tokens. */
  listForAccount(accountId: string): Awaitable<readonly DeviceTokenRecord[]>;
  /** Deletes a token by id, scoped to `accountId` — returns whether a row was actually deleted, so a caller can never revoke another account's token by guessing/reusing an id (#398's `DELETE /account/node-tokens/:id`). */
  revoke(id: string, accountId: string): Awaitable<boolean>;
}

export interface RelayStore {
  devices: DeviceStore;
  targets: TargetStore;
  sessions: SessionStore;
  blobs: BlobStore;
  quota: QuotaStore;
  escrow: EscrowStore;
  amkRotation: AmkRotationStore;
  pushSubscriptions: PushSubscriptionStore;
  vapidKeys: VapidKeyStore;
  leases: LeaseStore;
  deviceAuth: DeviceAuthStore;
  deviceTokens: DeviceTokenStore;
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

interface SyncAmkRotationStore extends AmkRotationStore {
  getCurrentEpoch(accountId: string): number;
  advanceEpoch(accountId: string, newEpoch: number): boolean;
  putPending(accountId: string, deviceId: string, pending: AmkRotationPending): void;
  getPending(accountId: string, deviceId: string): AmkRotationPending | undefined;
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

interface SyncLeaseStore extends LeaseStore {
  get(accountId: string, sessionId: string): LeaseRecord | undefined;
  acquire(
    accountId: string,
    sessionId: string,
    nodeId: string,
    ttlMs: number,
    now: number,
  ): LeaseGrantOutcome;
  renew(
    accountId: string,
    sessionId: string,
    nodeId: string,
    ttlMs: number,
    now: number,
  ): LeaseGrantOutcome;
  release(accountId: string, sessionId: string, nodeId: string): boolean;
}

interface SyncDeviceAuthStore extends DeviceAuthStore {
  create(
    record: Pick<
      DeviceAuthRequestRecord,
      'deviceCodeHash' | 'userCode' | 'createdAt' | 'expiresAt'
    >,
  ): DeviceAuthRequestRecord;
  getByDeviceCodeHash(deviceCodeHash: string): DeviceAuthRequestRecord | undefined;
  getByUserCode(userCode: string): DeviceAuthRequestRecord | undefined;
  approve(
    userCode: string,
    accountId: string,
    pendingToken: string,
    now: number,
  ): DeviceAuthRequestRecord | undefined;
  deny(userCode: string, now: number): DeviceAuthRequestRecord | undefined;
  consumeToken(deviceCodeHash: string): void;
}

interface SyncDeviceTokenStore extends DeviceTokenStore {
  create(
    record: Pick<DeviceTokenRecord, 'id' | 'tokenHash' | 'accountId' | 'label' | 'createdAt'>,
  ): DeviceTokenRecord;
  resolveByHash(tokenHash: string): string | undefined;
  listForAccount(accountId: string): readonly DeviceTokenRecord[];
  revoke(id: string, accountId: string): boolean;
}

/** The concrete return type of {@link createInMemoryRelayStore} — see {@link SyncDeviceStore}'s doc comment. */
export interface SyncRelayStore extends RelayStore {
  devices: SyncDeviceStore;
  targets: TargetStore;
  sessions: SyncSessionStore;
  blobs: SyncBlobStore;
  quota: SyncQuotaStore;
  escrow: SyncEscrowStore;
  amkRotation: SyncAmkRotationStore;
  pushSubscriptions: SyncPushSubscriptionStore;
  vapidKeys: SyncVapidKeyStore;
  leases: SyncLeaseStore;
  deviceAuth: SyncDeviceAuthStore;
  deviceTokens: SyncDeviceTokenStore;
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
  const accountByNode = new Map<string, string>();
  const healthByTarget = new Map<string, TargetHealth>();
  return {
    announce(nodeId, accountId, targets) {
      const previous = byNode.get(nodeId) ?? [];
      for (const target of previous) {
        if (nodeByTarget.get(target.id) === nodeId) nodeByTarget.delete(target.id);
      }
      byNode.set(nodeId, [...targets]);
      accountByNode.set(nodeId, accountId);
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
    listForAccount(accountId) {
      const result: AccountTargets[] = [];
      for (const [nodeId, owner] of accountByNode) {
        if (owner === accountId) result.push({ nodeId, targets: byNode.get(nodeId) ?? [] });
      }
      return result;
    },
    updateHealth(nodeId, samples) {
      for (const { targetId, ...health } of samples) {
        if (nodeByTarget.get(targetId) !== nodeId) continue;
        healthByTarget.set(`${nodeId}:${targetId}`, health);
      }
    },
    healthForTarget(nodeId, targetId) {
      return healthByTarget.get(`${nodeId}:${targetId}`);
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

function amkRotationPendingKey(accountId: string, deviceId: string): string {
  return `${accountId}:${deviceId}`;
}

function createAmkRotationStore(): SyncAmkRotationStore {
  const epochs = new Map<string, number>();
  const pending = new Map<string, AmkRotationPending>();
  return {
    getCurrentEpoch(accountId) {
      return epochs.get(accountId) ?? 0;
    },
    advanceEpoch(accountId, newEpoch) {
      const current = epochs.get(accountId) ?? 0;
      if (newEpoch !== current + 1) return false;
      epochs.set(accountId, newEpoch);
      return true;
    },
    putPending(accountId, deviceId, value) {
      pending.set(amkRotationPendingKey(accountId, deviceId), value);
    },
    getPending(accountId, deviceId) {
      return pending.get(amkRotationPendingKey(accountId, deviceId));
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

function leaseKey(accountId: string, sessionId: string): string {
  return `${accountId}:${sessionId}`;
}

/**
 * In-memory `LeaseStore` (issues #82/#104). Same compare-and-swap semantics
 * as `packages/node/src/ssh/session-lease.ts`'s `InMemoryLeaseStore` — see
 * that file's doc comment — reimplemented here account-scoped rather than
 * imported, since `@loombox/relay` does not depend on `@loombox/node`.
 */
function createLeaseStore(): SyncLeaseStore {
  const leases = new Map<string, LeaseRecord>();

  function grant(
    accountId: string,
    sessionId: string,
    nodeId: string,
    ttlMs: number,
    now: number,
  ): LeaseGrantOutcome {
    const lease: LeaseRecord = {
      sessionId,
      accountId,
      holderNodeId: nodeId,
      expiresAt: now + ttlMs,
    };
    leases.set(leaseKey(accountId, sessionId), lease);
    return { granted: true, lease };
  }

  return {
    get(accountId, sessionId) {
      return leases.get(leaseKey(accountId, sessionId));
    },
    acquire(accountId, sessionId, nodeId, ttlMs, now) {
      const current = leases.get(leaseKey(accountId, sessionId));
      if (current && current.holderNodeId !== nodeId && current.expiresAt > now) {
        return { granted: false, heldBy: current.holderNodeId, expiresAt: current.expiresAt };
      }
      return grant(accountId, sessionId, nodeId, ttlMs, now);
    },
    renew(accountId, sessionId, nodeId, ttlMs, now) {
      const current = leases.get(leaseKey(accountId, sessionId));
      if (!current || current.holderNodeId !== nodeId || current.expiresAt <= now) {
        return { granted: false, heldBy: current?.holderNodeId, expiresAt: current?.expiresAt };
      }
      return grant(accountId, sessionId, nodeId, ttlMs, now);
    },
    release(accountId, sessionId, nodeId) {
      const current = leases.get(leaseKey(accountId, sessionId));
      if (!current || current.holderNodeId !== nodeId) return false;
      leases.delete(leaseKey(accountId, sessionId));
      return true;
    },
  };
}

/**
 * In-memory `DeviceAuthStore` (issue #387). `approve`/`deny` both apply the
 * exact same not-found/expired/not-pending guard so a stale or duplicate
 * request can never silently rebind or re-resolve an already-settled one —
 * see the public interface's own doc comment for why that matters.
 */
function createDeviceAuthStore(): SyncDeviceAuthStore {
  const byDeviceCodeHash = new Map<string, DeviceAuthRequestRecord>();
  const byUserCode = new Map<string, DeviceAuthRequestRecord>();

  function settle(
    userCode: string,
    now: number,
    apply: (record: DeviceAuthRequestRecord) => void,
  ): DeviceAuthRequestRecord | undefined {
    const record = byUserCode.get(userCode);
    if (!record) return undefined;
    if (record.status !== 'pending' || now > record.expiresAt) return undefined;
    apply(record);
    return record;
  }

  return {
    create(input) {
      const record: DeviceAuthRequestRecord = { ...input, status: 'pending' };
      byDeviceCodeHash.set(record.deviceCodeHash, record);
      byUserCode.set(record.userCode, record);
      return record;
    },
    getByDeviceCodeHash(deviceCodeHash) {
      return byDeviceCodeHash.get(deviceCodeHash);
    },
    getByUserCode(userCode) {
      return byUserCode.get(userCode);
    },
    approve(userCode, accountId, pendingToken, now) {
      return settle(userCode, now, (record) => {
        record.status = 'approved';
        record.accountId = accountId;
        record.pendingToken = pendingToken;
      });
    },
    deny(userCode, now) {
      return settle(userCode, now, (record) => {
        record.status = 'denied';
      });
    },
    consumeToken(deviceCodeHash) {
      const record = byDeviceCodeHash.get(deviceCodeHash);
      if (record) record.pendingToken = undefined;
    },
  };
}

/** In-memory `DeviceTokenStore` (issues #387, #398) — see the public interface's doc comment. `byId` and `byHash` point at the SAME record objects, so `resolveByHash`'s `lastUsedAt` mutation is visible through either map. */
function createDeviceTokenStore(): SyncDeviceTokenStore {
  const byHash = new Map<string, DeviceTokenRecord>();
  const byId = new Map<string, DeviceTokenRecord>();
  return {
    create(input) {
      const record: DeviceTokenRecord = { ...input };
      byHash.set(record.tokenHash, record);
      byId.set(record.id, record);
      return record;
    },
    resolveByHash(tokenHash) {
      const record = byHash.get(tokenHash);
      if (!record) return undefined;
      record.lastUsedAt = Date.now();
      return record.accountId;
    },
    listForAccount(accountId) {
      return Array.from(byId.values()).filter((record) => record.accountId === accountId);
    },
    revoke(id, accountId) {
      const record = byId.get(id);
      if (!record || record.accountId !== accountId) return false;
      byId.delete(id);
      byHash.delete(record.tokenHash);
      return true;
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
    amkRotation: createAmkRotationStore(),
    pushSubscriptions: createPushSubscriptionStore(),
    vapidKeys: createVapidKeyStore(),
    leases: createLeaseStore(),
    deviceAuth: createDeviceAuthStore(),
    deviceTokens: createDeviceTokenStore(),
  };
}
