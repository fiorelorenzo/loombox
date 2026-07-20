import { generateVAPIDKeys, WebPushError, type SendResult } from 'web-push';
import { describe, expect, it, vi } from 'vitest';

import { createWebPushSender, resolveVapidKeys } from './push';
import { createInMemoryRelayStore } from './store';

describe('resolveVapidKeys (#161)', () => {
  it('generates and persists a fresh keypair on first setup, via the store', async () => {
    const store = createInMemoryRelayStore().vapidKeys;
    expect(await store.get()).toBeUndefined();

    const generated = { publicKey: 'generated-pub', privateKey: 'generated-priv' };
    const keys = await resolveVapidKeys(store, {
      subject: 'mailto:ops@example.com',
      generate: () => generated,
    });

    expect(keys).toEqual(generated);
    expect(await store.get()).toEqual(generated);
  });

  it('by default generates through the real web-push generateVAPIDKeys() (a genuine P-256 keypair, no fake)', async () => {
    const store = createInMemoryRelayStore().vapidKeys;
    const keys = await resolveVapidKeys(store, { subject: 'mailto:ops@example.com' });
    // A real VAPID public key is a 65-byte uncompressed P-256 point,
    // URL-safe-base64-encoded to 87 chars; a fake/short string would fail
    // this shape check, proving the real `web-push` generator ran.
    expect(keys.publicKey).toHaveLength(87);
    expect(keys.privateKey.length).toBeGreaterThan(0);
  });

  it('reuses an already-persisted keypair instead of generating a new one', async () => {
    const store = createInMemoryRelayStore().vapidKeys;
    await store.saveIfAbsent({ publicKey: 'stored-pub', privateKey: 'stored-priv' });

    const generate = () => ({ publicKey: 'should-not-be-used', privateKey: 'should-not-be-used' });
    const keys = await resolveVapidKeys(store, { subject: 'mailto:ops@example.com', generate });

    expect(keys).toEqual({ publicKey: 'stored-pub', privateKey: 'stored-priv' });
  });

  it('an operator-supplied env keypair wins outright, and is never written to the store', async () => {
    const store = createInMemoryRelayStore().vapidKeys;
    const envKeys = { publicKey: 'env-pub', privateKey: 'env-priv' };

    const keys = await resolveVapidKeys(store, { subject: 'mailto:ops@example.com', envKeys });

    expect(keys).toEqual(envKeys);
    expect(await store.get()).toBeUndefined();
  });
});

const fakeSendResult: SendResult = { statusCode: 201, body: '', headers: {} };

/**
 * `createWebPushSender` demonstrated end to end (#161's own acceptance
 * line), against a real VAPID keypair (`web-push`'s own
 * `generateVAPIDKeys()`, unmocked). The underlying `sendNotification` call —
 * the one piece that would need a real reachable push endpoint (FCM/Mozilla)
 * this box can never reach — is the sole injected seam, the same "swap only
 * the actual network I/O" pattern this package already uses everywhere
 * (`PushSender` itself in `relay.ts`, `FanOutBackend`, `PgLike`). Its
 * success/failure *contract* (a genuine `WebPushError` with a `statusCode`
 * on a non-2xx) is real, imported straight from the `web-push` package, not
 * reimplemented here — only the actual TCP/TLS delivery is swapped out.
 */
describe('createWebPushSender (#161/#163)', () => {
  const vapidKeys = generateVAPIDKeys();
  const target = {
    endpoint: 'https://push.example.com/subscription/abc',
    p256dh: 'p256dh',
    auth: 'auth',
  };
  const payload = { kind: 'permission_required' as const, sessionId: 'sess_1' };

  it('marshals the subscription, VAPID keys, and JSON-serialized payload into a real web-push sendNotification call, and reports success', async () => {
    const sendNotification = vi.fn().mockResolvedValue(fakeSendResult);
    const sender = createWebPushSender(sendNotification);

    const result = await sender.send(target, vapidKeys, 'mailto:ops@example.com', payload);

    expect(result).toEqual({ expired: false });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: 'mailto:ops@example.com',
          publicKey: vapidKeys.publicKey,
          privateKey: vapidKeys.privateKey,
        },
      },
    );
  });

  it('reports expired (not a thrown error) on a real WebPushError carrying a 410 Gone, so the caller can self-clean the subscription', async () => {
    const sendNotification = vi
      .fn()
      .mockRejectedValue(
        new WebPushError('Received unexpected response code', 410, {}, 'gone', target.endpoint),
      );
    const sender = createWebPushSender(sendNotification);

    const result = await sender.send(target, vapidKeys, 'mailto:ops@example.com', payload);

    expect(result).toEqual({ expired: true });
  });

  it('reports expired on a 404 Not Found too (some push services report a gone subscription this way)', async () => {
    const sendNotification = vi
      .fn()
      .mockRejectedValue(
        new WebPushError(
          'Received unexpected response code',
          404,
          {},
          'not found',
          target.endpoint,
        ),
      );
    const sender = createWebPushSender(sendNotification);

    const result = await sender.send(target, vapidKeys, 'mailto:ops@example.com', payload);

    expect(result).toEqual({ expired: true });
  });

  it('rethrows any other WebPushError status rather than silently swallowing it', async () => {
    const sendNotification = vi
      .fn()
      .mockRejectedValue(
        new WebPushError(
          'Received unexpected response code',
          500,
          {},
          'server error',
          target.endpoint,
        ),
      );
    const sender = createWebPushSender(sendNotification);

    await expect(sender.send(target, vapidKeys, 'mailto:ops@example.com', payload)).rejects.toThrow(
      WebPushError,
    );
  });

  it('rethrows a non-WebPushError failure (e.g. a genuine network error) unchanged', async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const sender = createWebPushSender(sendNotification);

    await expect(sender.send(target, vapidKeys, 'mailto:ops@example.com', payload)).rejects.toThrow(
      'getaddrinfo ENOTFOUND',
    );
  });
});
