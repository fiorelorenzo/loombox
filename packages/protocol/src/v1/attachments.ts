import { z } from 'zod';
import { base64String, encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Encrypted attachment blobs, addressed by an opaque `ref` (SPEC §7.25).
 * The bytes never ride the live session-update fan-out (so a multi-megabyte
 * blob can never starve another client's resync marker under the bounded-
 * queue backpressure rule, §7.16); they travel only through these dedicated
 * messages. The `ref` itself is what later travels inside an ACP
 * `ContentBlock` once the file event confirms upload.
 */

/**
 * The plaintext a `blob_ref` envelope decrypts to (SPEC §7.25's "tiny
 * encrypted file event": ref, mimeType, name, dimensions, thumbhash — never
 * the bytes; issue #154). `.strict()` so an unknown field (in particular
 * anything that would smuggle raw attachment bytes onto this side channel,
 * e.g. a `bytes`/`data`/`content` field) fails to parse rather than being
 * silently accepted — `attachments.test.ts` asserts this directly. This is
 * additive and negotiation-safe: `blob_ref` (the wire message this decrypts
 * from) already exists in the v1 message union under the pre-existing
 * `blobs` relay capability, so no new capability string or version bump is
 * needed for a peer to start sending/reading this payload shape.
 */
export const fileEventPayloadV1 = z
  .object({
    ref: z.string().min(1),
    mimeType: z.string().min(1),
    name: z.string().min(1).optional(),
    dimensions: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
    thumbhash: base64String.optional(),
  })
  .strict();
export type FileEventPayloadV1 = z.infer<typeof fileEventPayloadV1>;

/** Parses and validates a decrypted `blob_ref` file-event payload, throwing on an invalid one. */
export function parseFileEventPayloadV1(data: unknown): FileEventPayloadV1 {
  return fileEventPayloadV1.parse(data);
}

/** Same as {@link parseFileEventPayloadV1} but never throws; returns zod's result. */
export function safeParseFileEventPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, FileEventPayloadV1> {
  return fileEventPayloadV1.safeParse(data);
}

/** A client uploads an encrypted attachment blob under a client-generated opaque ref. */
export const blobUpload = z.object({
  type: z.literal('blob_upload'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  ref: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type BlobUpload = z.infer<typeof blobUpload>;

/** The tiny encrypted "file event" that rides the normal session channel once upload confirms (SPEC §7.25). `envelope` decrypts to a {@link FileEventPayloadV1} — ref, mimeType, name, dimensions, thumbhash — never the bytes. Fanned out by the relay via its direct/unbounded control path (`relay.ts`'s `fanOutDirect`), never the bounded `session_update` fan-out queue (§7.16; issue #154), so a large blob upload can never starve another client's resync marker. */
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
