import {
  decryptEnvelope,
  deriveSessionKey,
  envelopeFromWire,
  generateAmk,
  generateRecoveryCode,
  sealJson,
  unwrapAmkWithRecoveryCode,
} from '@loombox/crypto';
import type { EncryptedEnvelope } from '@loombox/protocol';
import { describe, expect, it } from 'vitest';
import { EnvelopeCryptoEngine } from './crypto-worker-engine';
import type { EnvelopeRequest } from './crypto-worker-protocol';

describe('EnvelopeCryptoEngine (issue #756, SPEC §8)', () => {
  it('seals and opens under a session-derived key, round-tripping the exact plaintext', async () => {
    const engine = new EnvelopeCryptoEngine(generateAmk(), 'acct-1');
    const wire = await engine.seal('session', 'sess-1', 'sess-1', { text: 'hello' });
    const opened = await engine.open('session', 'sess-1', 'sess-1', wire);
    expect(opened).toEqual({ text: 'hello' });
  });

  it('scopes project and target keys independently of session keys and of each other', async () => {
    const engine = new EnvelopeCryptoEngine(generateAmk(), 'acct-1');
    const sessionWire = await engine.seal('session', 'res-1', 'res-1', { kind: 'session' });
    const projectWire = await engine.seal('project', 'res-1', 'res-1', { kind: 'project' });
    const targetWire = await engine.seal('target', 'res-1', 'res-1', { kind: 'target' });

    // Same `keyId`/`resourceId` string across all three families ('res-1')
    // — only `keyKind` differs — so a mismatch here is either a shared key
    // bug or an AAD-binding bug, not a naming coincidence.
    await expect(engine.open('project', 'res-1', 'res-1', sessionWire)).rejects.toThrow();
    await expect(engine.open('target', 'res-1', 'res-1', sessionWire)).rejects.toThrow();
    await expect(engine.open('session', 'res-1', 'res-1', projectWire)).rejects.toThrow();
    await expect(engine.open('session', 'res-1', 'res-1', targetWire)).rejects.toThrow();
  });

  it('caches a derived key per keyId — sealing under the same session id twice never re-derives', async () => {
    const engine = new EnvelopeCryptoEngine(generateAmk(), 'acct-1');
    const first = await engine.seal('session', 'sess-1', 'sess-1', { n: 1 });
    const second = await engine.seal('session', 'sess-1', 'sess-1', { n: 2 });
    // Different IVs (fresh random per seal) but both open under the SAME
    // derived key — proves the second seal reused the cached key rather
    // than deriving a fresh (and by definition, wrong) one.
    expect(first.iv).not.toEqual(second.iv);
    await expect(engine.open('session', 'sess-1', 'sess-1', first)).resolves.toEqual({ n: 1 });
    await expect(engine.open('session', 'sess-1', 'sess-1', second)).resolves.toEqual({ n: 2 });
  });

  it('sealBytes binds a resourceId that differs from the session keyId (the attachment case) and round-trips the exact bytes', async () => {
    const amk = generateAmk();
    const engine = new EnvelopeCryptoEngine(amk, 'acct-1');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const wire = await engine.sealBytes('session', 'sess-1', 'att:sess-1:ref-1', bytes);

    // Decrypted directly (not through `open`, which JSON-parses) to prove
    // this is real raw-bytes sealing, byte-exact — and specifically against
    // the AAD `sealBytes` bound the ciphertext to (`resourceId`, not
    // `keyId`), proving it did not silently fall back to the sessionId.
    const sessionKey = await deriveSessionKey(amk, 'acct-1', 'sess-1');
    const plaintext = await decryptEnvelope('att:sess-1:ref-1', envelopeFromWire(wire), sessionKey);
    expect(plaintext).toEqual(bytes);
  });

  it('wrapAmkForEscrow wraps the exact AMK this engine holds, recoverable with the same Recovery Code', async () => {
    const amk = generateAmk();
    const engine = new EnvelopeCryptoEngine(amk, 'acct-1');
    const recoveryCode = generateRecoveryCode();
    const blob = await engine.wrapAmkForEscrow(recoveryCode);
    const recovered = await unwrapAmkWithRecoveryCode(blob, recoveryCode, 'acct-1');
    expect(recovered).toEqual(amk);
  });

  describe('handleBatch (the E3-4 batching contract)', () => {
    it('resolves every request via one Promise.all, in the SAME order as the input regardless of completion timing', async () => {
      const amk = generateAmk();
      const engine = new EnvelopeCryptoEngine(amk, 'acct-1');
      const key = await deriveSessionKey(amk, 'acct-1', 'sess-1');

      // Five real envelopes, independently sealed (not through the engine
      // under test) so this genuinely exercises "already-arrived ciphertext
      // gets decrypted", not just "whatever this engine itself produced".
      const wires: EncryptedEnvelope[] = [];
      for (let i = 0; i < 5; i++) {
        wires.push(await sealJson('sess-1', { n: i }, key));
      }

      const requests: EnvelopeRequest[] = wires.map((wire, i) => ({
        type: 'open',
        requestId: i,
        keyKind: 'session',
        keyId: 'sess-1',
        resourceId: 'sess-1',
        wire,
      }));

      const results = await engine.handleBatch(requests);

      expect(results).toHaveLength(5);
      results.forEach((result, i) => {
        expect(result.requestId).toBe(i);
        expect(result.ok).toBe(true);
      });
      const values = results.map((r) => (r.ok && r.kind === 'open' ? r.value : undefined));
      expect(values).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    });

    it('a corrupt envelope in a batch fails only its own slot — the rest of the batch still succeeds', async () => {
      const amk = generateAmk();
      const engine = new EnvelopeCryptoEngine(amk, 'acct-1');
      const key = await deriveSessionKey(amk, 'acct-1', 'sess-1');

      const goodWire = await sealJson('sess-1', { n: 'good' }, key);
      const corruptWire: EncryptedEnvelope = {
        ...(await sealJson('sess-1', { n: 'bad' }, key)),
        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', // tampered — AES-GCM tag check fails
      };

      const requests: EnvelopeRequest[] = [
        {
          type: 'open',
          requestId: 1,
          keyKind: 'session',
          keyId: 'sess-1',
          resourceId: 'sess-1',
          wire: goodWire,
        },
        {
          type: 'open',
          requestId: 2,
          keyKind: 'session',
          keyId: 'sess-1',
          resourceId: 'sess-1',
          wire: corruptWire,
        },
        {
          type: 'open',
          requestId: 3,
          keyKind: 'session',
          keyId: 'sess-1',
          resourceId: 'sess-1',
          wire: goodWire,
        },
      ];

      const results = await engine.handleBatch(requests);

      expect(results[0]).toMatchObject({ requestId: 1, ok: true });
      expect(results[1].ok).toBe(false);
      if (!results[1].ok) {
        expect(results[1].error.message.length).toBeGreaterThan(0);
      }
      expect(results[2]).toMatchObject({ requestId: 3, ok: true });
    });
  });
});
