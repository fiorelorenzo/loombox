import { describe, expect, it } from 'vitest';
import { deriveKeyTree } from './key-tree';
import { importAesGcmKey } from './aead';
import { deriveSessionKey } from './session-keys';

describe('deriveSessionKey', () => {
  it('derives the documented ["session", accountId, sessionId] path (matches deriveKeyTree + importAesGcmKey directly)', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));

    const key = await deriveSessionKey(amk, 'acct-1', 'sess-1');
    const expectedNode = await deriveKeyTree(amk, ['session', 'acct-1', 'sess-1']);
    const expected = await importAesGcmKey(expectedNode.key);

    // WebCrypto keys are non-extractable/opaque, so prove equivalence by
    // sealing under one and opening under the other (round-trips iff the
    // raw key material is identical).
    const plaintext = new TextEncoder().encode('same key material');
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
      key,
      plaintext,
    );
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
      expected,
      sealed,
    );
    expect(new Uint8Array(opened)).toEqual(plaintext);
  });

  it('is deterministic: the same (amk, accountId, sessionId) derives an interoperable key each call', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const first = await deriveSessionKey(amk, 'acct-1', 'sess-1');
    const second = await deriveSessionKey(amk, 'acct-1', 'sess-1');

    const plaintext = new TextEncoder().encode('round trip');
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
      first,
      plaintext,
    );
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
      second,
      sealed,
    );
    expect(new Uint8Array(opened)).toEqual(plaintext);
  });

  it('scopes independently by accountId and by sessionId (different keys never interoperate)', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const base = await deriveSessionKey(amk, 'acct-1', 'sess-1');
    const otherAccount = await deriveSessionKey(amk, 'acct-2', 'sess-1');
    const otherSession = await deriveSessionKey(amk, 'acct-1', 'sess-2');

    const plaintext = new TextEncoder().encode('scoped');
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
      base,
      plaintext,
    );

    await expect(
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
        otherAccount,
        sealed,
      ),
    ).rejects.toThrow();
    await expect(
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
        otherSession,
        sealed,
      ),
    ).rejects.toThrow();
  });
});
