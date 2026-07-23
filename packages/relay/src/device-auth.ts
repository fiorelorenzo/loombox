import { createHash, randomBytes } from 'node:crypto';

/**
 * Device-authorization-grant primitives (RFC 8628-shaped, SPEC §16's
 * grounding note "Short-code pairing — RFC 8628 (OAuth 2.0 Device
 * Authorization Grant); no in-repo precedent"; issue #387). Relay-native: the
 * relay itself mints and validates the resulting device token — there is no
 * external OAuth authorization server involved, this is how a headless
 * resident node (`packages/node`) authenticates without a browser ever
 * holding its bearer.
 *
 * Every secret this module hands to a caller for storage is either handed
 * back to its own bearer only (the raw `device_code`/device-token secret,
 * returned once over HTTP to the exact party that asked) or hashed before it
 * ever reaches a store (`hashDeviceSecret`) — mirroring the rest of this
 * package's "never store a raw bearer" discipline (Better Auth already
 * hashes/encrypts its own session tokens; this is the same posture for the
 * relay's own device tokens).
 */

/** SHA-256 hex digest of a raw secret (a `device_code` or a device token) — what's actually persisted (`device_auth_requests.device_code_hash` / `device_tokens.token_hash`), never the secret itself. */
export function hashDeviceSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The node-polled secret (RFC 8628's `device_code`) — long, opaque, never typed by a human. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/** The relay-minted bearer a node presents on every future connection (WS `initialize.authToken` and the `/device/*`-adjacent REST routes' `Authorization: Bearer`) — same shape/length as `generateDeviceCode`, but a distinct call site so the two secrets are never accidentally reused for each other. */
export function generateDeviceTokenSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Alphabet for the human-typable `user_code` — excludes visually ambiguous characters (`0`/`O`, `1`/`I`/`L`), same discipline as a Recovery Code (`@loombox/crypto`'s alphabet). */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const USER_CODE_GROUP_LENGTH = 4;
const USER_CODE_GROUPS = 2;

/**
 * A short, human-typable code (e.g. `WXYZ-2345`) the operator enters in the
 * browser to approve a pending device-authorization request. Not itself the
 * security boundary — `device_code` is (long, opaque, never displayed) —
 * `user_code` only needs to be hard to *guess* within its short
 * ({@link DEVICE_AUTH_EXPIRES_IN_SECONDS}) lifetime, the same trade-off
 * RFC 8628 itself makes, backstopped by this relay's existing per-IP rate
 * limit on every route including `/device/approve`.
 */
export function generateUserCode(): string {
  const length = USER_CODE_GROUP_LENGTH * USER_CODE_GROUPS;
  const bytes = randomBytes(length);
  let raw = '';
  for (let i = 0; i < length; i += 1) {
    raw += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, USER_CODE_GROUP_LENGTH)}-${raw.slice(USER_CODE_GROUP_LENGTH)}`;
}

/**
 * Normalizes operator-typed input to the exact `XXXX-XXXX` shape
 * {@link generateUserCode} produces — uppercases, strips whitespace and any
 * non-alphanumeric characters (so `wxyz 2345`, `wxyz-2345`, and `WXYZ2345`
 * all match the same stored code), then re-inserts the dash. Input that
 * doesn't decode to exactly {@link USER_CODE_GROUP_LENGTH} *
 * {@link USER_CODE_GROUPS} characters is returned cleaned-but-unformatted,
 * which simply won't match any stored `user_code` — the caller's own
 * "invalid_user_code" 404 path handles that, this function never throws.
 */
export function normalizeUserCode(input: string): string {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const expectedLength = USER_CODE_GROUP_LENGTH * USER_CODE_GROUPS;
  if (cleaned.length !== expectedLength) return cleaned;
  return `${cleaned.slice(0, USER_CODE_GROUP_LENGTH)}-${cleaned.slice(USER_CODE_GROUP_LENGTH)}`;
}

/** How long a pending device-authorization request stays alive before a poll/approve gets `'expired'` (RFC 8628's `expires_in`) — 10 minutes, long enough for an operator to notice a fresh code and switch to a browser tab, short enough that an unattended node isn't left polling for hours. */
export const DEVICE_AUTH_EXPIRES_IN_SECONDS = 600;

/** RFC 8628's `interval` — how often a well-behaved node polls `/device/token` while waiting. */
export const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;

/** The production app's default origin (SPEC §387's own issue text: "the operator approves it in the browser at app.loombox.dev") — used to build `verification_uri` when no `appUrl` is configured (`main.ts`'s `LOOMBOX_APP_URL`). */
export const DEFAULT_APP_URL = 'https://app.loombox.dev';
