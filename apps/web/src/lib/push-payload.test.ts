import { describe, expect, it, vi } from 'vitest';

import {
  focusOrOpenSession,
  showAttentionNotification,
  type ClientsLike,
  type FocusableWindowClient,
} from './push-payload';

// `parsePushPayload`/`notificationContentFor`/`sessionUrlFromNotificationData`
// moved to `@loombox/push-core` by #282 — see that package's `payload.test.ts`
// for their coverage, including the encryption-boundary test. This file
// only covers what's still genuinely local: the SW `showNotification`/
// `Clients` glue.

describe('showAttentionNotification (#164)', () => {
  it('calls registration.showNotification with the derived title/options', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    await showAttentionNotification(
      { showNotification },
      { kind: 'permission_required', sessionId: 'sess_1' },
    );

    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = showNotification.mock.calls[0] as [
      string,
      { data: { sessionId: string } },
    ];
    expect(title).toBe('Approval needed');
    expect(options.data).toEqual({ sessionId: 'sess_1' });
  });
});

function fakeClients(existing: FocusableWindowClient[]): {
  clientsApi: ClientsLike;
  openWindow: ReturnType<typeof vi.fn>;
} {
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const clientsApi: ClientsLike = {
    matchAll: async () => existing,
    openWindow,
  };
  return { clientsApi, openWindow };
}

describe('focusOrOpenSession (#164)', () => {
  it('navigates and focuses an already-open window instead of opening a new one', async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn().mockResolvedValue(undefined);
    const { clientsApi, openWindow } = fakeClients([{ url: '/', navigate, focus }]);

    await focusOrOpenSession(clientsApi, '/?session=sess_1');

    expect(navigate).toHaveBeenCalledWith('/?session=sess_1');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('still focuses an open window that does not support navigate (older browser)', async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    const { clientsApi, openWindow } = fakeClients([{ url: '/', focus }]);

    await focusOrOpenSession(clientsApi, '/?session=sess_1');

    expect(focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window at the session URL when no app window is open', async () => {
    const { clientsApi, openWindow } = fakeClients([]);

    await focusOrOpenSession(clientsApi, '/?session=sess_1');

    expect(openWindow).toHaveBeenCalledWith('/?session=sess_1');
  });
});
