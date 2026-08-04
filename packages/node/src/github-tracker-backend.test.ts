import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { TrackerBackend, TrackerBinding } from '@loombox/shared';

import {
  GithubTrackerAccessError,
  GithubTrackerBackend,
  GithubTrackerRateLimitError,
  GithubTrackerRequestError,
  type GithubTrackerBackendOptions,
} from './github-tracker-backend';

/**
 * `GithubTrackerBackend` (SPEC §7.10, issues #213/#215) against a stubbed
 * `fetchImpl` only — never the real GitHub API, per the acceptance
 * criterion. Covers the five required methods, `listTransitions`/
 * `transition` (slice 2), the `resolveCredential`-only credential
 * boundary, `capabilities`, and the four real-world GitHub behaviours the
 * issue calls out by name: pagination, rate limiting, 404-as-no-access,
 * and pull-requests-returned-as-issues.
 */

const TOKEN = 'ghp_the-resolved-token';

function githubResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as Response;
}

function binding(overrides: Partial<TrackerBinding> = {}): TrackerBinding {
  return {
    connectionId: 'conn_1',
    target: { owner: 'fiorelorenzo', repo: 'loombox' },
    ...overrides,
  };
}

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 213,
    title: 'stub issue',
    html_url: 'https://github.com/fiorelorenzo/loombox/issues/213',
    state: 'open',
    state_reason: null,
    body: 'body text',
    labels: [],
    assignees: [],
    milestone: null,
    user: { login: 'octocat' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

function backend(
  fetchImpl: typeof fetch,
  extra: Partial<GithubTrackerBackendOptions> = {},
): GithubTrackerBackend {
  return new GithubTrackerBackend({
    resolveCredential: async () => ({ token: TOKEN }),
    fetchImpl,
    ...extra,
  });
}

describe('GithubTrackerBackend.capabilities (issues #213/#215 slices 1+2)', () => {
  it('reports comments/transitions/labels/milestones true, boards/sprints/customFields false', () => {
    const svc = backend(vi.fn());
    expect(svc.capabilities).toEqual({
      comments: true,
      transitions: true,
      boards: false,
      sprints: false,
      labels: true,
      milestones: true,
      customFields: false,
    });
  });

  it('type-level: satisfies the TrackerBackend interface', () => {
    const value: TrackerBackend = backend(vi.fn());
    expect(value.id).toBe('github');
  });
});

describe('GithubTrackerBackend credentials (SPEC §7.10: resolveCredential only)', () => {
  it('resolves the token for the binding.connectionId and sends it as the bearer, and nothing else', async () => {
    const resolveCredential = vi.fn(async (connectionId: string) => {
      expect(connectionId).toBe('conn_1');
      return { token: TOKEN };
    });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      return githubResponse(200, issuePayload());
    });

    const svc = new GithubTrackerBackend({ resolveCredential, fetchImpl });
    await svc.get(binding(), '213');

    expect(resolveCredential).toHaveBeenCalledWith('conn_1');
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });

  it('throws rather than making a request when resolveCredential resolves no usable token', async () => {
    const fetchImpl = vi.fn();
    const svc = new GithubTrackerBackend({
      resolveCredential: async () => ({ token: '' }),
      fetchImpl,
    });

    await expect(svc.get(binding(), '213')).rejects.toBeInstanceOf(GithubTrackerAccessError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never imports a keyring or the device-flow connect service — the injected resolveCredential is the only path to a token', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'github-tracker-backend.ts'),
      'utf8',
    );
    const importSpecifiers = [...source.matchAll(/^import[^;]*from\s+['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    );
    expect(importSpecifiers).not.toContain('./keyring');
    expect(importSpecifiers).not.toContain('./github-connect');
    expect(source).not.toMatch(/process\.env/);
  });
});

describe('GithubTrackerBackend required methods against GitHub REST', () => {
  it('list() GETs the repo issues endpoint and maps items', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/fiorelorenzo/loombox/issues?state=open',
      );
      return githubResponse(200, [issuePayload()]);
    });
    const svc = backend(fetchImpl);

    const page = await svc.list(binding(), {});

    expect(page.items).toEqual([
      {
        externalId: '213',
        title: 'stub issue',
        url: 'https://github.com/fiorelorenzo/loombox/issues/213',
        fields: {
          state: 'open',
          stateReason: null,
          body: 'body text',
          labels: [],
          assignees: [],
          milestone: null,
          author: { login: 'octocat' },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
          closedAt: null,
        },
      },
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('list() maps status/assignee/limit filters onto state/assignee/per_page query params', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/fiorelorenzo/loombox/issues?state=closed&assignee=octocat&per_page=10',
      );
      return githubResponse(200, []);
    });
    const svc = backend(fetchImpl);

    await svc.list(binding(), { status: 'closed', assignee: 'octocat', limit: 10 });
  });

  it('get() GETs the single-issue endpoint and maps the item', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://api.github.com/repos/fiorelorenzo/loombox/issues/213');
      return githubResponse(200, issuePayload());
    });
    const svc = backend(fetchImpl);

    const item = await svc.get(binding(), '213');

    expect(item.externalId).toBe('213');
    expect(item.title).toBe('stub issue');
  });

  it('create() POSTs to the repo issues endpoint with only the known write fields', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/repos/fiorelorenzo/loombox/issues');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ title: 'New issue', labels: ['bug'] });
      return githubResponse(201, issuePayload({ number: 42, title: 'New issue' }));
    });
    const svc = backend(fetchImpl);

    const item = await svc.create(binding(), {
      title: 'New issue',
      labels: ['bug'],
      unknownField: 'dropped, not a real GitHub issue field',
    });

    expect(item.externalId).toBe('42');
    expect(item.title).toBe('New issue');
  });

  it('create() rejects a missing/empty title without making a request', async () => {
    const fetchImpl = vi.fn();
    const svc = backend(fetchImpl);

    await expect(svc.create(binding(), { body: 'no title' })).rejects.toBeInstanceOf(
      GithubTrackerAccessError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('update() PATCHes the single-issue endpoint with only the known write fields', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/repos/fiorelorenzo/loombox/issues/213');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({ state: 'closed' });
      return githubResponse(200, issuePayload({ state: 'closed' }));
    });
    const svc = backend(fetchImpl);

    const item = await svc.update(binding(), '213', { state: 'closed', bogusField: true });

    expect(item.fields.state).toBe('closed');
  });

  it('addComment() POSTs {body} to the issue comments endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/fiorelorenzo/loombox/issues/213/comments',
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ body: 'a comment' });
      return githubResponse(201, { id: 1, body: 'a comment' });
    });
    const svc = backend(fetchImpl);

    await expect(svc.addComment(binding(), '213', 'a comment')).resolves.toBeUndefined();
  });

  it('listBindings() paginates GET /user/repos into TrackerBinding[]', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toBe('https://api.github.com/user/repos?per_page=100');
        return githubResponse(200, [{ owner: { login: 'fiorelorenzo' }, name: 'loombox' }], {
          link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next"',
        });
      }
      expect(String(input)).toBe('https://api.github.com/user/repos?per_page=100&page=2');
      return githubResponse(200, [{ owner: { login: 'fiorelorenzo' }, name: 'loombox-landing' }]);
    });
    const svc = backend(fetchImpl);

    const bindings = await svc.listBindings('conn_1');

    expect(bindings).toEqual([
      { connectionId: 'conn_1', target: { owner: 'fiorelorenzo', repo: 'loombox' } },
      { connectionId: 'conn_1', target: { owner: 'fiorelorenzo', repo: 'loombox-landing' } },
    ]);
  });

  it('rejects a binding whose target is not a GitHubTarget', async () => {
    const svc = backend(vi.fn());
    const jiraShapedBinding = {
      connectionId: 'conn_1',
      target: { cloudId: 'abc', projectKey: 'LB' },
    } as unknown as TrackerBinding;

    await expect(svc.get(jiraShapedBinding, '1')).rejects.toBeInstanceOf(GithubTrackerAccessError);
  });
});

