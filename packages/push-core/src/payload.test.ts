import { describe, expect, it } from 'vitest';

import {
  notificationContentFor,
  parsePushPayload,
  sessionUrlFromNotificationData,
} from './payload';

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

describe('notificationContentFor (#164, #282)', () => {
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

  it('the encryption boundary: an adversarial payload carrying extra sensitive-looking fields never influences what is shown (#282 — this is the guarantee both the web push path and the native/FCM/APNs path share)', () => {
    // `parsePushPayload` only ever produces `{ kind, sessionId }` from valid
    // input, but this exercises `notificationContentFor` directly against
    // a hand-built payload carrying fields no real relay would ever send
    // (SPEC §8's blind-relay boundary means the relay itself never has
    // them either) — the point is that even if it somehow did, this
    // function is structurally incapable of surfacing them: it only ever
    // reads `payload.sessionId`, never any other key.
    const leaky = {
      kind: 'permission_required',
      sessionId: 'sess_1',
      // A hypothetical leak: real session content that must never reach a
      // push provider (Web Push service, FCM, APNs).
      sessionTitle: 'Fix production auth bug — customer PII in logs',
      promptPreview: 'Please redact the SSNs in payload.json before committing',
    } as unknown as { kind: 'permission_required'; sessionId: string };

    const content = notificationContentFor(leaky);
    expect(content.title).toBe('Approval needed');
    expect(content.options.body).toBe('A session is waiting for you to approve a tool call.');
    expect(content.options.data).toEqual({ sessionId: 'sess_1' });
    expect(JSON.stringify(content)).not.toMatch(/PII|SSN|auth bug|redact/i);
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
