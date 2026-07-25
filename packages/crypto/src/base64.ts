/**
 * The one `Buffer`-free base64 codec every module in this package uses.
 *
 * `@loombox/crypto` is imported by the PWA (`apps/web`'s `relay-client.ts`
 * opens every session envelope through `session-envelope.ts`'s `openJson`),
 * and `Buffer` is a Node builtin Vite does not polyfill for the browser
 * build — reaching for it on any path a browser executes throws
 * `Buffer is not defined` at runtime, which is exactly what silently broke
 * every session decrypt in the shipped PWA until this module existed.
 * `btoa`/`atob` are globals in the browser, in jsdom, and in Node 22 alike,
 * so these run identically in all three of this package's runtimes.
 *
 * `browser-safety.test.ts` enforces that no source file in this package
 * reaches for `Buffer` (or Node's `crypto` builtin) again.
 */

/** Raw bytes -> standard base64 (`+`/`/`, padded). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Standard base64 -> raw bytes. Throws (via `atob`) on a malformed input. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Raw bytes -> URL-safe base64 (`-`/`_`, unpadded) — the QR-payload encoding `pairing.ts` uses. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe base64 -> raw bytes. Accepts padded or unpadded input, and the standard alphabet too. */
export function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4));
  return base64ToBytes(standard + padding);
}
