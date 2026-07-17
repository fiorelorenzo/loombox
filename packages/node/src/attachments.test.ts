import type { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { EncryptedEnvelope, WireMessageV1 } from '@loombox/protocol';
import { deriveKeyTree, encryptEnvelope, importAesGcmKey } from '@loombox/crypto';

import {
  AttachmentResolver,
  RelayBlobSource,
  attachmentResourceId,
  type RelayLike,
} from './attachments';

type CryptoKey = webcrypto.CryptoKey;

/**
 * A fake relay/blob source standing in for `@loombox/node`'s real
 * `RelayConnection` (which already satisfies `RelayLike`): records every
 * message sent through it and lets a test script canned inbound replies —
 * no WebSocket, no network, no `@loombox/relay` process (per this issue's
 * "fake the relay/blob download" test guidance).
 */
class FakeRelay implements RelayLike {
  readonly sent: WireMessageV1[] = [];
  private listeners = new Set<(message: WireMessageV1) => void>();

  send(message: WireMessageV1): void {
    this.sent.push(message);
  }

  on(_event: 'message', listener: (message: WireMessageV1) => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'message', listener: (message: WireMessageV1) => void): void {
    this.listeners.delete(listener);
  }

  /** Simulates the relay pushing an inbound message down this connection. */
  deliver(message: WireMessageV1): void {
    for (const listener of this.listeners) listener(message);
  }
}

async function testSessionKey(seed = 'test-seed'): Promise<CryptoKey> {
  const amk = new TextEncoder().encode(seed.padEnd(32, '0')).slice(0, 32);
  const node = await deriveKeyTree(amk, ['session', 'acct-1', 'sess-1']);
  return importAesGcmKey(node.key);
}

async function sealForAttachment(
  sessionId: string,
  ref: string,
  plaintext: Uint8Array,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const envelope = await encryptEnvelope(attachmentResourceId(sessionId, ref), plaintext, key);
  return {
    resourceId: envelope.resourceId,
    iv: Buffer.from(envelope.iv).toString('base64'),
    ciphertext: Buffer.from(envelope.ciphertext).toString('base64'),
    alg: 'AES-256-GCM',
  };
}

describe('RelayBlobSource', () => {
  it('sends blob_download and resolves once the matching blob_download_response arrives', async () => {
    const relay = new FakeRelay();
    const source = new RelayBlobSource(relay);
    const envelope: EncryptedEnvelope = {
      resourceId: 'sess-1:ref-1',
      iv: 'AAAA',
      ciphertext: 'BBBB',
      alg: 'AES-256-GCM',
    };

    const promise = source.downloadBlob('sess-1', 'ref-1');

    expect(relay.sent).toEqual([
      { type: 'blob_download', protocolVersion: 1, sessionId: 'sess-1', ref: 'ref-1' },
    ]);

    relay.deliver({
      type: 'blob_download_response',
      protocolVersion: 1,
      sessionId: 'sess-1',
      ref: 'ref-1',
      envelope,
    });

    await expect(promise).resolves.toEqual(envelope);
  });

  it('ignores a blob_download_response for a different session or ref', async () => {
    const relay = new FakeRelay();
    const source = new RelayBlobSource(relay, { timeoutMs: 50 });

    const promise = source.downloadBlob('sess-1', 'ref-1');
    relay.deliver({
      type: 'blob_download_response',
      protocolVersion: 1,
      sessionId: 'sess-OTHER',
      ref: 'ref-1',
      envelope: { resourceId: 'x', iv: 'AAAA', ciphertext: 'BBBB', alg: 'AES-256-GCM' },
    });
    relay.deliver({
      type: 'blob_download_response',
      protocolVersion: 1,
      sessionId: 'sess-1',
      ref: 'ref-OTHER',
      envelope: { resourceId: 'y', iv: 'AAAA', ciphertext: 'BBBB', alg: 'AES-256-GCM' },
    });

    await expect(promise).rejects.toThrow(/timed out/);
  });

  it('ignores unrelated message types (e.g. session_update) while waiting', async () => {
    const relay = new FakeRelay();
    const source = new RelayBlobSource(relay);
    const envelope: EncryptedEnvelope = {
      resourceId: 'r',
      iv: 'AAAA',
      ciphertext: 'BBBB',
      alg: 'AES-256-GCM',
    };

    const promise = source.downloadBlob('sess-1', 'ref-1');
    relay.deliver({
      type: 'session_update',
      protocolVersion: 1,
      sessionId: 'sess-1',
      seq: 1,
      envelope: { resourceId: 'sess-1', iv: 'AAAA', ciphertext: 'BBBB', alg: 'AES-256-GCM' },
    });
    relay.deliver({
      type: 'blob_download_response',
      protocolVersion: 1,
      sessionId: 'sess-1',
      ref: 'ref-1',
      envelope,
    });

    await expect(promise).resolves.toEqual(envelope);
  });

  it('rejects on timeout when no matching response ever arrives, and stops listening', async () => {
    const relay = new FakeRelay();
    const source = new RelayBlobSource(relay, { timeoutMs: 30 });

    await expect(source.downloadBlob('sess-1', 'ref-missing')).rejects.toThrow(
      /timed out waiting for blob_download_response/,
    );
    // The listener was cleaned up on timeout — a late, unrelated delivery must not throw.
    expect(() =>
      relay.deliver({
        type: 'blob_download_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        ref: 'ref-missing',
        envelope: { resourceId: 'r', iv: 'AAAA', ciphertext: 'BBBB', alg: 'AES-256-GCM' },
      }),
    ).not.toThrow();
  });
});

describe('AttachmentResolver', () => {
  it('downloads and decrypts an attachment blob under the given session key', async () => {
    const key = await testSessionKey();
    const plaintext = new TextEncoder().encode('the actual image bytes');
    const envelope = await sealForAttachment('sess-1', 'ref-1', plaintext, key);

    const relay = new FakeRelay();
    const resolver = new AttachmentResolver(new RelayBlobSource(relay));

    const promise = resolver.resolve('sess-1', 'ref-1', key);
    relay.deliver({
      type: 'blob_download_response',
      protocolVersion: 1,
      sessionId: 'sess-1',
      ref: 'ref-1',
      envelope,
    });

    const bytes = await promise;
    expect(new TextDecoder().decode(bytes)).toBe('the actual image bytes');
  });

  it('never leaks plaintext through the wire envelope it fetched (ciphertext is opaque)', async () => {
    const key = await testSessionKey();
    const plaintext = new TextEncoder().encode('a very secret photo caption');
    const envelope = await sealForAttachment('sess-1', 'ref-1', plaintext, key);

    const raw = Buffer.from(envelope.ciphertext, 'base64').toString('latin1');
    expect(raw.includes('secret')).toBe(false);
  });

  it('rejects (AAD swap/spoof check) when the ciphertext was sealed for a different ref', async () => {
    const key = await testSessionKey();
    const plaintext = new TextEncoder().encode('bytes');
    // Sealed for "ref-1" but the resolver is asked to open it as "ref-2".
    const envelope = await sealForAttachment('sess-1', 'ref-1', plaintext, key);

    const relay = new FakeRelay();
    const resolver = new AttachmentResolver(new RelayBlobSource(relay));

    const promise = resolver.resolve('sess-1', 'ref-2', key);
    relay.deliver({
      type: 'blob_download_response',
      protocolVersion: 1,
      sessionId: 'sess-1',
      ref: 'ref-2',
      envelope,
    });

    await expect(promise).rejects.toThrow();
  });

  it('rejects when decrypting under the wrong session key', async () => {
    const key = await testSessionKey('key-a');
    const wrongKey = await testSessionKey('key-b');
    const plaintext = new TextEncoder().encode('bytes');
    const envelope = await sealForAttachment('sess-1', 'ref-1', plaintext, key);

    const relay = new FakeRelay();
    const resolver = new AttachmentResolver(new RelayBlobSource(relay));

    const promise = resolver.resolve('sess-1', 'ref-1', wrongKey);
    relay.deliver({
      type: 'blob_download_response',
      protocolVersion: 1,
      sessionId: 'sess-1',
      ref: 'ref-1',
      envelope,
    });

    await expect(promise).rejects.toThrow();
  });

  it('propagates a downstream fetch failure (e.g. relay timeout) rather than hanging', async () => {
    const relay = new FakeRelay();
    const resolver = new AttachmentResolver(new RelayBlobSource(relay, { timeoutMs: 20 }));
    const key = await testSessionKey();

    await expect(resolver.resolve('sess-1', 'ref-missing', key)).rejects.toThrow(/timed out/);
  });
});
