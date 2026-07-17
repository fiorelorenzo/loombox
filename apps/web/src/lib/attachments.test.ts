import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentResourceId,
  hasBlockingAttachments,
  sniffImageType,
  validateAttachmentBytes,
  type ComposerAttachment,
} from './attachments';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function padded(signature: number[], totalLength = 64): Uint8Array {
  const out = new Uint8Array(totalLength);
  out.set(signature, 0);
  return out;
}

const REAL_PNG = padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REAL_JPEG = padded([0xff, 0xd8, 0xff, 0xe0]);
const REAL_GIF = padded(ascii('GIF89a'));
const REAL_WEBP = padded([...ascii('RIFF'), 0x00, 0x00, 0x00, 0x00, ...ascii('WEBP')]);
// A minimal ISOBMFF `ftyp` box declaring the `heic` major brand — the real
// shape a camera-produced HEIC file's first bytes take (box size, 'ftyp',
// major brand, minor version, compatible brands...).
const REAL_HEIC = padded([
  0x00,
  0x00,
  0x00,
  0x18,
  ...ascii('ftyp'),
  ...ascii('heic'),
  0x00,
  0x00,
  0x00,
  0x00,
]);
const NOT_AN_IMAGE = padded(ascii('%PDF-1.4'));

describe('sniffImageType: magic-byte detection, never extension/declared mimeType', () => {
  it('identifies a real PNG', () => {
    expect(sniffImageType(REAL_PNG)).toBe('png');
  });

  it('identifies a real JPEG', () => {
    expect(sniffImageType(REAL_JPEG)).toBe('jpeg');
  });

  it('identifies a real GIF', () => {
    expect(sniffImageType(REAL_GIF)).toBe('gif');
  });

  it('identifies a real WEBP', () => {
    expect(sniffImageType(REAL_WEBP)).toBe('webp');
  });

  it('identifies a real HEIC (ISOBMFF ftyp box, heic brand)', () => {
    expect(sniffImageType(REAL_HEIC)).toBe('heic');
  });

  it('returns unknown for a non-image file, regardless of what it claims to be', () => {
    expect(sniffImageType(NOT_AN_IMAGE)).toBe('unknown');
  });

  it('returns unknown for too few bytes to hold any signature', () => {
    expect(sniffImageType(bytes(0xff))).toBe('unknown');
  });
});

describe('validateAttachmentBytes: issue #151 (size/type gate) + #152 (HEIC rejection)', () => {
  it('accepts a real PNG and reports the correct mimeType', () => {
    const result = validateAttachmentBytes(REAL_PNG);
    expect(result).toEqual({ ok: true, mimeType: 'image/png' });
  });

  it('accepts a real JPEG and reports the correct mimeType', () => {
    const result = validateAttachmentBytes(REAL_JPEG);
    expect(result).toEqual({ ok: true, mimeType: 'image/jpeg' });
  });

  it('rejects a file over the 10 MB cap before considering its type', () => {
    const oversized = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // valid PNG signature
    const result = validateAttachmentBytes(oversized);
    expect(result).toEqual({
      ok: false,
      reason: 'too-large',
      message: 'Image exceeds the 10 MB attachment limit.',
    });
  });

  it('rejects a spoofed file (a PDF renamed/declared as an image) by its real bytes', () => {
    const result = validateAttachmentBytes(NOT_AN_IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-type');
      expect(result.message).toMatch(/unsupported image type/i);
    }
  });

  it('rejects a HEIC file with a clear convert-and-re-upload message', () => {
    const result = validateAttachmentBytes(REAL_HEIC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('heic-unsupported');
      expect(result.message).toMatch(/heic\/heif/i);
      expect(result.message).toMatch(/convert/i);
      expect(result.message).toMatch(/re-upload/i);
    }
  });
});

describe('hasBlockingAttachments: issue #155 send-gate', () => {
  function attachment(overrides: Partial<ComposerAttachment>): ComposerAttachment {
    return {
      id: 'a1',
      name: 'photo.png',
      mimeType: 'image/png',
      size: 100,
      previewUrl: undefined,
      status: 'uploaded',
      error: undefined,
      ...overrides,
    };
  }

  it('is false when every attachment is uploaded', () => {
    expect(hasBlockingAttachments([attachment({ status: 'uploaded' })])).toBe(false);
  });

  it('is true while any attachment is mid-upload', () => {
    expect(hasBlockingAttachments([attachment({ status: 'uploading' })])).toBe(true);
  });

  it('is true while any attachment has failed', () => {
    expect(
      hasBlockingAttachments([
        attachment({ id: 'a1', status: 'uploaded' }),
        attachment({ id: 'a2', status: 'failed' }),
      ]),
    ).toBe(true);
  });

  it('a rejected (never-attempted) attachment does not block sending', () => {
    expect(hasBlockingAttachments([attachment({ status: 'rejected' })])).toBe(false);
  });

  it('is false for an empty attachment list', () => {
    expect(hasBlockingAttachments([])).toBe(false);
  });
});

describe('attachmentResourceId', () => {
  it('matches the relay/node AAD-binding convention exactly', () => {
    expect(attachmentResourceId('sess-1', 'ref-1')).toBe('sess-1:ref-1');
  });
});
