import { describe, expect, it } from 'vitest';
import {
  blobDownload,
  blobDownloadResponse,
  blobRef,
  blobUpload,
  fileEventPayloadV1,
  parseFileEventPayloadV1,
  safeParseFileEventPayloadV1,
} from './attachments';

const validEnvelope = {
  resourceId: 'blob:ref-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

describe('blobUpload', () => {
  const valid = {
    type: 'blob_upload',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  };

  it('parses a valid blobUpload', () => {
    expect(blobUpload.parse(valid)).toEqual(valid);
  });

  it('rejects a missing ref', () => {
    const { ref: _ref, ...rest } = valid;
    expect(() => blobUpload.parse(rest)).toThrow();
  });
});

describe('blobRef', () => {
  const valid = {
    type: 'blob_ref',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  };

  it('parses a valid blobRef file event', () => {
    expect(blobRef.parse(valid)).toEqual(valid);
  });

  it('rejects a malformed envelope', () => {
    expect(() => blobRef.parse({ ...valid, envelope: { ...validEnvelope, iv: 'x' } })).toThrow();
  });
});

describe('fileEventPayloadV1 (the plaintext a blob_ref envelope decrypts to, issue #154)', () => {
  const full = {
    ref: 'ref-1',
    mimeType: 'image/png',
    name: 'photo.png',
    dimensions: { width: 800, height: 600 },
    thumbhash: 'aGVsbG8=',
  };

  it('parses a full file event (ref, mimeType, name, dimensions, thumbhash)', () => {
    expect(fileEventPayloadV1.parse(full)).toEqual(full);
  });

  it('parses a minimal file event (only the required ref + mimeType)', () => {
    const minimal = { ref: 'ref-2', mimeType: 'image/jpeg' };
    expect(fileEventPayloadV1.parse(minimal)).toEqual(minimal);
  });

  it('rejects a missing ref', () => {
    const { ref: _ref, ...rest } = full;
    expect(() => fileEventPayloadV1.parse(rest)).toThrow();
  });

  it('rejects a missing mimeType', () => {
    const { mimeType: _mimeType, ...rest } = full;
    expect(() => fileEventPayloadV1.parse(rest)).toThrow();
  });

  it('rejects non-positive/non-integer dimensions', () => {
    expect(() =>
      fileEventPayloadV1.parse({ ...full, dimensions: { width: 0, height: 600 } }),
    ).toThrow();
    expect(() =>
      fileEventPayloadV1.parse({ ...full, dimensions: { width: 800.5, height: 600 } }),
    ).toThrow();
  });

  it('rejects a non-base64 thumbhash', () => {
    expect(() => fileEventPayloadV1.parse({ ...full, thumbhash: 'not base64!' })).toThrow();
  });

  // The core acceptance criterion (SPEC §7.25/§7.16, issue #154): this
  // payload NEVER carries the attachment bytes themselves, only metadata
  // describing where/what they are. `.strict()` proves that concretely — an
  // attempt to smuggle raw bytes onto this side channel under any
  // plausible field name is rejected outright rather than silently
  // stripped or accepted.
  it.each(['bytes', 'data', 'content', 'blob', 'body'])(
    'rejects an unknown field %s (no byte-carrying field can ever exist on this schema)',
    (fieldName) => {
      const withExtra = { ...full, [fieldName]: 'aGVsbG8gd29ybGQ=' };
      expect(() => fileEventPayloadV1.parse(withExtra)).toThrow();
      expect(safeParseFileEventPayloadV1(withExtra).success).toBe(false);
    },
  );

  it('the schema shape itself has no key literally named "bytes"/"data"/"content"/"body"', () => {
    const keys = Object.keys(fileEventPayloadV1.shape);
    expect(keys).toEqual(['ref', 'mimeType', 'name', 'dimensions', 'thumbhash']);
    for (const forbidden of ['bytes', 'data', 'content', 'body', 'blob']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('parseFileEventPayloadV1/safeParseFileEventPayloadV1 behave like the schema directly', () => {
    expect(parseFileEventPayloadV1(full)).toEqual(full);
    expect(safeParseFileEventPayloadV1(full)).toEqual({ success: true, data: full });
    expect(safeParseFileEventPayloadV1({}).success).toBe(false);
  });
});

describe('blobDownload', () => {
  const valid = { type: 'blob_download', protocolVersion: 1, sessionId: 'sess-1', ref: 'ref-1' };

  it('parses a valid blobDownload request (no bytes carried)', () => {
    expect(blobDownload.parse(valid)).toEqual(valid);
  });

  it('rejects a missing sessionId', () => {
    const { sessionId: _sessionId, ...rest } = valid;
    expect(() => blobDownload.parse(rest)).toThrow();
  });
});

describe('blobDownloadResponse', () => {
  const valid = {
    type: 'blob_download_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  };

  it('parses a valid blobDownloadResponse', () => {
    expect(blobDownloadResponse.parse(valid)).toEqual(valid);
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => blobDownloadResponse.parse({ ...valid, type: 'blob_ref' })).toThrow();
  });
});
