import type { AcpImageContentBlock } from '@loombox/providers-core';
import { sniffImageMimeType } from '@loombox/providers-core';

/**
 * The Codex inline base64 image hand-off (SPEC.md §7.25: "The Codex adapter
 * also builds an inline base64 image: the current `codex-acp` adapter
 * converts an image block into a `data:` URL exactly like Claude (verified
 * against its source), so the two adapters' image hand-off is unified, not
 * special-cased"). Deliberately the same shape and gating as
 * `@loombox/providers-claude`'s `buildClaudeImageContentBlock` — that
 * "unified, not special-cased" is exactly what having two independent
 * functions with identical bodies (one per adapter package, so each package
 * stays self-contained per AGENTS.md's package boundaries) is meant to
 * capture, rather than one sharing a flag. Pure: takes already-decrypted
 * bytes (the supervisor fetch-and-decrypt step, §7.25, is a separate package
 * and out of scope here) and returns a content block or `undefined`, never
 * touches `node:fs`.
 *
 * Capability check: whether the real `codex-acp` bridge actually advertises
 * `promptCapabilities.image` could not be confirmed in this environment (no
 * real binary install, no verified outbound network reach). This function
 * fails closed on that uncertainty: it never emits an image block unless the
 * session's own negotiated capabilities say so, so an unconfirmed
 * advertisement degrades to the generic temp-file fallback
 * (`@loombox/providers-generic`'s `writeImageTempFile`) rather than silently
 * violating the capability contract. Confirm the real advertisement against
 * a live install in a future human-gated build-time verification spike.
 */
export function buildCodexImageContentBlock(
  bytes: Uint8Array,
  opts: { imageCapabilityNegotiated: boolean },
): AcpImageContentBlock | undefined {
  if (!opts.imageCapabilityNegotiated) return undefined;

  // Re-sniff unconditionally: a caller must never pass a declared/client
  // mimeType in here at all, so there is nothing to override, only bytes to
  // trust.
  const sniffed = sniffImageMimeType(bytes);
  if (!sniffed) return undefined;

  return {
    type: 'image',
    data: Buffer.from(bytes).toString('base64'),
    mimeType: sniffed,
  };
}
