/**
 * The composer's local outbox (SPEC.md §7.3 "a follow-up prompt composed
 * offline queues and sends on reconnect"; §7.24's mid-turn composer state
 * bullet; issues #128/#130). Pure types plus a small persistence
 * abstraction only — no WebSocket, no crypto, no Svelte — so it is trivially
 * unit tested against real (or polyfilled) IndexedDB and reused as-is by
 * `relay-client.ts`, which owns the actual queue/flush state machine and
 * just persists/reads through whichever `OutboxStorage` it's given.
 *
 * Mirrors `amk-store.ts`'s injectable-storage pattern: a real IndexedDB-
 * backed implementation for the browser (SPEC §16: "IndexedDB outbox, NOT
 * the Background Sync API — no iOS/Safari support"), an in-memory one for
 * SSR or a test that doesn't care about persistence.
 */

/** Mirrors `relay-client.ts`'s private `PromptAttachmentRef` field-for-field — the same shape a `prompt_inject` envelope's plaintext carries. */
export interface OutboxAttachmentRef {
  ref: string;
  mimeType: string;
  name?: string;
}

/**
 * One prompt sitting in the local outbox: composed but not yet delivered to
 * the node, either because a prior turn on this session is still considered
 * in flight (SPEC §7.24) or because the relay connection is down (SPEC
 * §7.3). `id` doubles as the `promptId` this prompt sends as once flushed,
 * so a prompt's identity (and its place in `queuedAt` order) survives a
 * reload unchanged.
 */
export interface QueuedPrompt {
  id: string;
  sessionId: string;
  text: string;
  /** Only ever an attachment whose upload had already confirmed at compose time — mirrors `sendPrompt`'s existing "never send a broken ref" rule (SPEC §7.25). */
  attachments: OutboxAttachmentRef[];
  /** `Date.now()` at compose time — the flush order within a session (oldest first). */
  queuedAt: number;
}

/** The persistence surface `relay-client.ts`'s outbox state machine reads/writes through. */
export interface OutboxStorage {
  put(prompt: QueuedPrompt): Promise<void>;
  delete(id: string): Promise<void>;
  /** Every persisted prompt across every session, in no particular order — callers sort by `queuedAt` themselves. */
  list(): Promise<QueuedPrompt[]>;
}

const STORE_NAME = 'queuedPrompts';
const DB_VERSION = 1;

/**
 * The real, IndexedDB-backed `OutboxStorage`. One database per account
 * (`loombox-outbox:<accountId>`, mirroring `amk-store.ts`'s per-account
 * `localStorage` key prefix) so a browser that has ever signed into more
 * than one loombox account never mixes their queued prompts. Opens a fresh
 * connection per call rather than caching one across the object's lifetime
 * — outbox traffic is low-volume/low-frequency, and this sidesteps having
 * to manage a long-lived connection's `onversionchange`/close lifecycle for
 * a store this simple.
 */
export function createIndexedDbOutboxStorage(
  accountId: string,
  factory: IDBFactory = globalThis.indexedDB,
): OutboxStorage {
  const dbName = `loombox-outbox:${accountId}`;

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
  }

  async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = run(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });
    } finally {
      db.close();
    }
  }

  return {
    async put(prompt) {
      await withStore<IDBValidKey>('readwrite', (store) => store.put(prompt));
    },
    async delete(id) {
      await withStore<undefined>('readwrite', (store) => store.delete(id));
    },
    async list() {
      const result = await withStore<QueuedPrompt[]>(
        'readonly',
        (store) => store.getAll() as IDBRequest<QueuedPrompt[]>,
      );
      return result ?? [];
    },
  };
}

/**
 * An `OutboxStorage` that keeps everything only in memory — the fallback
 * when no `indexedDB` global is available (SSR, or a browser with it
 * disabled). Nothing here survives a real reload; that is the entire
 * purpose of {@link createIndexedDbOutboxStorage} above.
 */
export function createInMemoryOutboxStorage(): OutboxStorage {
  const byId = new Map<string, QueuedPrompt>();
  return {
    async put(prompt) {
      byId.set(prompt.id, prompt);
    },
    async delete(id) {
      byId.delete(id);
    },
    async list() {
      return [...byId.values()];
    },
  };
}

/**
 * `createIndexedDbOutboxStorage` when a real (or polyfilled, e.g.
 * `fake-indexeddb` in tests) `indexedDB` global exists,
 * `createInMemoryOutboxStorage` otherwise — never throws for an environment
 * without IndexedDB, mirroring `relay-client.ts`'s `safeCreateObjectUrl`
 * resilience style.
 */
export function createDefaultOutboxStorage(accountId: string): OutboxStorage {
  if (typeof indexedDB === 'undefined') return createInMemoryOutboxStorage();
  return createIndexedDbOutboxStorage(accountId);
}
