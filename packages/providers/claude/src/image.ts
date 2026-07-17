import type { AcpImageContentBlock } from '@loombox/providers-core';
import { sniffImageMimeType } from '@loombox/providers-core';

/**
 * The Claude Code inline base64 image hand-off (issue #157; SPEC.md §7.25:
 * "The Claude Code adapter builds an inline base64 `ContentBlock::Image`,
 * gated on the session's negotiated `image` prompt capability, re-sniffing
 * the actual bytes rather than trusting the declared mimeType — no
 * filesystem write"). Pure: takes already-decrypted bytes (the supervisor
 * fetch-and-decrypt step, §7.25, is a separate package and out of scope
 * here) and returns a content block or `undefined`, never touches
 * `node:fs`.
 *
 * Capability check: whether the real `@zed-industries/claude-code-acp`
 * bridge actually advertises `promptCapabilities.image` could not be
 * confirmed in this environment (no real binary install, no verified
 * outbound network reach — see `provider.ts`'s header comment). This
 * function fails closed on that uncertainty: it never emits an image block
 * unless the session's own negotiated capabilities say so, so an
 * unconfirmed advertisement degrades to the generic temp-file fallback
 * (`@loombox/providers-generic`'s `writeImageTempFile`) rather than
 * silently violating the capability contract. Confirm the real
 * advertisement in issue #54 (human-gated real-binary smoke test).
 */
export function buildClaudeImageContentBlock(
  bytes: Uint8Array,
  opts: { imageCapabilityNegotiated: boolean },
): AcpImageContentBlock | undefined {
  if (!opts.imageCapabilityNegotiated) return undefined;

  // Re-sniff unconditionally: a caller must never pass a declared/client
  // mimeType in here at all, so there is nothing to override, only bytes
  // to trust.
  const sniffed = sniffImageMimeType(bytes);
  if (!sniffed) return undefined;

  return {
    type: 'image',
    data: Buffer.from(bytes).toString('base64'),
    mimeType: sniffed,
  };
}
