import { z } from 'zod';

import type { WireRole } from './handshake';

/**
 * The relay's own compatibility window (issue #657; epic #653): the oldest
 * node build and the oldest client build this relay still SERVES, declared
 * as data rather than folklore. Before this, "which combinations are
 * supported" had no answer anywhere — #655 gave a peer a build identity to
 * announce, but nothing on the relay side ever read it for anything besides
 * the "Behind" badge (`buildIdentityMismatch`, which deliberately refuses to
 * say WHICH side is behind). This is the missing rule: a floor per role,
 * and a peer below it is refused via the same `update_required` path #108
 * already uses for an incompatible protocol version — refused means outside
 * the window, the existing "Behind" badge means inside it.
 *
 * Both bounds are independently optional, mirroring `buildIdentityV1`'s own
 * "absent means don't know / don't enforce" convention: an unset floor
 * serves every build of that role, which is every relay running today (no
 * env var configures this yet — see `@loombox/relay`'s `compat-window.ts`)
 * and every existing hermetic test, none of which pass this option.
 */
export const compatibilityWindowV1 = z.object({
  minNodeVersion: z.string().min(1).optional(),
  minClientVersion: z.string().min(1).optional(),
});
export type CompatibilityWindowV1 = z.infer<typeof compatibilityWindowV1>;

/**
 * Segment-by-segment dotted-numeric comparison (`"1.2.0"` vs `"1.10.0"` —
 * a plain string compare would wrongly rank the latter first). Returns
 * negative/zero/positive like `Array.prototype.sort`'s comparator. Falls
 * back to a plain string compare for the whole pair the moment either
 * version has a non-numeric segment (e.g. a `-rc1` suffix), rather than
 * silently coercing it to `0` and risking a wrong verdict.
 *
 * This is the one place in this package allowed to compare build versions
 * by ORDER rather than equality — {@link buildIdentityMismatch} in
 * `./handshake.ts` refuses to, on purpose (see its own doc comment): a bare
 * mismatch never implies which side is newer, only a deliberately-declared
 * floor like {@link CompatibilityWindowV1} does. `@loombox/node`'s
 * `ssh/target-update-monitor.ts` re-exports this as its own
 * `compareVersions` rather than keeping a second, independently-maintained
 * copy of the same algorithm — that module compares a target's supervisor
 * version against a pinned one, a different question than this one answers,
 * but the underlying "which dotted version is newer" arithmetic is
 * identical, and belongs in exactly one place.
 */
export function compareBuildVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number.parseInt(as[i] ?? '0', 10);
    const bv = Number.parseInt(bs[i] ?? '0', 10);
    if (Number.isNaN(av) || Number.isNaN(bv)) {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    }
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Whether `peerVersion` falls below `window`'s floor for `role` — the one
 * check the relay's `initialize` handler runs to decide REFUSAL (see
 * `@loombox/relay`'s `relay.ts`), as opposed to `buildIdentityMismatch`'s
 * "Behind" badge, which only ever surfaces. `false` whenever there is
 * nothing to enforce: no window configured, no floor set for this role, or
 * the peer's own version is unknown — the same "unknown never reads as
 * behind" rule {@link buildIdentityMismatch} follows, so a peer that
 * predates `buildIdentity` entirely (nothing to measure against) is let
 * through unchanged, exactly as it is today.
 */
export function isBelowCompatWindow(
  window: CompatibilityWindowV1 | undefined,
  role: WireRole,
  peerVersion: string | undefined,
): boolean {
  if (!window || !peerVersion) return false;
  const floor = role === 'node' ? window.minNodeVersion : window.minClientVersion;
  if (!floor) return false;
  return compareBuildVersions(peerVersion, floor) < 0;
}
