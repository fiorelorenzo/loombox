/**
 * Magic-byte image sniffing, shared by both adapter packages (SPEC.md §7.25:
 * "png/jpeg/gif/webp identified by sniffed magic bytes — never by the file's
 * declared `mimeType` or extension"). Deliberately hand-rolled rather than a
 * dependency (e.g. `file-type`, cited in SPEC.md §16's grounding for the
 * client-side check) — the handful of magic numbers this package actually
 * needs to gate the Claude inline-base64 path and name the generic
 * temp-file's extension is small and stable, and AGENTS.md's "prefer no deps
 * beyond what providers already use" rules out adding one for four checks.
 */

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