describe('GithubTrackerBackend real-world GitHub behaviour (issue #213 acceptance)', () => {
  it('follows the Link header rel="next" across list() pages via TrackerListFilter.cursor', async () => {
    const nextUrl = 'https://api.github.com/repositories/1/issues?page=2';
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toBe(
          'https://api.github.com/repos/fiorelorenzo/loombox/issues?state=open',
        );
        return githubResponse(200, [issuePayload({ number: 1 })], {
          link: `<${nextUrl}>; rel="next", <https://api.github.com/repos/fiorelorenzo/loombox/issues?state=open&page=3>; rel="last"`,
        });
      }
      expect(String(input)).toBe(nextUrl);
      return githubResponse(200, [issuePayload({ number: 2 })]);
    });
    const svc = backend(fetchImpl);

    const page1 = await svc.list(binding(), {});
    expect(page1.items.map((item) => item.externalId)).toEqual(['1']);
    expect(page1.nextCursor).toBe(nextUrl);

    const page2 = await svc.list(binding(), { cursor: page1.nextCursor });
    expect(page2.items.map((item) => item.externalId)).toEqual(['2']);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('a 403 with x-ratelimit-remaining: 0 raises GithubTrackerRateLimitError, using Retry-After when present', async () => {
    const fetchImpl = vi.fn(async () =>
      githubResponse(
        403,
        { message: 'rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
      ),
    );
    const svc = backend(fetchImpl, { now: () => 0 });

    const error = await svc.get(binding(), '213').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GithubTrackerRateLimitError);
    expect((error as GithubTrackerRateLimitError).retryAfterMs).toBe(30_000);
  });

  it('falls back to x-ratelimit-reset minus now when Retry-After is absent', async () => {
    const fetchImpl = vi.fn(async () =>
      githubResponse(
        403,
        { message: 'rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000060' },
      ),
    );
    const svc = backend(fetchImpl, { now: () => 1_700_000_000_000 });

    const error = await svc.get(binding(), '213').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GithubTrackerRateLimitError);
    expect((error as GithubTrackerRateLimitError).retryAfterMs).toBe(60_000);
  });

  it('a plain 403 with no rate-limit header is a generic request error, not rate limiting', async () => {
    const fetchImpl = vi.fn(async () => githubResponse(403, { message: 'Forbidden' }));
    const svc = backend(fetchImpl);

    const error = await svc.get(binding(), '213').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GithubTrackerRequestError);
    expect((error as GithubTrackerRequestError).status).toBe(403);
  });

  it('reports a 404 as no-access, never as "gone"', async () => {
    const fetchImpl = vi.fn(async () => githubResponse(404, { message: 'Not Found' }));
    const svc = backend(fetchImpl);

    await expect(svc.get(binding(), '999')).rejects.toBeInstanceOf(GithubTrackerAccessError);
  });

  it('list() filters out pull requests, which GitHub returns from the same issues endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      githubResponse(200, [
        issuePayload({ number: 1 }),
        issuePayload({
          number: 2,
          pull_request: { url: 'https://api.github.com/repos/fiorelorenzo/loombox/pulls/2' },
        }),
      ]),
    );
    const svc = backend(fetchImpl);

    const page = await svc.list(binding(), {});

    expect(page.items.map((item) => item.externalId)).toEqual(['1']);
  });

  it('get() rejects a payload that turns out to be a pull request', async () => {
    const fetchImpl = vi.fn(async () =>
      githubResponse(
        200,
        issuePayload({
          number: 5,
          pull_request: { url: 'https://api.github.com/repos/fiorelorenzo/loombox/pulls/5' },
        }),
      ),
    );
    const svc = backend(fetchImpl);

    await expect(svc.get(binding(), '5')).rejects.toBeInstanceOf(GithubTrackerAccessError);
  });
});

