/**
 * The Claude Code inline base64 image hand-off (issue #157; SPEC.md §7.25:
 * "The Claude Code adapter builds an inline base64 `ContentBlock::Image`,
 * gated on the session's negotiated `image` prompt capability, re-sniffing
 * the actual bytes rather than trusting the declared mimeType — no
 * filesystem write"). Issue #158 (the Codex half of the same hand-off)
 * unified this with `@loombox/providers-codex`'s identical function into
 * one real implementation, `@loombox/providers-core`'s
 * `buildInlineImageContentBlock` — SPEC.md §7.25 confirms both adapters'
 * real ACP bridges build the same inline base64 block, so "unified, not
 * special-cased" applies to this codebase's own implementation too, not
 * just the two vendors' wire behavior. Re-exported here under this
 * package's own adapter-named symbol so every existing caller/test keeps
 * calling `buildClaudeImageContentBlock`.
 *
 * Capability check: whether the real `@agentclientprotocol/claude-agent-acp`
 * bridge actually advertises `promptCapabilities.image` could not be
 * confirmed in this environment (no real binary install, no verified
 * outbound network reach — see `provider.ts`'s header comment). The shared
 * builder fails closed on that uncertainty: it never emits an image block
 * unless the session's own negotiated capabilities say so. Confirm the real
 * advertisement in issue #54 (human-gated real-binary smoke test).
 */
export { buildInlineImageContentBlock as buildClaudeImageContentBlock } from '@loombox/providers-core';
export type { InlineImageHandoffResult as ClaudeImageHandoffResult } from '@loombox/providers-core';
