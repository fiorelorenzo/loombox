/**
 * Guards issue #324: `@loombox/crypto` must run identically in Node and in a
 * real browser, so it can never reach for Node's `crypto` builtin (Vite
 * externalizes that import for the browser build, so a client/PWA import
 * would throw the moment it tried to derive a key). Everything in this
 * package is built on WebCrypto (`crypto.subtle` / `crypto.getRandomValues`)
 * instead, which is a global in both runtimes.
 *
 * Same contract, second builtin: `Buffer`. Vite does not polyfill it for the
 * browser build either, and `session-envelope.ts`'s `openJson` — the path
 * the PWA takes to decrypt EVERY session's private metadata, every session
 * update, and every permission request — used to call `Buffer.from(...)`.
 * The result was a shipped web app that silently failed every decrypt with
 * `Buffer is not defined` and rendered "This device's key can't read these
 * sessions" for a perfectly valid AMK. `base64.ts`'s `btoa`/`atob` codec is
 * the replacement; this test is what stops the next one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveChild, deriveKeyTree } from './key-tree';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

// Joined at runtime so this file's own source text never contains the
// forbidden specifier verbatim — otherwise a scan of the package would
// always "find" a hit right here, in the file doing the checking.
const FORBIDDEN_SPECIFIER = ['node', 'crypto'].join(':');

// Matches a real USE of the global (`Buffer.from`, `Buffer.alloc`, a
// `Buffer(...)` call) rather than any mention of the word, so a doc comment
// explaining why this package avoids it — `base64.ts` has one — doesn't
// trip the guard. Assembled at runtime for the same reason as above.
const FORBIDDEN_GLOBAL_USE = new RegExp(`\\b${['Buf', 'fer'].join('')}\\s*[.(]`);

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('browser safety (issue #324)', () => {
  const sources = listTsFiles(SRC_DIR)
    .filter((file) => file !== THIS_FILE)
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it("never references Node's crypto builtin anywhere under packages/crypto/src", () => {
    const offenders = sources
      .filter((source) => source.text.includes(FORBIDDEN_SPECIFIER))
      .map((source) => source.file);

    expect(offenders).toEqual([]);
  });

  it("never references Node's Buffer global in non-test sources", () => {
    const offenders = sources
      .filter((source) => !source.file.endsWith('.test.ts'))
      .filter((source) => FORBIDDEN_GLOBAL_USE.test(source.text))
      .map((source) => source.file);

    expect(offenders).toEqual([]);
  });

  it('still derives the documented known-answer bytes via WebCrypto HMAC-SHA512', async () => {
    const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
    const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
    const amk = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

    const child = await deriveChild(amk, new TextEncoder().encode('m/0'));
    const node = await deriveKeyTree(amk, ['m/0']);

    expect(bytesToHex(child.key)).toBe(
      'f4e12c3329735f680f2fa9dedcd32137bcb32520cc17961b695286d58ee98201',
    );
    expect(bytesToHex(node.key)).toBe(bytesToHex(child.key));
  });
});
