import { generateAmk } from '@loombox/crypto';

/**
 * Where this device's Account Master Key(s) are persisted (SPEC §8: "every
 * account holds one 256-bit AMK ... a device that holds the AMK can derive
 * every past and future session key by itself"). Keyed per `accountId` so a
 * browser that has ever signed into more than one loombox account keeps
 * their AMKs separate. Injectable so tests never touch the real browser
 * storage global unless they explicitly opt into a jsdom-backed one.
 *
 * v1 scope (this wave): single-device on-device custody only — the AMK is
 * generated once on this device and persisted here, full stop. It is never
 * uploaded anywhere, never wrapped for another device, and there is no
 * recovery path if this browser's storage is cleared: that is exactly the
 * recovery-code escrow / QR pairing flow SPEC §8 describes, and it is a
 * later wave (touches `packages/relay` + `packages/crypto`, both out of
 * scope here).
 */
export interface AmkStorage {
  get(accountId: string): Uint8Array | undefined;
  set(accountId: string, amk: Uint8Array): void;
  clear(accountId: string): void;
}

const STORAGE_PREFIX = 'loombox:amk:';

/**
 * `Uint8Array` <-> base64 via `btoa`/`atob` rather than `Buffer` (deliberate:
 * `Buffer` is a Node builtin Vite does not polyfill for the browser build,
 * so `relay-client.ts`'s own `randomBase64` helper was fixed alongside this
 * file to use the same approach — see that file's comment). `btoa`/`atob`
 * are globals in the browser, in jsdom, and in Node 22, so this runs
 * identically in all three of this package's runtimes.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The real, `window.localStorage`-backed `AmkStorage` (browser + jsdom). */
export function createLocalStorageAmkStorage(
  storage: Storage = globalThis.localStorage,
): AmkStorage {
  return {
    get(accountId) {
      const raw = storage.getItem(STORAGE_PREFIX + accountId);
      if (!raw) return undefined;
      try {
        return fromBase64(raw);
      } catch {
        return undefined;
      }
    },
    set(accountId, amk) {
      storage.setItem(STORAGE_PREFIX + accountId, toBase64(amk));
    },
    clear(accountId) {
      storage.removeItem(STORAGE_PREFIX + accountId);
    },
  };
}

/** An `AmkStorage` that keeps everything only in memory — the default when no browser storage is available (SSR) or wanted (tests). */
export function createInMemoryAmkStorage(): AmkStorage {
  const byAccount = new Map<string, Uint8Array>();
  return {
    get: (accountId) => byAccount.get(accountId),
    set: (accountId, amk) => {
      byAccount.set(accountId, amk);
    },
    clear: (accountId) => {
      byAccount.delete(accountId);
    },
  };
}

/**
 * Returns this device's persisted AMK for `accountId`, generating one via
 * `@loombox/crypto`'s `generateAmk` (WebCrypto CSPRNG, browser-safe — see
 * `key-tree.ts`'s doc comment) and persisting it on first use. Idempotent
 * across calls/reloads for the same `accountId` as long as `storage` isn't
 * cleared, which is the whole point: the client derives every session key
 * from this one value (`@loombox/crypto`'s `deriveSessionKey`) without
 * asking the operator to paste it in, unlike the dev-hack this replaces.
 */
export function loadOrCreateAmk(accountId: string, storage: AmkStorage): Uint8Array {
  const existing = storage.get(accountId);
  if (existing) return existing;
  const amk = generateAmk();
  storage.set(accountId, amk);
  return amk;
}
