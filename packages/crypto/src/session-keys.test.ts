import { describe, expect, it } from 'vitest';
import type { CryptoKey } from './webcrypto-types';
import { deriveKeyTree } from './key-tree';
import { importAesGcmKey } from './aead';
import { deriveProjectKey, deriveSessionKey } from './session-keys';

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

describe('deriveProjectKey', () => {
  const IV = { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 } as const;
  const seal = (key: CryptoKey, text: string) =>
    crypto.subtle.encrypt(IV, key, new TextEncoder().encode(text));

  it('derives the documented ["project", accountId, projectPath] path', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));

    const key = await deriveProjectKey(amk, 'acct-1', '/home/dev/p');
    const expectedNode = await deriveKeyTree(amk, ['project', 'acct-1', '/home/dev/p']);
    const expected = await importAesGcmKey(expectedNode.key);

    const plaintext = new TextEncoder().encode('same key material');
    const sealed = await crypto.subtle.encrypt(IV, key, plaintext);
    expect(new Uint8Array(await crypto.subtle.decrypt(IV, expected, sealed))).toEqual(plaintext);
  });

  it('is deterministic across calls, which is what lets a node and a client derive it independently', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const onTheNode = await deriveProjectKey(amk, 'acct-1', '/home/dev/p');
    const onTheClient = await deriveProjectKey(amk, 'acct-1', '/home/dev/p');

    const plaintext = new TextEncoder().encode('round trip');
    const sealed = await crypto.subtle.encrypt(IV, onTheNode, plaintext);
    expect(new Uint8Array(await crypto.subtle.decrypt(IV, onTheClient, sealed))).toEqual(plaintext);
  });

  it('scopes independently by accountId and by projectPath', async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const base = await deriveProjectKey(amk, 'acct-1', '/home/dev/p');
    const sealed = await seal(base, 'scoped');

    for (const other of [
      await deriveProjectKey(amk, 'acct-2', '/home/dev/p'),
      await deriveProjectKey(amk, 'acct-1', '/home/dev/other'),
    ]) {
      await expect(crypto.subtle.decrypt(IV, other, sealed)).rejects.toThrow();
    }
  });

  it('never collides with the session family, which is the whole reason the path is namespaced', async () => {
    // The one property a future edit could silently break: reusing 'session'
    // as this family's leading segment, or deriving from a bare
    // [accountId, id] path, would make a project key and a same-named
    // session key identical and let one open the other's content.
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const shared = 'same-identifier';
    const projectKey = await deriveProjectKey(amk, 'acct-1', shared);
    const sessionKey = await deriveSessionKey(amk, 'acct-1', shared);

    const sealed = await seal(projectKey, 'project content');
    await expect(crypto.subtle.decrypt(IV, sessionKey, sealed)).rejects.toThrow();
  });
});
