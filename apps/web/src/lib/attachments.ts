/**
 * Client-side image attachment pipeline (SPEC.md §7.25; issues #151/#152/
 * #153/#155). Pure, DOM-free logic and types only — no WebSocket, no crypto,
 * no Svelte — so magic-byte validation is trivially unit tested against raw
 * bytes and reused identically by `relay-client.ts` (the encrypt+upload
 * wiring) and `components/AttachmentBar.svelte` (the picker/preview UI).
 *
 * Defaults (10 MB/image, 20 images/prompt, png/jpeg/gif/webp) follow happy's
 * own image-handling limits per SPEC §7.25/§16
 * (`packages/happy-server/sources/storage/processImage.ts`,
 * `packages/happy-app/sources/hooks/useImagePicker.ts`) — reimplemented
 * clean-room here, not vendored.
 */

/** 10 MB, matching happy's own per-image cap (SPEC §7.25). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** 20 images per prompt, matching happy's own cap (SPEC §7.25). */
export const MAX_ATTACHMENTS_PER_PROMPT = 20;

export type SniffedImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'heic' | 'unknown';

export type AttachmentRejectionReason =
  'too-large' | 'unsupported-type' | 'heic-unsupported' | 'too-many';

export interface AttachmentValidationOk {
  ok: true;
  mimeType: string;
}

export interface AttachmentValidationFailed {
  ok: false;
  reason: AttachmentRejectionReason;
  message: string;
}

export type AttachmentValidationResult = AttachmentValidationOk | AttachmentValidationFailed;

/**
 * The minimal `File`/`Blob` surface this module needs — satisfied by the
 * real browser `File`, Node 22's global `File` (used by the hermetic
 * tests), and any test fake with the same shape. Never inspects `.type`
 * (the declared mimeType) or the file name's extension for validation —
 * only the sniffed bytes (SPEC §7.25: "never by the file's declared
 * `mimeType` or extension, since mobile pickers routinely misreport both").
 */
export interface AttachableFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let value = '';
  for (let i = 0; i < length; i++) value += String.fromCharCode(bytes[offset + i]);
  return value;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF87A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

/**
 * ISOBMFF `ftyp` brands that identify a HEIC/HEIF file (the HEIF spec's own
 * registered major/compatible brands for a still HEIC image or an HEIF image
 * collection) — deliberately narrow: this must catch actual HEIC/HEIF camera
 * output, never a false positive on an unrelated ISOBMFF-family file.
 */
const HEIC_HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

const MIME_TYPES: Record<'png' | 'jpeg' | 'gif' | 'webp', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Identifies an image's real format from its sniffed magic bytes — never
 * from a declared `mimeType` or file extension (SPEC §7.25). Returns
 * `'unknown'` for anything unrecognized, including formats loombox doesn't
 * support (e.g. bmp, svg, avif) — those are rejected generically by
 * {@link validateAttachmentBytes}, not folded into `'heic'`.
 */
export function sniffImageType(bytes: Uint8Array): SniffedImageKind {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg';
  if (startsWith(bytes, GIF87A_SIGNATURE) || startsWith(bytes, GIF89A_SIGNATURE)) return 'gif';
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return 'webp';
  }
  if (
    bytes.length >= 12 &&
    asciiAt(bytes, 4, 4) === 'ftyp' &&
    HEIC_HEIF_BRANDS.has(asciiAt(bytes, 8, 4).toLowerCase())
  ) {
    return 'heic';
  }
  return 'unknown';
}

/**
 * The single source of truth for issue #151's size/type gate and issue
 * #152's HEIC/HEIF rejection: size first (cheapest check), then the sniffed
 * magic bytes — both before any upload is ever attempted. A spoofed file
 * (real bytes of one format, a `.png` name or an `image/png` declared type)
 * is judged purely on its bytes, so it either validates as what it actually
 * is or is rejected — it can never sneak through disguised as an allowed
 * type it isn't.
 */
export function validateAttachmentBytes(bytes: Uint8Array): AttachmentValidationResult {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `Image exceeds the ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB attachment limit.`,
    };
  }
  const kind = sniffImageType(bytes);
  if (kind === 'heic') {
    return {
      ok: false,
      reason: 'heic-unsupported',
      message:
        "This looks like a HEIC/HEIF photo, which browsers can't preview. Convert it to JPEG or PNG and re-upload.",
    };
  }
  if (kind === 'unknown') {
    return {
      ok: false,
      reason: 'unsupported-type',
      message: 'Unsupported image type — attach a PNG, JPEG, GIF, or WEBP image.',
    };
  }
  return { ok: true, mimeType: MIME_TYPES[kind] };
}

/** The composer-visible lifecycle of one attached image (SPEC §7.25). */
export type ComposerAttachmentStatus = 'uploading' | 'uploaded' | 'failed' | 'rejected';

export interface ComposerAttachment {
  /** Client-generated id; also doubles as the blob's opaque `ref` on the wire (SPEC §7.25). */
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** An object URL for the instant local preview (SPEC §7.25); unset once revoked (sent or removed). */
  previewUrl: string | undefined;
  status: ComposerAttachmentStatus;
  /** A user-facing message for a `'failed'` or `'rejected'` attachment. */
  error: string | undefined;
}

/**
 * Issue #155's send-gate: the composer's send action is disabled while any
 * attachment is still mid-upload or sits in a failed state. A `'rejected'`
 * attachment (SPEC §7.25: rejected before any upload attempt) never blocks
 * sending — it was never going to be referenced in the prompt anyway.
 */
export function hasBlockingAttachments(attachments: ComposerAttachment[]): boolean {
  return attachments.some((a) => a.status === 'uploading' || a.status === 'failed');
}

/**
 * The AAD-binding resource id an attachment blob is sealed/opened under
 * (SPEC §8's swap/spoof-fix binding) — matches exactly how the relay itself
 * keys its blob store (`packages/relay/src/relay.ts`: `` `${sessionId}:${ref}` ``)
 * and how `@loombox/node`'s `AttachmentResolver` derives the same id on the
 * decrypting side (`packages/node/src/attachments.ts`'s `attachmentResourceId`).
 * Reimplemented here (one line) rather than imported from `@loombox/node`,
 * which this package must not depend on or modify.
 */
export function attachmentResourceId(sessionId: string, ref: string): string {
  return `${sessionId}:${ref}`;
}
