import type { EncryptedEnvelope, SessionMetaPublic, TargetDescriptor } from '@loombox/protocol';

/**
 * In-memory relay stores (SPEC §16 relay stack; `docs/v1-plan.md` Wave B).
 * The relay is a blind router (issue #315 decision 1): every store here holds
 * only routing metadata and opaque ciphertext, never plaintext. Each store is
 * a small interface so a Postgres-backed implementation (device registry #112,
 * blob store #99, session resync ring #98/#254) can slot in later without
 * touching `relay.ts`'s wiring — that swap is Wave B.2, gated on Better Auth
 * (#121) landing first so `accountId` stops being a stub.
 */

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
  upsert(record: Omit<DeviceRecord, 'registeredAt' | 'lastSeenAt' | 'status'>): DeviceRecord;
  get(deviceId: string): DeviceRecord | undefined;
  touch(deviceId: string): void;
  revoke(deviceId: string): void;
  rotate(deviceId: string, newDevicePublicKey: string): void;
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
  announce(record: SessionRecord): void;
  get(sessionId: string): SessionRecord | undefined;
  /** Account-scoped listing (SPEC §8's OAuth-alone listing) — never returns another account's sessions. */
  listForAccount(accountId: string): readonly SessionRecord[];
  /** Assigns the next monotonic seq for a session's update stream, creating the counter on first use. */
  nextSeq(sessionId: string): number;
  pushRingEntry(sessionId: string, entry: RingEntry): void;
  getEntriesSince(sessionId: string, sinceSeq: number): ResyncResult;
}

/** Opaque encrypted-blob store (#99), addressed by a caller-supplied opaque key (relay composes `sessionId:ref`). */
export interface BlobStore {
  upload(key: string, envelope: EncryptedEnvelope): void;
  download(key: string): EncryptedEnvelope | undefined;
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

function createDeviceStore(): DeviceStore {
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

function createTargetStore(): TargetStore {
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

function createSessionStore(ringBufferSize: number): SessionStore {
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

function createBlobStore(): BlobStore {
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
export function createInMemoryRelayStore(opts: RelayStoreOptions = {}): RelayStore {
  return {
    devices: createDeviceStore(),
    targets: createTargetStore(),
    sessions: createSessionStore(opts.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE),
    blobs: createBlobStore(),
  };
}
