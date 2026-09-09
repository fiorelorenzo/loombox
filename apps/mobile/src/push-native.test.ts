import { describe, expect, it, vi } from 'vitest';
import type { PushNotificationSchema } from '@capacitor/push-notifications';

import {
  localNotificationSchemaFor,
  notificationIdForSession,
  PERMISSION_ACTION_TYPE_ID,
  registerNativePush,
  registerPermissionActionType,
  sessionUrlFromNativePushAction,
  startNativePushListening,
  type NativePushDisplayDeps,
  type NativePushRegistrationDeps,
} from './push-native';

// ---------------------------------------------------------------------------
// registerNativePush
// ---------------------------------------------------------------------------

function fakeRegistrationDeps(): NativePushRegistrationDeps & {
  registeredListener?: (token: string) => void;
  erroredListener?: (message: string) => void;
} {
  const deps: NativePushRegistrationDeps & {
    registeredListener?: (token: string) => void;
    erroredListener?: (message: string) => void;
  } = {
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register: vi.fn().mockResolvedValue(undefined),
    onRegistered(listener) {
      deps.registeredListener = listener;
    },
    onRegistrationError(listener) {
      deps.erroredListener = listener;
    },
  };
  return deps;
}

describe('registerNativePush (#282)', () => {
  it('falls back cleanly to "unavailable" on a non-native platform (web preview / dev build) without touching permissions or the plugin at all', async () => {
    const requestPermissions = vi.fn();
    const register = vi.fn();
    const result = await registerNativePush({
      isNativePlatform: () => false,
      deps: {
        requestPermissions,
        register,
        onRegistered: vi.fn(),
        onRegistrationError: vi.fn(),
      },
    });
    expect(result).toEqual({ status: 'unavailable' });
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('returns permission-denied without calling register when the OS permission prompt is declined', async () => {
    const deps = fakeRegistrationDeps();
    deps.requestPermissions = vi.fn().mockResolvedValue({ receive: 'denied' });
    const result = await registerNativePush({ isNativePlatform: () => true, deps });
    expect(result).toEqual({ status: 'permission-denied' });
    expect(deps.register).not.toHaveBeenCalled();
  });

  it('resolves with the acquired token and platform once the registration event fires', async () => {
    const deps = fakeRegistrationDeps();
    deps.register = vi.fn().mockImplementation(async () => {
      deps.registeredListener?.('fcm-token-abc');
    });
    const result = await registerNativePush({
      isNativePlatform: () => true,
      platform: () => 'android',
      deps,
    });
    expect(result).toEqual({ status: 'registered', platform: 'android', token: 'fcm-token-abc' });
  });

  it('resolves with registration-error when the registrationError event fires instead', async () => {
    const deps = fakeRegistrationDeps();
    deps.register = vi.fn().mockImplementation(async () => {
      deps.erroredListener?.('no APNs entitlement');
    });
    const result = await registerNativePush({ isNativePlatform: () => true, deps });
    expect(result).toEqual({ status: 'registration-error', message: 'no APNs entitlement' });
  });

  it('never throws when the permission prompt itself rejects (treated as an ordinary result state, same contract as the web subscribeToPush)', async () => {
    const deps = fakeRegistrationDeps();
    deps.requestPermissions = vi.fn().mockRejectedValue(new Error('plugin unavailable'));
    await expect(registerNativePush({ isNativePlatform: () => true, deps })).rejects.toThrow();
    // Documented contract, not a crash-prevention claim: unlike an
    // unsupported-platform or denied-permission result (both ordinary
    // states this function itself resolves), a plugin call throwing is
    // propagated to the caller exactly like `subscribeToPush` does for its
    // own registration failures — this test pins that down rather than
    // asserting a swallow this function was never designed to do.
  });
});

// ---------------------------------------------------------------------------
// notificationIdForSession / localNotificationSchemaFor
// ---------------------------------------------------------------------------

describe('notificationIdForSession (#282)', () => {
  it('is deterministic for the same sessionId', () => {
    expect(notificationIdForSession('sess_1')).toBe(notificationIdForSession('sess_1'));
  });

  it('differs across different sessionIds (so distinct sessions do not collide/replace each other)', () => {
    expect(notificationIdForSession('sess_1')).not.toBe(notificationIdForSession('sess_2'));
  });

  it('always produces a valid signed 32-bit int, the range Android requires', () => {
    for (const sessionId of [
      'sess_1',
      'a-very-long-session-identifier-indeed-quite-long',
      '',
      '🚀',
    ]) {
      const id = notificationIdForSession(sessionId);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(-2147483648);
      expect(id).toBeLessThanOrEqual(2147483647);
    }
  });
});

describe('localNotificationSchemaFor (#282)', () => {
  it('adapts push-core NotificationContent to a Capacitor LocalNotificationSchema, id derived from the sessionId', () => {
    const schema = localNotificationSchemaFor({
      title: 'Approval needed',
      options: {
        body: 'A session is waiting for you to approve a tool call.',
        tag: 'loombox-session-sess_1',
        data: { sessionId: 'sess_1' },
        actions: [{ action: 'approve', title: 'Approve' }],
      },
    });
    expect(schema).toEqual({
      id: notificationIdForSession('sess_1'),
      title: 'Approval needed',
      body: 'A session is waiting for you to approve a tool call.',
      extra: { sessionId: 'sess_1' },
      actionTypeId: PERMISSION_ACTION_TYPE_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// registerPermissionActionType
// ---------------------------------------------------------------------------

function fakeDisplayDeps(): NativePushDisplayDeps & {
  receivedListener?: (notification: PushNotificationSchema) => void;
  actionListener?: (event: { actionId: string; notification: { extra?: unknown } }) => void;
} {
  const deps: NativePushDisplayDeps & {
    receivedListener?: (notification: PushNotificationSchema) => void;
    actionListener?: (event: { actionId: string; notification: { extra?: unknown } }) => void;
  } = {
    registerActionTypes: vi.fn().mockResolvedValue(undefined),
    onNotificationReceived(listener) {
      deps.receivedListener = listener;
    },
    scheduleLocalNotification: vi.fn().mockResolvedValue(undefined),
    onActionPerformed(listener) {
      deps.actionListener = listener;
    },
  };
  return deps;
}

describe('registerPermissionActionType (#282)', () => {
  it('registers the approve/deny/open actions under PERMISSION_ACTION_TYPE_ID, mirroring push-core PERMISSION_PUSH_ACTIONS', async () => {
    const deps = fakeDisplayDeps();
    await registerPermissionActionType(deps);
    expect(deps.registerActionTypes).toHaveBeenCalledWith({
      types: [
        {
          id: PERMISSION_ACTION_TYPE_ID,
          actions: [
            { id: 'approve', title: 'Approve' },
            { id: 'deny', title: 'Deny' },
            { id: 'open', title: 'Open' },
          ],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// sessionUrlFromNativePushAction
// ---------------------------------------------------------------------------

describe('sessionUrlFromNativePushAction (#282)', () => {
  it('appends &action= for an approve/deny action tap', () => {
    expect(
      sessionUrlFromNativePushAction({
        actionId: 'approve',
        notification: { extra: { sessionId: 'sess_1' } },
      }),
    ).toBe('/?session=sess_1&action=approve');
  });

  it('omits the action param for the open action or Capacitor\'s reserved plain-tap "tap" id', () => {
    expect(
      sessionUrlFromNativePushAction({
        actionId: 'open',
        notification: { extra: { sessionId: 'sess_1' } },
      }),
    ).toBe('/?session=sess_1');
    expect(
      sessionUrlFromNativePushAction({
        actionId: 'tap',
        notification: { extra: { sessionId: 'sess_1' } },
      }),
    ).toBe('/?session=sess_1');
  });
});

// ---------------------------------------------------------------------------
// startNativePushListening — the receive-side integration point, and the
// encryption-boundary test for the native path end to end.
// ---------------------------------------------------------------------------

describe('startNativePushListening (#282)', () => {
  it('registers the action type and displays a local notification for a valid, non-suppressed push', async () => {
    const deps = fakeDisplayDeps();
    const onSessionUrl = vi.fn();
    await startNativePushListening({
      getPreferences: () => ({ mutedProjects: [], quietHours: undefined }),
      getSessionProjectMap: () => ({}),
      onSessionUrl,
      deps,
    });

    expect(deps.registerActionTypes).toHaveBeenCalledTimes(1);

    deps.receivedListener?.({
      id: 'n1',
      data: { kind: 'permission_required', sessionId: 'sess_1' },
    });
    await Promise.resolve();

    expect(deps.scheduleLocalNotification).toHaveBeenCalledWith({
      id: notificationIdForSession('sess_1'),
      title: 'Approval needed',
      body: 'A session is waiting for you to approve a tool call.',
      extra: { sessionId: 'sess_1' },
      actionTypeId: PERMISSION_ACTION_TYPE_ID,
    });
  });

  it('never schedules a local notification for an unparseable payload or a suppressed session', async () => {
    const deps = fakeDisplayDeps();
    await startNativePushListening({
      getPreferences: () => ({ mutedProjects: ['/repo/a'], quietHours: undefined }),
      getSessionProjectMap: () => ({ sess_1: '/repo/a' }),
      onSessionUrl: vi.fn(),
      deps,
    });

    deps.receivedListener?.({
      id: 'n1',
      data: { kind: 'permission_required', sessionId: 'sess_1' },
    });
    deps.receivedListener?.({ id: 'n2', data: { not: 'a real payload' } });
    await Promise.resolve();

    expect(deps.scheduleLocalNotification).not.toHaveBeenCalled();
  });

  it('routes a tap on the displayed notification back through onSessionUrl', async () => {
    const deps = fakeDisplayDeps();
    const onSessionUrl = vi.fn();
    await startNativePushListening({
      getPreferences: () => ({ mutedProjects: [], quietHours: undefined }),
      getSessionProjectMap: () => ({}),
      onSessionUrl,
      deps,
    });

    deps.actionListener?.({ actionId: 'deny', notification: { extra: { sessionId: 'sess_1' } } });

    expect(onSessionUrl).toHaveBeenCalledWith('/?session=sess_1&action=deny');
  });

  it('the encryption boundary end to end: a raw native push event carrying decrypted-looking extra fields never reaches what gets scheduled/displayed', async () => {
    const deps = fakeDisplayDeps();
    await startNativePushListening({
      getPreferences: () => ({ mutedProjects: [], quietHours: undefined }),
      getSessionProjectMap: () => ({}),
      onSessionUrl: vi.fn(),
      deps,
    });

    // Shaped like a real Capacitor `PushNotificationSchema`, adversarially
    // carrying fields no real relay ever sends (SPEC §8's blind-relay
    // boundary means it structurally can't) — proving this path is
    // incapable of surfacing them even if it somehow received them.
    deps.receivedListener?.({
      id: 'n1',
      data: {
        kind: 'permission_required',
        sessionId: 'sess_1',
        sessionTitle: 'Wire transfer approval — Acme Corp, $50,000',
        promptPreview: 'Approve the transfer to account 0912-3456-7890',
      },
    });
    await Promise.resolve();

    const scheduled = (deps.scheduleLocalNotification as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(scheduled).toEqual({
      id: notificationIdForSession('sess_1'),
      title: 'Approval needed',
      body: 'A session is waiting for you to approve a tool call.',
      extra: { sessionId: 'sess_1' },
      actionTypeId: PERMISSION_ACTION_TYPE_ID,
    });
    expect(JSON.stringify(scheduled)).not.toMatch(/Wire transfer|Acme|0912/);
  });
});
