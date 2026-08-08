/* ---------------------------------------------------------------------
 * Shared "read this JSON file off disk, treat a missing file as empty,
 * wrap a parse failure in a typed error" scaffolding that thirteen node
 * store classes in this package used to hand-roll independently (issue
 * #922, following on from #652's duplicate sweep). Byte-for-byte
 * identical across all thirteen except for what each store's own
 * `Error` subclass and default/empty file shape are — this module owns
 * exactly that shared shape and nothing else. A store keeps its own
 * on-disk type, its own field-level `validateFile` schema, and its own
 * `Error` subclass; `loadJsonFile` below only owns the three steps that
 * never varied: no file → the caller's default, a file that isn't valid
 * JSON → the caller's error with one shared wording, anything else →
 * the caller's own schema validation.
 *
 * Already visibly drifted before this: 8 of the 13 stores worded the
 * parse-failure message "config file ... is not valid JSON", 5 said
 * plain "file ... is not valid JSON" for the identical condition. This
 * module settles on "file" — several adopters below persist state that
 * was never really "config" (`spend-ledger-store.ts`'s accumulated
 * ledger rows, `ci-watch-store.ts`'s in-flight watch set,
 * `session-store.ts`'s session records), so "file" is the wording that
 * describes all thirteen without stretching the word "config" over the
 * ones that aren't.
 *
 * Deliberately NOT adopted by every JSON-file reader in `packages/node`,
 * because not every one of them shares this loader's "throw a typed
 * error on a corrupt file" contract:
 *
 * - `SessionTitleStore` (`session-title-store.ts`) is explicitly
 *   best-effort by its own doc comment: a corrupt file degrades to
 *   "title unknown" rather than ever throwing, because a title is
 *   cosmetic and must never block session revival.
 * - `FileKeyringBackend` (`keyring.ts`) and `SshTargetStore`
 *   (`ssh/verify-and-persist.ts`) both silently return an empty
 *   collection on a corrupt file rather than throwing.
 * - `DeviceTokenFileStore` (`device-token-store.ts`, already checked and
 *   excluded by issue #922 itself) returns `undefined` on a parse
 *   failure instead of throwing — a missing/corrupt token means "not
 *   signed in", not an error.
 *
 * All four silently swallow a corrupt file instead of throwing — a
 * different recovery contract, not a wording variant of this one.
 * Routing them through `loadJsonFile` would mean inventing a
 * `makeError` callback none of them ever calls, which would blur the
 * one guarantee this loader exists to make: every adopter below throws
 * a typed error for a syntactically corrupt file, no exceptions. If one
 * of those four is later deliberately changed to throw instead of
 * swallow, that is its own behaviour change with its own reasoning, not
 * a side effect of adopting this loader.
 *
 * `config.ts`'s `loadConfig`/env-var parsing and `identity.ts`'s
 * `NodeIdentityStore.load()` were also checked: `config.ts` is a set of
 * standalone startup functions with no `this.filePath`-owning class, and
 * `NodeIdentityStore.load()` reads from an OS keyring first with the
 * file only a fallback — neither is a fourteenth copy of this shape.
 * --------------------------------------------------------------------- */

import { existsSync, readFileSync } from 'node:fs';

/**
 * Loads and parses a store's on-disk JSON file.
 *
 * - No file at `filePath` → returns `defaultValue` (a fresh node with
 *   nothing saved yet — never an error).
 * - File exists but isn't valid JSON → throws `makeError(message)`,
 *   `message` being the one shared wording every adopting store now
 *   shares: `file "<path>" is not valid JSON: <detail>`.
 * - File exists and parses → returns `parse(parsedJson, filePath)`, the
 *   caller's own field-level schema validation. Any error `parse` itself
 *   throws (a record failing a store's own schema) propagates unchanged
 *   — that validation, and the `Error` subclass it throws, stays
 *   entirely store-owned; this loader never sees or wraps it.
 */
export function loadJsonFile<T>(
  filePath: string,
  defaultValue: T,
  parse: (parsed: unknown, filePath: string) => T,
  makeError: (message: string) => Error,
): T {
  if (!existsSync(filePath)) {
    return defaultValue;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw makeError(`file "${filePath}" is not valid JSON: ${detail}`);
  }
  return parse(parsed, filePath);
}
