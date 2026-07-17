import { describe, expect, it } from 'vitest';
import { blobDownload, blobDownloadResponse, blobRef, blobUpload } from './attachments';

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
