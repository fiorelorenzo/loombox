import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Encrypted attachment blobs, addressed by an opaque `ref` (SPEC §7.25).
 * The bytes never ride the live session-update fan-out (so a multi-megabyte
 * blob can never starve another client's resync marker under the bounded-
 * queue backpressure rule, §7.16); they travel only through these dedicated
 * messages. The `ref` itself is what later travels inside an ACP
 * `ContentBlock` once the file event confirms upload.
 */

/** A client uploads an encrypted attachment blob under a client-generated opaque ref. */
export const blobUpload = z.object({
  type: z.literal('blob_upload'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  ref: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type BlobUpload = z.infer<typeof blobUpload>;

/** The tiny encrypted "file event" (ref, mimeType, name, dimensions, thumbhash — never the bytes) that rides the normal session channel once upload confirms (SPEC §7.25). */
export const blobRef = z.object({
  type: z.literal('blob_ref'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  ref: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type BlobRef = z.infer<typeof blobRef>;

/** The agent-supervisor (or a client re-fetching its own attachment) requests a blob's ciphertext by ref. */
export const blobDownload = z.object({
  type: z.literal('blob_download'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  ref: z.string().min(1),
});
export type BlobDownload = z.infer<typeof blobDownload>;

/** The relay's reply to a `blobDownload`: the same opaque ciphertext blob previously uploaded under `ref`. */
export const blobDownloadResponse = z.object({
  type: z.literal('blob_download_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  ref: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type BlobDownloadResponse = z.infer<typeof blobDownloadResponse>;
