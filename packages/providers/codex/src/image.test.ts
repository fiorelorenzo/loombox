import { describe, expect, it } from 'vitest';

import { buildCodexImageContentBlock } from './image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);

describe('buildCodexImageContentBlock', () => {
  it('returns undefined when the session has not negotiated the image capability', () => {
    const result = buildCodexImageContentBlock(PNG_BYTES, { imageCapabilityNegotiated: false });
    expect(result).toBeUndefined();
  });

  it('builds an inline base64 image block when the capability is negotiated', () => {
    const result = buildCodexImageContentBlock(PNG_BYTES, { imageCapabilityNegotiated: true });
    expect(result).toEqual({
      type: 'image',
      data: Buffer.from(PNG_BYTES).toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('re-sniffs the bytes rather than trusting a declared mime type', () => {
    // These bytes are genuinely PNG; the caller has no way to pass a
    // "declared" mimeType at all — the function only ever emits the sniffed
    // one, which this proves against a JPEG-magic buffer too.
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const result = buildCodexImageContentBlock(jpegBytes, { imageCapabilityNegotiated: true });
    expect(result?.mimeType).toBe('image/jpeg');
  });

  it('returns undefined for bytes that do not sniff as a supported image format', () => {
    const notAnImage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const result = buildCodexImageContentBlock(notAnImage, { imageCapabilityNegotiated: true });
    expect(result).toBeUndefined();
  });
});
