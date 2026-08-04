import { describe, expect, it, vi } from 'vitest';

import { JiraIdentityError, resolveJiraIdentity } from './jira-identity';

/** Stubbed Jira `GET /rest/api/3/myself` responses only (issue #225's acceptance: never hit a real Jira site). */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('resolveJiraIdentity (SPEC §7.26, issue #225)', () => {
  it('resolves accountId/displayName/emailAddress/avatarUrl from a well-formed GET /rest/api/3/myself response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        accountId: '5b10a2844c20165700ede21g',
        displayName: 'Ada Lovelace',
        emailAddress: 'ada@example.com',
        avatarUrls: {
          '48x48': 'https://avatar.example.com/48',
          '24x24': 'https://avatar.example.com/24',
        },
      }),
    );

    const identity = await resolveJiraIdentity(
      'https://myteam.atlassian.net',
      'ada@example.com',
      'the-api-token',
      { fetchImpl },
    );

    expect(identity).toEqual({
      accountId: '5b10a2844c20165700ede21g',
      displayName: 'Ada Lovelace',
      emailAddress: 'ada@example.com',
      avatarUrl: 'https://avatar.example.com/48',
    });
  });

  it('sends Basic base64(email:apiToken) on GET {baseUrl}/rest/api/3/myself, with no trailing-slash duplication', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', displayName: 'Ada Lovelace' }));

    await resolveJiraIdentity('https://myteam.atlassian.net/', 'ada@example.com', 'tok-123', {
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://myteam.atlassian.net/rest/api/3/myself');
    const expectedAuth = `Basic ${Buffer.from('ada@example.com:tok-123').toString('base64')}`;
    expect((init.headers as Record<string, string>).authorization).toBe(expectedAuth);
  });

  it('a response carrying no accountId (only email/displayName) is rejected rather than silently keyed on email', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { emailAddress: 'ada@example.com', displayName: 'Ada Lovelace' }),
      );

    await expect(
      resolveJiraIdentity('https://myteam.atlassian.net', 'ada@example.com', 'tok', {
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(JiraIdentityError);
    await expect(
      resolveJiraIdentity('https://myteam.atlassian.net', 'ada@example.com', 'tok', {
        fetchImpl,
      }),
    ).rejects.toThrow(/"accountId"/);
  });

  it('a response with no displayName is rejected', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { accountId: 'acc-1' }));

    await expect(
      resolveJiraIdentity('https://myteam.atlassian.net', 'ada@example.com', 'tok', {
        fetchImpl,
      }),
    ).rejects.toThrow(/"displayName"/);
  });

  it('an HTTP error response (bad credentials) is rejected without leaking the api token into the error message', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { message: 'Unauthorized' }));

    await expect(
      resolveJiraIdentity('https://myteam.atlassian.net', 'ada@example.com', 'super-secret-token', {
        fetchImpl,
      }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('super-secret-token') });
  });

  it('no avatarUrls on the response yields an undefined avatarUrl, not an empty string', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', displayName: 'Ada Lovelace' }));

    const identity = await resolveJiraIdentity(
      'https://myteam.atlassian.net',
      'ada@example.com',
      'tok',
      {
        fetchImpl,
      },
    );

    expect(identity.avatarUrl).toBeUndefined();
  });

  it('no "48x48" key inside avatarUrls also yields an undefined avatarUrl', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        accountId: 'acc-1',
        displayName: 'Ada Lovelace',
        avatarUrls: { '16x16': 'https://avatar.example.com/16' },
      }),
    );

    const identity = await resolveJiraIdentity(
      'https://myteam.atlassian.net',
      'ada@example.com',
      'tok',
      {
        fetchImpl,
      },
    );

    expect(identity.avatarUrl).toBeUndefined();
  });
});
