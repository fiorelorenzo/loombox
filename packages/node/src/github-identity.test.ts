import { describe, expect, it, vi } from 'vitest';

import { GithubIdentityError, githubApiBaseUrl, resolveGithubIdentity } from './github-identity';

/** Stubbed GitHub `GET /user` responses only (issue #222's acceptance: never hit the real API). `headers` defaults to an empty real `Headers` — close to what a bare `{ok, status, json}` double from before issue #223 looked like, minus the `.headers?.get?.()` crash that shape would now hit; `scopesHeader` lets a test opt into a populated `X-OAuth-Scopes` header. */
function jsonResponse(status: number, body: unknown, scopesHeader?: string): Response {
  const headers = new Headers();
  if (scopesHeader !== undefined) headers.set('x-oauth-scopes', scopesHeader);
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers } as Response;
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
      scopes: [],
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

  it('resolves against a caller-supplied apiBaseUrl (GHES) rather than api.github.com', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { id: 1, login: 'octocat' }));

    await resolveGithubIdentity('ghp_the-token', {
      fetchImpl,
      apiBaseUrl: githubApiBaseUrl('ghe.example.com'),
    });

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ghe.example.com/api/v3/user');
  });

  it('githubApiBaseUrl leaves github.com on api.github.com', () => {
    expect(githubApiBaseUrl('github.com')).toBe('https://api.github.com');
    expect(githubApiBaseUrl('ghe.example.com')).toBe('https://ghe.example.com/api/v3');
  });

  it('parses scopes from the X-OAuth-Scopes response header, trimmed', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: 1, login: 'octocat' }, 'repo, read:user,  read:org ,read:project'),
      );

    const identity = await resolveGithubIdentity('gho_the-token', { fetchImpl });

    expect(identity.scopes).toEqual(['repo', 'read:user', 'read:org', 'read:project']);
  });

  it('scopes is an empty array when the response carries no X-OAuth-Scopes header (a fine-grained PAT or GitHub App token)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { id: 1, login: 'octocat' }));

    const identity = await resolveGithubIdentity('github_pat_the-token', { fetchImpl });

    expect(identity.scopes).toEqual([]);
  });

  it('never throws against a response double with no headers property at all (pre-#223 test fixtures elsewhere in this package)', async () => {
    const bareResponse = {
      ok: true,
      status: 200,
      json: async () => ({ id: 1, login: 'octocat' }),
    } as Response;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(bareResponse);

    const identity = await resolveGithubIdentity('gho_the-token', { fetchImpl });

    expect(identity.scopes).toEqual([]);
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
