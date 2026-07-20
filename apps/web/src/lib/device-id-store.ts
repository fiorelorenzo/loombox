/**
 * This browser's own stable device id, persisted across reloads (issue
 * #163's presence check). `RelayClient` generates a fresh random one by
 * default when none is passed (`relay-client.ts`'s `generateId('device')`),
 * which is fine for the WS handshake alone, but a Web Push subscription
 * (#162) is meaningless unless it is registered under the SAME device id
 * the live WS connection uses — the relay's presence check (#163) matches a
 * push subscription's `deviceId` against `registry.clients`' connected
 * devices to decide whether to suppress the push, so a device id that
 * changes every reload would make every subscription immediately "stale"
 * and the presence check always miss. `+page.svelte` passes this store's id
 * into `RelayClientOptions.deviceId` so the WS connection and the push
 * subscription always agree. Same injectable-storage pattern as
 * `amk-store.ts`.
 */
export interface DeviceIdStorage {
  get(): string | undefined;
  set(deviceId: string): void;
}

const STORAGE_KEY = 'loombox:device-id';

/** The real, `window.localStorage`-backed `DeviceIdStorage` (browser + jsdom). */
export function createLocalStorageDeviceIdStorage(
  storage: Storage = globalThis.localStorage,
): DeviceIdStorage {
  return {
    get() {
      return storage.getItem(STORAGE_KEY) ?? undefined;
    },
    set(deviceId) {
      storage.setItem(STORAGE_KEY, deviceId);
    },
  };
}

/** An in-memory `DeviceIdStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryDeviceIdStorage(): DeviceIdStorage {
  let current: string | undefined;
  return {
    get: () => current,
    set: (deviceId) => {
      current = deviceId;
    },
  };
}

/**
 * Same `${prefix}_${unique}` shape as `relay-client.ts`'s own (private)
 * `generateId` — not imported from there (this module has no dependency on
 * `relay-client.ts`, deliberately, to stay a small standalone piece) but
 * structurally identical, since the relay treats every device id as an
 * opaque string regardless of which generator produced it.
 */
function generateDeviceId(): string {
  const hasRandomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const unique = hasRandomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `device_${unique}`;
}

/**
 * Returns this browser's persisted device id, generating and persisting one
 * on first call. Idempotent: every later call on the same `storage` returns
 * the same id. `generate` is injectable for tests that need a deterministic
 * id; defaults to {@link generateDeviceId}.
 */
export function loadOrCreateDeviceId(
  storage: DeviceIdStorage,
  generate: () => string = generateDeviceId,
): string {
  const existing = storage.get();
  if (existing) return existing;
  const created = generate();
  storage.set(created);
  return created;
}
