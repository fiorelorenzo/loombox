import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pushSupportState,
  subscribeToPush,
  urlBase64ToUint8Array,
  type PushCapableRegistration,
} from './push-notifications';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pushSupportState (#162)', () => {
  it('reports unsupported when serviceWorker/PushManager/Notification are all absent (e.g. SSR, this test runner)', () => {
    expect(pushSupportState({} as unknown as typeof globalThis)).toBe('unsupported');
  });

  it('reports unsupported when navigator lacks serviceWorker, even if the other two globals exist', () => {
    const fakeWindow = {
      navigator: {},
      PushManager: class {},
      Notification: { permission: 'granted' },
    } as unknown as typeof globalThis;
    expect(pushSupportState(fakeWindow)).toBe('unsupported');
  });

  it('reflects Notification.permission when every feature is present', () => {
    const fakeWindow = {
      navigator: { serviceWorker: {} },
      PushManager: class {},
      Notification: { permission: 'denied' },
    } as unknown as typeof globalThis;
    expect(pushSupportState(fakeWindow)).toBe('denied');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('round-trips a URL-safe base64 VAPID-style public key into raw bytes', () => {
    // 32 arbitrary bytes, URL-safe-base64-encoded (the shape a real VAPID public key has).
    const bytes = new Uint8Array(32).map((_, i) => i * 7);
    const base64 = Buffer.from(bytes).toString('base64url');
    expect(Array.from(urlBase64ToUint8Array(base64))).toEqual(Array.from(bytes));
  });
});

function fakeRegistration(subscriptionJson: {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}): { registration: PushCapableRegistration; subscribeCalls: unknown[] } {
  const subscribeCalls: unknown[] = [];
  const registration: PushCapableRegistration = {
    pushManager: {
      async subscribe(options) {
        subscribeCalls.push(options);
        return { toJSON: () => subscriptionJson };
      },
    },
  };
  return { registration, subscribeCalls };
}

const supportedWindow = {
  navigator: { serviceWorker: {} },
  PushManager: class {},
  Notification: { permission: 'default' },
} as unknown as typeof globalThis;

describe('subscribeToPush (#162)', () => {
  it('returns unsupported without ever prompting for permission when the browser lacks Push support', async () => {
    const requestPermission = vi.fn();
    const result = await subscribeToPush({
      relayBaseUrl: 'http://relay.test',
      authToken: 'tok',
      deviceId: 'dev_1',
      win: {} as unknown as typeof globalThis,
      requestPermission,
    });
    expect(result).toEqual({ status: 'unsupported' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('returns permission-denied and never calls the relay when the user denies the prompt', async () => {
    const fetchImpl = vi.fn();
    const result = await subscribeToPush({
      relayBaseUrl: 'http://relay.test',
      authToken: 'tok',
      deviceId: 'dev_1',
      win: supportedWindow,
      requestPermission: async () => 'denied',
      fetchImpl,
    });
    expect(result).toEqual({ status: 'permission-denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns push-disabled-on-relay when the relay was not configured with push (#161 disabled)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const result = await subscribeToPush({
      relayBaseUrl: 'http://relay.test',
      authToken: 'tok',
      deviceId: 'dev_1',
      win: supportedWindow,
      requestPermission: async () => 'granted',
      fetchImpl,
    });
    expect(result).toEqual({ status: 'push-disabled-on-relay' });
  });

  it('on granted permission, fetches the VAPID key, subscribes via the service worker, and posts the subscription to the relay', async () => {
    const { registration, subscribeCalls } = fakeRegistration({
      endpoint: 'https://push.example/ep1',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });
    const publicKey = Buffer.from(new Uint8Array(32)).toString('base64url');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await subscribeToPush({
      relayBaseUrl: 'http://relay.test',
      authToken: 'bearer-tok',
      deviceId: 'dev_1',
      win: supportedWindow,
      requestPermission: async () => 'granted',
      getRegistration: async () => registration,
      fetchImpl,
    });

    expect(result).toEqual({ status: 'subscribed' });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://relay.test/push/vapid-public-key');
    expect(subscribeCalls).toHaveLength(1);
    expect((subscribeCalls[0] as { userVisibleOnly: boolean }).userVisibleOnly).toBe(true);

    const [, subscribeRequest] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('http://relay.test/push/subscribe');
    expect(subscribeRequest.method).toBe('POST');
    expect(subscribeRequest.headers).toMatchObject({ authorization: 'Bearer bearer-tok' });
    expect(JSON.parse(subscribeRequest.body as string)).toEqual({
      deviceId: 'dev_1',
      endpoint: 'https://push.example/ep1',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });
  });

  it('throws if the browser subscription somehow lacks endpoint/p256dh/auth', async () => {
    const { registration } = fakeRegistration({ endpoint: undefined, keys: undefined });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ publicKey: 'AA' }), { status: 200 }));

    await expect(
      subscribeToPush({
        relayBaseUrl: 'http://relay.test',
        authToken: 'tok',
        deviceId: 'dev_1',
        win: supportedWindow,
        requestPermission: async () => 'granted',
        getRegistration: async () => registration,
        fetchImpl,
      }),
    ).rejects.toThrow(/endpoint\/p256dh\/auth/);
  });
});
