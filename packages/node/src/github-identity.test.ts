import { describe, expect, it, vi } from 'vitest';

import { GithubIdentityError, resolveGithubIdentity } from './github-identity';

/** Stubbed GitHub `GET /user` responses only (issue #222's acceptance: never hit the real API). */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('resolveGithubIdentity (SPEC §7.26, issue #222)', () => {
  it('resolves id/login/name/avatarUrl from a well-formed GET /user response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: 1234567,
        login: 'octocat',
        name: 'The Octocat',
        avatar_url: 'https://avatars.githubusercontent.com/u/1234567',
      }),
    );

    const identity = await resolveGithubIdentity('gho_the-token', { fetchImpl });

    expect(identity).toEqual({
      id: 1234567,
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1234567',
    });
  });

  it('sends the token only as a Bearer header, on GET /user', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { id: 1, login: 'octocat' }));

    await resolveGithubIdentity('gho_the-token', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gho_the-token');
  });

  it('a response carrying only a login (no numeric id) is rejected rather than silently used', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { login: 'octocat', name: 'The Octocat' }));

    await expect(resolveGithubIdentity('gho_the-token', { fetchImpl })).rejects.toBeInstanceOf(
      GithubIdentityError,
    );
    await expect(resolveGithubIdentity('gho_the-token', { fetchImpl })).rejects.toThrow(
      /numeric "id"/,
    );
  });

  it('a non-numeric id is rejected the same way as a missing one', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { id: 'octocat', login: 'octocat' }));

    await expect(resolveGithubIdentity('gho_the-token', { fetchImpl })).rejects.toBeInstanceOf(
      GithubIdentityError,
    );
  });

  it('an HTTP error response is rejected without leaking the token into the error message', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' }));

    await expect(
      resolveGithubIdentity('gho_super-secret-token', { fetchImpl }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('gho_super-secret-token') });
  });

  it('no avatar_url on the response yields an undefined avatarUrl, not an empty string', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { id: 1, login: 'octocat' }));

    const identity = await resolveGithubIdentity('gho_the-token', { fetchImpl });

    expect(identity.avatarUrl).toBeUndefined();
  });
});