describe('GithubTrackerBackend.listTransitions/transition (issue #215 slice 2)', () => {
  it('listTransitions() on an open issue offers exactly close_completed/close_not_planned', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://api.github.com/repos/fiorelorenzo/loombox/issues/213');
      return githubResponse(200, issuePayload({ state: 'open' }));
    });
    const svc = backend(fetchImpl);

    const transitions = await svc.listTransitions(binding(), '213');

    expect(transitions).toEqual([
      { id: 'close_completed', name: 'Close as completed' },
      { id: 'close_not_planned', name: 'Close as not planned' },
    ]);
  });

  it('listTransitions() on a closed issue offers exactly reopen', async () => {
    const fetchImpl = vi.fn(async () =>
      githubResponse(200, issuePayload({ state: 'closed', state_reason: 'completed' })),
    );
    const svc = backend(fetchImpl);

    const transitions = await svc.listTransitions(binding(), '213');

    expect(transitions).toEqual([{ id: 'reopen', name: 'Reopen' }]);
  });

  it('listTransitions() rejects a payload that turns out to be a pull request', async () => {
    const fetchImpl = vi.fn(async () =>
      githubResponse(
        200,
        issuePayload({
          number: 5,
          pull_request: { url: 'https://api.github.com/repos/fiorelorenzo/loombox/pulls/5' },
        }),
      ),
    );
    const svc = backend(fetchImpl);

    await expect(svc.listTransitions(binding(), '5')).rejects.toBeInstanceOf(
      GithubTrackerAccessError,
    );
  });

  it('transition("close_completed") PATCHes {state: "closed", state_reason: "completed"}', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/repos/fiorelorenzo/loombox/issues/213');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({
        state: 'closed',
        state_reason: 'completed',
      });
      return githubResponse(200, issuePayload({ state: 'closed', state_reason: 'completed' }));
    });
    const svc = backend(fetchImpl);

    await expect(svc.transition(binding(), '213', 'close_completed')).resolves.toBeUndefined();
  });

  it('transition("close_not_planned") PATCHes {state: "closed", state_reason: "not_planned"} — distinguishable from close_completed', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({
          state: 'closed',
          state_reason: 'not_planned',
        });
      }
      return githubResponse(200, issuePayload({ state: 'closed', state_reason: 'not_planned' }));
    });
    const svc = backend(fetchImpl);

    await svc.transition(binding(), '213', 'close_not_planned');

    // End-to-end: a subsequent read reports the distinct outcome, not a bare "closed".
    const readBack = await svc.get(binding(), '213');
    expect(readBack.fields.state).toBe('closed');
    expect(readBack.fields.stateReason).toBe('not_planned');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('transition("reopen") PATCHes {state: "open", state_reason: "reopened"}', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/repos/fiorelorenzo/loombox/issues/213');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({ state: 'open', state_reason: 'reopened' });
      return githubResponse(200, issuePayload({ state: 'open', state_reason: 'reopened' }));
    });
    const svc = backend(fetchImpl);

    await expect(svc.transition(binding(), '213', 'reopen')).resolves.toBeUndefined();
  });

  it('transition() rejects an unknown transitionId without making a request — never a discovered per-project workflow', async () => {
    const fetchImpl = vi.fn();
    const svc = backend(fetchImpl);

    await expect(svc.transition(binding(), '213', 'move-to-in-progress')).rejects.toBeInstanceOf(
      GithubTrackerAccessError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
