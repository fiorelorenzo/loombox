import { describe, expect, it } from 'vitest';

import { buildInlineImageContentBlock, IMAGE_EXTENSION_BY_MIME_TYPE, sniffImageMimeType } from './image';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('sniffImageMimeType', () => {
  it('identifies a PNG by its 8-byte signature', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
    expect(sniffImageMimeType(png)).toBe('image/png');
  });

  it('identifies a JPEG by its FF D8 FF prefix', () => {
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
    expect(sniffImageMimeType(jpeg)).toBe('image/jpeg');
  });

  it('identifies a GIF87a and GIF89a', () => {
    const gif87a = bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61);
    const gif89a = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    expect(sniffImageMimeType(gif87a)).toBe('image/gif');
    expect(sniffImageMimeType(gif89a)).toBe('image/gif');
  });

  it('identifies a WEBP by its RIFF....WEBP wrapper', () => {
    // 'RIFF' + 4 arbitrary size bytes + 'WEBP'
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    expect(sniffImageMimeType(webp)).toBe('image/webp');
  });

  it('does not confuse a plain RIFF file (e.g. WAV) for WEBP', () => {
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
    expect(sniffImageMimeType(wav)).toBeUndefined();
  });

  it('returns undefined for an unrecognized format', () => {
    expect(sniffImageMimeType(bytes(0x00, 0x01, 0x02, 0x03))).toBeUndefined();
  });

  it('returns undefined rather than throwing on a truncated buffer', () => {
    expect(sniffImageMimeType(bytes(0x89, 0x50))).toBeUndefined();
    expect(sniffImageMimeType(new Uint8Array())).toBeUndefined();
  });

  it('ignores a declared mime type entirely — sniffing is byte-content-only', () => {
    // A buffer whose bytes are genuinely PNG, mislabeled as JPEG by a caller
    // that trusted a (wrong) client-declared mimeType: sniffing still wins.
    const mislabeledPng = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(sniffImageMimeType(mislabeledPng)).toBe('image/png');
  });
});

describe('IMAGE_EXTENSION_BY_MIME_TYPE', () => {
  it('has an extension for every sniffable mime type', () => {
    expect(IMAGE_EXTENSION_BY_MIME_TYPE['image/png']).toBe('png');
    expect(IMAGE_EXTENSION_BY_MIME_TYPE['image/jpeg']).toBe('jpg');
    expect(IMAGE_EXTENSION_BY_MIME_TYPE['image/gif']).toBe('gif');
    expect(IMAGE_EXTENSION_BY_MIME_TYPE['image/webp']).toBe('webp');
  });
});

describe('buildInlineImageContentBlock (SPEC.md §7.25; issue #158)', () => {
  const PNG_BYTES = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb);

  it('declines when the session has not negotiated the image capability', () => {
    const result = buildInlineImageContentBlock(PNG_BYTES, { imageCapabilityNegotiated: false });
    expect(result).toEqual({ ok: false, reason: 'capability-not-negotiated' });
  });

  it('builds an inline base64 image block when the capability is negotiated', () => {
    const result = buildInlineImageContentBlock(PNG_BYTES, { imageCapabilityNegotiated: true });
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
    const jpegBytes = bytes(0xff, 0xd8, 0xff, 0xe0);
    const result = buildInlineImageContentBlock(jpegBytes, { imageCapabilityNegotiated: true });
    expect(result).toEqual({ ok: true, block: expect.objectContaining({ mimeType: 'image/jpeg' }) });
  });

  it('declines with "unsupported-format" for bytes that do not sniff as a supported image', () => {
    const notAnImage = bytes(0x00, 0x01, 0x02, 0x03);
    const result = buildInlineImageContentBlock(notAnImage, { imageCapabilityNegotiated: true });
    expect(result).toEqual({ ok: false, reason: 'unsupported-format' });
  });

  it('declines with "oversize" for a payload over the default 10 MB cap, even when the capability is negotiated and the format is valid', () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = buildInlineImageContentBlock(oversized, { imageCapabilityNegotiated: true });
    expect(result).toEqual({ ok: false, reason: 'oversize' });
  });

  it('accepts a payload right at the cap, and honors a caller-supplied maxBytes override', () => {
    const atCap = new Uint8Array(16);
    atCap.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      buildInlineImageContentBlock(atCap, { imageCapabilityNegotiated: true, maxBytes: 16 }).ok,
    ).toBe(true);
    expect(
      buildInlineImageContentBlock(atCap, { imageCapabilityNegotiated: true, maxBytes: 15 }),
    ).toEqual({ ok: false, reason: 'oversize' });
  });

  it('checks capability before size: an oversized image with no negotiated capability still reports the capability reason', () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = buildInlineImageContentBlock(oversized, { imageCapabilityNegotiated: false });
    expect(result).toEqual({ ok: false, reason: 'capability-not-negotiated' });
  });
});
