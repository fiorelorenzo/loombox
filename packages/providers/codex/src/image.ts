/**
 * The Codex inline base64 image hand-off (SPEC.md §7.25: "The Codex adapter
 * also builds an inline base64 image: the current `codex-acp` adapter
 * converts an image block into a `data:` URL exactly like Claude (verified
 * against its source), so the two adapters' image hand-off is unified, not
 * special-cased"). Issue #158's own acceptance is what flips the earlier
 * "identical bodies, kept separate for package-boundary reasons" call this
 * module's history used to defend: `@loombox/providers-core`'s
 * `buildInlineImageContentBlock` is now the single real implementation —
 * re-exported here under this package's own adapter-named symbol so
 * `@loombox/node`'s `deliverPrompt` and this package's own tests keep
 * calling `buildCodexImageContentBlock`, with an obvious seam to grow a real
 * Codex-specific override into later if the two adapters' behavior ever
 * genuinely diverges.
 *
 * Capability check: whether the real `codex-acp` bridge actually advertises
 * `promptCapabilities.image` could not be confirmed in this environment (no
 * real binary install, no verified outbound network reach). The shared
 * builder fails closed on that uncertainty: it never emits an image block
 * unless the session's own negotiated capabilities say so. Confirm the real
 * advertisement against a live install in a future human-gated build-time
 * verification spike.
 */
export { buildInlineImageContentBlock as buildCodexImageContentBlock } from '@loombox/providers-core';
export type { InlineImageHandoffResult as CodexImageHandoffResult } from '@loombox/providers-core';
