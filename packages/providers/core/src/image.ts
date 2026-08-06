/**
 * Magic-byte image sniffing, shared by both adapter packages (SPEC.md §7.25:
 * "png/jpeg/gif/webp identified by sniffed magic bytes — never by the file's
 * declared `mimeType` or extension"). Deliberately hand-rolled rather than a
 * dependency (e.g. `file-type`, cited in SPEC.md §16's grounding for the
 * client-side check) — the handful of magic numbers this package actually
 * needs to gate the Claude inline-base64 path and name the generic
 * temp-file's extension is small and stable, and AGENTS.md's "prefer no deps
 * beyond what providers already use" rules out adding one for four checks.
 *
 * Also home to {@link buildInlineImageContentBlock} (issue #158): the one
 * inline base64 `ContentBlock::Image` builder both `@loombox/providers-claude`
 * and `@loombox/providers-codex` re-export under their own adapter-named
 * function (`buildClaudeImageContentBlock`/`buildCodexImageContentBlock`) —
 * SPEC.md §7.25 confirms Claude's and Codex's real ACP bridges both build the
 * identical inline base64 `data:`-style image block, so the hand-off is
 * genuinely shared, not two adapters that happen to look alike today. A
 * previous version of this codebase kept two literal copies (one per
 * package) specifically to avoid a shared dependency between adapter
 * packages; issue #158 reverses that call because "genuinely identical
 * behavior, unified" is exactly what SPEC.md §7.25 asks for, and every
 * caller (`@loombox/node`'s `deliverPrompt`) needs one capability-gated
 * decision, not a per-vendor branch.
 */

import type { AcpImageContentBlock } from './types';

/** The image formats loombox's own client-side attach step allows (SPEC.md §7.25); everything else sniffs as `undefined`. */
export type SniffedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** File extension to use for a temp file written for this sniffed type (issue #159's on-disk fallback). */
export const IMAGE_EXTENSION_BY_MIME_TYPE: Record<SniffedImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const GIF87A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const;
const GIF89A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const;
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const;

/**
 * Sniffs an image's real format from its leading bytes, ignoring any
 * caller-supplied `mimeType`/extension entirely (SPEC.md §7.25's "never
 * trust the declared mimeType" rule — this is the function both the Claude
 * inline-base64 path, issue #157, and the generic temp-file path, issue
 * #159, re-sniff through server-side). Returns `undefined` for anything that
 * doesn't match one of loombox's four allowed formats, including a
 * truncated/corrupt buffer too short to carry a full magic number.
 */
export function sniffImageMimeType(bytes: Uint8Array): SniffedImageMimeType | undefined {
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png';
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(bytes, GIF87A_MAGIC) || startsWith(bytes, GIF89A_MAGIC)) return 'image/gif';
  if (startsWith(bytes, RIFF_MAGIC) && startsWith(bytes, WEBP_MAGIC, 8)) return 'image/webp';
  return undefined;
}

/**
 * SPEC.md §7.25's client-side "10 MB per image" default, reused here as the
 * inline hand-off's own last line of defense: by the time bytes reach this
 * function they already passed the client's magic-byte + size check and the
 * relay blob store's own server-side size cap, so this only fires against a
 * client that skipped/bypassed those (a stale build, a non-web client, a
 * corrupted re-upload) — but an inline base64 block that size would still
 * bloat the agent's own stdio JSON-RPC turn by ~33% on top of it, so it's
 * worth refusing here too rather than trusting the earlier layers blindly.
 */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Why {@link buildInlineImageContentBlock} declined to build an inline block — never thrown, always returned, so a caller can degrade (SPEC.md §7.25's on-disk `resource_link` fallback) instead of failing the whole turn. */
export type InlineImageHandoffFailureReason =
  'capability-not-negotiated' | 'oversize' | 'unsupported-format';

export type InlineImageHandoffResult =
  | { ok: true; block: AcpImageContentBlock }
  | { ok: false; reason: InlineImageHandoffFailureReason };

/**
 * The inline base64 image hand-off (SPEC.md §7.25 "Hand off to the agent";
 * issue #158): "The Claude Code adapter builds an inline base64
 * `ContentBlock::Image`, gated on the session's negotiated `image` prompt
 * capability, re-sniffing the actual bytes rather than trusting the declared
 * mimeType ... The Codex adapter also builds an inline base64 image ... so
 * the two adapters' image hand-off is unified, not special-cased." One
 * function for both, since their behavior genuinely is identical: neither
 * adapter needs anything vendor-specific here, only the session's own
 * negotiated capability. Pure: takes already-decrypted bytes (the
 * supervisor's fetch-and-decrypt step, SPEC.md §7.25, is a separate package
 * and out of scope here) and never touches `node:fs` — a rejection is
 * reported back as a typed reason, never a temp file written on this path.
 *
 * Ordering: the capability gate is checked first (cheapest, and the whole
 * point of "gated on negotiated capability" — an agent that never
 * advertised `image` must never receive one regardless of the bytes), then
 * size (an oversize payload is worth rejecting before spending time
 * sniffing/base64-encoding it), then format. Capability check: whether the
 * real `codex-acp`/`claude-agent-acp` bridges actually advertise
 * `promptCapabilities.image` could not be confirmed in this environment (no
 * real binary install, no verified outbound network reach — see each
 * adapter package's `provider.ts` header comment). This function fails
 * closed on that uncertainty: it never emits an image block unless the
 * caller's own negotiated capability flag says so.
 */
export function buildInlineImageContentBlock(
  bytes: Uint8Array,
  opts: { imageCapabilityNegotiated: boolean; maxBytes?: number },
): InlineImageHandoffResult {
  if (!opts.imageCapabilityNegotiated) return { ok: false, reason: 'capability-not-negotiated' };

  const maxBytes = opts.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  if (bytes.byteLength > maxBytes) return { ok: false, reason: 'oversize' };

  // Re-sniff unconditionally: a caller must never pass a declared/client
  // mimeType in here at all, so there is nothing to override, only bytes to
  // trust (SPEC.md §7.25's "never trust the declared mimeType" rule).
  const sniffed = sniffImageMimeType(bytes);
  if (!sniffed) return { ok: false, reason: 'unsupported-format' };

  return {
    ok: true,
    block: { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: sniffed },
  };
}
