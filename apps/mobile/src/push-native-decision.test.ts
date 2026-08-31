import { describe, expect, it } from 'vitest';

import { decideNativePushNotification, type NotificationPreferences } from './push-native-decision';

const defaultPrefs: NotificationPreferences = { mutedProjects: [], quietHours: undefined };

describe('decideNativePushNotification (#282)', () => {
  it('returns the derived notification content for a valid, non-suppressed payload', () => {
    const content = decideNativePushNotification(
      { kind: 'permission_required', sessionId: 'sess_1' },
      defaultPrefs,
      {},
    );
    expect(content?.title).toBe('Approval needed');
    expect(content?.options.data).toEqual({ sessionId: 'sess_1' });
  });

  it('returns undefined for an unparseable/unrecognized payload', () => {
    expect(
      decideNativePushNotification({ kind: 'session_finished' }, defaultPrefs, {}),
    ).toBeUndefined();
    expect(decideNativePushNotification(null, defaultPrefs, {})).toBeUndefined();
    expect(decideNativePushNotification(undefined, defaultPrefs, {})).toBeUndefined();
  });

  it('returns undefined for a session whose project is muted (#166 suppression applies natively too)', () => {
    const prefs: NotificationPreferences = { mutedProjects: ['/repo/a'], quietHours: undefined };
    const content = decideNativePushNotification(
      { kind: 'permission_required', sessionId: 'sess_1' },
      prefs,
      { sess_1: '/repo/a' },
    );
    expect(content).toBeUndefined();
  });

  it('returns undefined during quiet hours regardless of project', () => {
    const prefs: NotificationPreferences = {
      mutedProjects: [],
      quietHours: { start: '22:00', end: '07:00' },
    };
    const content = decideNativePushNotification(
      { kind: 'permission_required', sessionId: 'sess_1' },
      prefs,
      {},
      new Date(2026, 0, 1, 23, 0),
    );
    expect(content).toBeUndefined();
  });

  it('the encryption boundary: an adversarial payload carrying decrypted-looking fields never surfaces them, on the native path either', () => {
    const leaky = {
      kind: 'permission_required',
      sessionId: 'sess_1',
      sessionTitle: 'Rotate the leaked prod API key',
      promptPreview: 'Here is the customer database dump you asked me to review',
    };
    const content = decideNativePushNotification(leaky, defaultPrefs, {});
    expect(content?.title).toBe('Approval needed');
    expect(content?.options.body).toBe('A session is waiting for you to approve a tool call.');
    expect(content?.options.data).toEqual({ sessionId: 'sess_1' });
    expect(JSON.stringify(content)).not.toMatch(/API key|customer database|prod/i);
  });
});
