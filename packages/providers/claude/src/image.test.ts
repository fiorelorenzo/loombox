import { describe, expect, it } from 'vitest';

import { buildClaudeImageContentBlock } from './image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);

describe('buildClaudeImageContentBlock (SPEC.md §7.25; issue #157/#158)', () => {
  it('declines with "capability-not-negotiated" when the session has not negotiated the image capability', () => {
    const result = buildClaudeImageContentBlock(PNG_BYTES, { imageCapabilityNegotiated: false });
    expect(result).toEqual({ ok: false, reason: 'capability-not-negotiated' });
  });

  it('builds an inline base64 image block when the capability is negotiated', () => {
    const result = buildClaudeImageContentBlock(PNG_BYTES, { imageCapabilityNegotiated: true });
    expect(result).toEqual({
      ok: true,
      block: {
        type: 'image',
        data: Buffer.from(PNG_BYTES).toString('base64'),
        mimeType: 'image/png',
      },
    });
  });

  it('re-sniffs the bytes rather than trusting a declared mime type', () => {
    // These bytes are genuinely JPEG; the caller has no way to pass a
    // "declared" mimeType at all — the function only ever emits the sniffed
    // one.
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const result = buildClaudeImageContentBlock(jpegBytes, { imageCapabilityNegotiated: true });
    expect(result).toEqual({ ok: true, block: expect.objectContaining({ mimeType: 'image/jpeg' }) });
  });

  it('declines with "unsupported-format" for bytes that do not sniff as a supported image format', () => {
    const notAnImage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const result = buildClaudeImageContentBlock(notAnImage, { imageCapabilityNegotiated: true });
    expect(result).toEqual({ ok: false, reason: 'unsupported-format' });
  });

  it('declines with "oversize" for a payload over the default 10 MB inline cap', () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = buildClaudeImageContentBlock(oversized, { imageCapabilityNegotiated: true });
    expect(result).toEqual({ ok: false, reason: 'oversize' });
  });
});
