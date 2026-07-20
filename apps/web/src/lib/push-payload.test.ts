import { describe, expect, it, vi } from 'vitest';

import {
  focusOrOpenSession,
  notificationContentFor,
  parsePushPayload,
  sessionUrlFromNotificationData,
  showAttentionNotification,
  type ClientsLike,
  type FocusableWindowClient,
} from './push-payload';

describe('parsePushPayload (#164)', () => {
  it('parses a valid permission_required payload', () => {
    expect(parsePushPayload({ kind: 'permission_required', sessionId: 'sess_1' })).toEqual({
      kind: 'permission_required',
      sessionId: 'sess_1',
    });
  });

  it('rejects a non-object, a missing/empty sessionId, and an unrecognized kind, without throwing', () => {
    expect(parsePushPayload(null)).toBeUndefined();
    expect(parsePushPayload('nope')).toBeUndefined();
    expect(parsePushPayload({ kind: 'permission_required' })).toBeUndefined();
    expect(parsePushPayload({ kind: 'permission_required', sessionId: '' })).toBeUndefined();
    expect(parsePushPayload({ kind: 'session_finished', sessionId: 'sess_1' })).toBeUndefined();
  });
});

describe('notificationContentFor (#164)', () => {
  it('never leaks any decrypted content — only the sessionId routing hint the relay itself sent', () => {
    const content = notificationContentFor({ kind: 'permission_required', sessionId: 'sess_1' });
    expect(content.title).toBe('Approval needed');
    expect(content.options.data).toEqual({ sessionId: 'sess_1' });
    expect(content.options.tag).toContain('sess_1');
  });

  it('exposes approve/deny/open actions (#165) so a supporting platform can act without opening the app', () => {
    const content = notificationContentFor({ kind: 'permission_required', sessionId: 'sess_1' });
    expect(content.options.actions).toEqual([
      { action: 'approve', title: 'Approve' },
      { action: 'deny', title: 'Deny' },
      { action: 'open', title: 'Open' },
    ]);
  });
});

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

describe('sessionUrlFromNotificationData', () => {
  it('builds a session deep link from valid notification data', () => {
    expect(sessionUrlFromNotificationData({ sessionId: 'sess_1' })).toBe('/?session=sess_1');
  });

  it('falls back to the app root when data is missing/malformed', () => {
    expect(sessionUrlFromNotificationData(undefined)).toBe('/');
    expect(sessionUrlFromNotificationData({})).toBe('/');
    expect(sessionUrlFromNotificationData({ sessionId: 42 })).toBe('/');
  });

  it('URL-encodes a sessionId with special characters', () => {
    expect(sessionUrlFromNotificationData({ sessionId: 'sess a/b' })).toBe(
      '/?session=sess%20a%2Fb',
    );
  });

  it('appends &action= for approve/deny (#165) so the app can auto-resolve on load', () => {
    expect(sessionUrlFromNotificationData({ sessionId: 'sess_1' }, 'approve')).toBe(
      '/?session=sess_1&action=approve',
    );
    expect(sessionUrlFromNotificationData({ sessionId: 'sess_1' }, 'deny')).toBe(
      '/?session=sess_1&action=deny',
    );
  });

  it('omits the action param for a plain click, the open action, or any unrecognized action', () => {
    expect(sessionUrlFromNotificationData({ sessionId: 'sess_1' }, undefined)).toBe(
      '/?session=sess_1',
    );
    expect(sessionUrlFromNotificationData({ sessionId: 'sess_1' }, '')).toBe('/?session=sess_1');
    expect(sessionUrlFromNotificationData({ sessionId: 'sess_1' }, 'open')).toBe(
      '/?session=sess_1',
    );
    expect(sessionUrlFromNotificationData({ sessionId: 'sess_1' }, 'nonsense')).toBe(
      '/?session=sess_1',
    );
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
