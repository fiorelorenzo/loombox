import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { TrackerBackend, TrackerBinding } from '@loombox/shared';

import {
  deriveJiraWorkflowCategory,
  JiraTrackerAccessError,
  JiraTrackerBackend,
  JiraTrackerRequestError,
  JiraTrackerTransitionValidationError,
  type JiraTrackerBackendOptions,
} from './jira-tracker-backend';

/**
 * `JiraTrackerBackend` (SPEC §7.10, issues #214/#216) against a stubbed
 * `fetchImpl` only — never the real Jira API, same convention as
 * `./github-tracker-backend.test.ts` (#213/#215). Covers the required
 * methods, the `resolveCredential`-only credential boundary,
 * `capabilities`, the four real API details issue #214 calls out by name
 * (`search/jql` not the deprecated `search`, ADF comment/description
 * bodies, both REST bases, the create/update follow-up `get`), and #216's
 * discovered-workflow transitions (`listTransitions`/`transition`,
 * required-fields signalling, and the typed `400` validation error).
 */

const AUTH_HEADER = 'Bearer atlassian-oauth-token';
const SITE_BASE = 'https://myteam.atlassian.net';
const OAUTH_BASE = 'https://api.atlassian.com/ex/jira/cloud-id-123';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => {
      throw new Error('no body');
    },
  } as unknown as Response;
}

function binding(overrides: Partial<TrackerBinding> = {}): TrackerBinding {
  return {
    connectionId: 'conn_1',
    target: { cloudId: 'cloud-id-123', projectKey: 'LB' },
    ...overrides,
  };
}

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10000',
    key: 'LB-213',
    self: `${SITE_BASE}/rest/api/3/issue/10000`,
    fields: {
      summary: 'stub issue',
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body text' }] }],
      },
      status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
      issuetype: { name: 'Task' },
      assignee: null,
      reporter: null,
      labels: [],
      priority: { name: 'Medium' },
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
      resolutiondate: null,
    },
    ...overrides,
  };
}

function backend(
  fetchImpl: typeof fetch,
  extra: Partial<JiraTrackerBackendOptions> = {},
): JiraTrackerBackend {
  return new JiraTrackerBackend({
    resolveCredential: async () => ({ baseUrl: SITE_BASE, authHeader: AUTH_HEADER }),
    fetchImpl,
    ...extra,
  });
}

describe('JiraTrackerBackend.capabilities (issues #214/#216)', () => {
  it('reports comments/labels/transitions true, boards/sprints/milestones/customFields false', () => {
    const svc = backend(vi.fn());
    expect(svc.capabilities).toEqual({
      comments: true,
      transitions: true,
      boards: false,
      sprints: false,
      labels: true,
      milestones: false,
      customFields: false,
    });
  });

  it('type-level: satisfies the TrackerBackend interface', () => {
    const value: TrackerBackend = backend(vi.fn());
    expect(value.id).toBe('jira');
  });
});

describe('JiraTrackerBackend credentials (SPEC §7.10: resolveCredential only)', () => {
  it('resolves the credential for the binding.connectionId and sends authHeader verbatim as Authorization', async () => {
    const resolveCredential = vi.fn(async (connectionId: string) => {
      expect(connectionId).toBe('conn_1');
      return { baseUrl: SITE_BASE, authHeader: AUTH_HEADER };
    });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(AUTH_HEADER);
      return jsonResponse(200, issuePayload());
    });

    const svc = new JiraTrackerBackend({ resolveCredential, fetchImpl });
    await svc.get(binding(), 'LB-213');

    expect(resolveCredential).toHaveBeenCalledWith('conn_1');
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });

  it('throws rather than making a request when resolveCredential resolves no usable baseUrl/authHeader', async () => {
    const fetchImpl = vi.fn();
    const svc = new JiraTrackerBackend({
      resolveCredential: async () => ({ baseUrl: '', authHeader: '' }),
      fetchImpl,
    });

    await expect(svc.get(binding(), 'LB-213')).rejects.toBeInstanceOf(JiraTrackerAccessError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never imports jira-connect or a keyring — the injected resolveCredential is the only path to a credential', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'jira-tracker-backend.ts'),
      'utf8',
    );
    const importSpecifiers = [...source.matchAll(/^import[^;]*from\s+['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    );
    expect(importSpecifiers).not.toContain('./jira-connect');
    expect(importSpecifiers).not.toContain('./keyring');
    expect(source).not.toMatch(/process\.env/);
  });
});

describe('JiraTrackerBackend.list — search/jql, not the deprecated search (issue #214 acceptance)', () => {
  it('POSTs to /rest/api/3/search/jql, never GET or POST /rest/api/3/search', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/search/jql`);
      expect(init?.method).toBe('POST');
      return jsonResponse(200, { issues: [issuePayload()], isLast: true });
    });
    const svc = backend(fetchImpl);

    await svc.list(binding(), {});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).not.toContain('/rest/api/3/search"');
    expect(url.endsWith('/search/jql')).toBe(true);
  });

  it('scopes the jql to the bound project and maps status/assignee/query filters onto AND-ed JQL clauses', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.jql).toBe(
        'project = "LB" AND status = "In Progress" AND assignee = "jane" AND text ~ "auth bug"',
      );
      return jsonResponse(200, { issues: [], isLast: true });
    });
    const svc = backend(fetchImpl);

    await svc.list(binding(), { status: 'In Progress', assignee: 'jane', query: 'auth bug' });
  });

  it('escapes a double quote in a filter value so it cannot break out of the JQL string literal', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.jql).toBe('project = "LB" AND status = "Weird \\"Status\\""');
      return jsonResponse(200, { issues: [], isLast: true });
    });
    const svc = backend(fetchImpl);

    await svc.list(binding(), { status: 'Weird "Status"' });
  });

  it('clamps limit into 1-100 for maxResults and carries cursor through as nextPageToken', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.maxResults).toBe(100);
      expect(body.nextPageToken).toBe('opaque-token-abc');
      return jsonResponse(200, { issues: [], isLast: true });
    });
    const svc = backend(fetchImpl);

    await svc.list(binding(), { limit: 500, cursor: 'opaque-token-abc' });
  });

  it('maps isLast:false with a nextPageToken onto TrackerListPage.nextCursor, and isLast:true onto no cursor', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        issues: [issuePayload({ key: 'LB-1' })],
        nextPageToken: 'token-2',
        isLast: false,
      }),
    );
    const svc = backend(fetchImpl);

    const page = await svc.list(binding(), {});

    expect(page.items.map((item) => item.externalId)).toEqual(['LB-1']);
    expect(page.nextCursor).toBe('token-2');
  });

  it('maps an issue payload to a TrackerItemLive, flattening the ADF description to plain text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { issues: [issuePayload()], isLast: true }),
    );
    const svc = backend(fetchImpl);

    const page = await svc.list(binding(), {});

    expect(page.items).toEqual([
      {
        externalId: 'LB-213',
        title: 'stub issue',
        url: `${SITE_BASE}/browse/LB-213`,
        fields: {
          status: 'To Do',
          workflowCategory: 'new',
          issueType: 'Task',
          description: 'body text',
          assignee: null,
          reporter: null,
          labels: [],
          priority: 'Medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          resolvedAt: null,
        },
      },
    ]);
  });
});

describe('deriveJiraWorkflowCategory (issue #651, v7 decision F4-2)', () => {
  it('widens a real statusCategory.key verbatim — no label-guessing table', () => {
    expect(deriveJiraWorkflowCategory('new')).toBe('new');
    expect(deriveJiraWorkflowCategory('indeterminate')).toBe('indeterminate');
    expect(deriveJiraWorkflowCategory('done')).toBe('done');
  });

  it('defaults an unrecognized or missing key to "new" rather than throwing', () => {
    expect(deriveJiraWorkflowCategory('some-future-jira-category')).toBe('new');
    expect(deriveJiraWorkflowCategory(null)).toBe('new');
    expect(deriveJiraWorkflowCategory(undefined)).toBe('new');
  });
});

describe('JiraTrackerBackend.get — workflow category from a realistic issue payload (issue #651)', () => {
  it.each([
    ['To Do', 'new', 'new'],
    ['In Progress', 'indeterminate', 'indeterminate'],
    ['Done', 'done', 'done'],
  ] as const)(
    'status "%s" with statusCategory.key "%s" maps to workflowCategory "%s"',
    async (statusName, categoryKey, expectedCategory) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          200,
          issuePayload({
            fields: {
              ...(issuePayload().fields as Record<string, unknown>),
              status: { name: statusName, statusCategory: { key: categoryKey, name: statusName } },
            },
          }),
        ),
      );
      const svc = backend(fetchImpl);

      const item = await svc.get(binding(), 'LB-213');

      expect(item.fields.status).toBe(statusName);
      expect(item.fields.workflowCategory).toBe(expectedCategory);
    },
  );
});

describe('JiraTrackerBackend required methods against Jira REST v3', () => {
  it('get() GETs the single-issue endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213`);
      return jsonResponse(200, issuePayload());
    });
    const svc = backend(fetchImpl);

    const item = await svc.get(binding(), 'LB-213');

    expect(item.externalId).toBe('LB-213');
    expect(item.title).toBe('stub issue');
  });

  it('rejects a binding whose target is not a JiraTarget', async () => {
    const svc = backend(vi.fn());
    const githubShapedBinding = {
      connectionId: 'conn_1',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    } as unknown as TrackerBinding;

    await expect(svc.get(githubShapedBinding, '1')).rejects.toBeInstanceOf(JiraTrackerAccessError);
  });

  it('reports a 404 as no-access, never as "gone"', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { errorMessages: ['Issue does not exist'] }),
    );
    const svc = backend(fetchImpl);

    await expect(svc.get(binding(), 'LB-999')).rejects.toBeInstanceOf(JiraTrackerAccessError);
  });

  it('a non-404 error status raises JiraTrackerRequestError with the status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { errorMessages: ['boom'] }));
    const svc = backend(fetchImpl);

    const error = await svc.get(binding(), 'LB-213').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JiraTrackerRequestError);
    expect((error as JiraTrackerRequestError).status).toBe(500);
  });

  it('create() rejects a missing/empty summary without making a request', async () => {
    const fetchImpl = vi.fn();
    const svc = backend(fetchImpl);

    await expect(svc.create(binding(), { description: 'no summary' })).rejects.toBeInstanceOf(
      JiraTrackerAccessError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('create() POSTs to /rest/api/3/issue with project.key from the binding, then GETs the created issue (issue #214: create response has no fields)', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue`);
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body)) as { fields: Record<string, unknown> };
        expect(body.fields.project).toEqual({ key: 'LB' });
        expect(body.fields.summary).toBe('New issue');
        // Jira's real create response: {id, key, self} only, no `fields`.
        return jsonResponse(201, {
          id: '10050',
          key: 'LB-250',
          self: `${SITE_BASE}/rest/api/3/issue/10050`,
        });
      }
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-250`);
      return jsonResponse(
        200,
        issuePayload({
          key: 'LB-250',
          fields: { ...(issuePayload().fields as Record<string, unknown>), summary: 'New issue' },
        }),
      );
    });
    const svc = backend(fetchImpl);

    const item = await svc.create(binding(), { summary: 'New issue', unknownField: 'dropped' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(item.externalId).toBe('LB-250');
    expect(item.title).toBe('New issue');
  });

  it('update() PUTs to the single-issue endpoint with only the known write fields, then GETs the issue (issue #214: update response is 204 No Content)', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213`);
        expect(init?.method).toBe('PUT');
        const body = JSON.parse(String(init?.body)) as { fields: Record<string, unknown> };
        expect(body.fields).toEqual({ summary: 'Updated summary' });
        return emptyResponse(204);
      }
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213`);
      expect(init?.method).toBeUndefined();
      return jsonResponse(
        200,
        issuePayload({
          fields: {
            ...(issuePayload().fields as Record<string, unknown>),
            summary: 'Updated summary',
          },
        }),
      );
    });
    const svc = backend(fetchImpl);

    const item = await svc.update(binding(), 'LB-213', {
      summary: 'Updated summary',
      bogusField: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(item.title).toBe('Updated summary');
  });

  it('listBindings() paginates GET /rest/api/3/project/search into TrackerBinding[], resolving cloudId once', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toContain('/_edge/tenant_info');
        return jsonResponse(200, { cloudId: 'discovered-cloud-id' });
      }
      const url = new URL(String(input));
      expect(url.pathname).toBe('/rest/api/3/project/search');
      if (call === 2) {
        expect(url.searchParams.get('startAt')).toBe('0');
        return jsonResponse(200, { values: [{ key: 'LB' }], isLast: false });
      }
      expect(url.searchParams.get('startAt')).toBe('1');
      return jsonResponse(200, { values: [{ key: 'OPS' }], isLast: true });
    });
    const svc = backend(fetchImpl);

    const bindings = await svc.listBindings('conn_1');

    expect(bindings).toEqual([
      { connectionId: 'conn_1', target: { cloudId: 'discovered-cloud-id', projectKey: 'LB' } },
      { connectionId: 'conn_1', target: { cloudId: 'discovered-cloud-id', projectKey: 'OPS' } },
    ]);
  });

  it('listBindings() reads the cloudId straight from an OAuth-routed baseUrl instead of calling tenant_info', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).not.toContain('/_edge/tenant_info');
      return jsonResponse(200, { values: [{ key: 'LB' }], isLast: true });
    });
    const svc = backend(fetchImpl, {
      resolveCredential: async () => ({ baseUrl: OAUTH_BASE, authHeader: AUTH_HEADER }),
    });

    const bindings = await svc.listBindings('conn_1');

    expect(bindings).toEqual([
      { connectionId: 'conn_1', target: { cloudId: 'cloud-id-123', projectKey: 'LB' } },
    ]);
  });
});

describe('JiraTrackerBackend ADF write path (issue #214 acceptance)', () => {
  it('addComment() posts a minimal {type:"doc", version:1, content:[...]} ADF document, not raw markdown', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213/comment`);
      expect(init?.method).toBe('POST');
      const sent = JSON.parse(String(init?.body)) as { body: Record<string, unknown> };
      expect(sent.body).toEqual({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a plain-text comment' }] }],
      });
      return jsonResponse(201, { id: '1', body: sent.body });
    });
    const svc = backend(fetchImpl);

    await expect(
      svc.addComment(binding(), 'LB-213', 'a plain-text comment'),
    ).resolves.toBeUndefined();
  });

  it('create()/update() convert a plain-text description into the same minimal ADF shape, never sending raw markdown', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        const body = JSON.parse(String(init?.body)) as {
          fields: { description: Record<string, unknown> };
        };
        expect(body.fields.description).toEqual({
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain text body' }] }],
        });
        return jsonResponse(201, {
          id: '1',
          key: 'LB-300',
          self: `${SITE_BASE}/rest/api/3/issue/1`,
        });
      }
      return jsonResponse(200, issuePayload({ key: 'LB-300' }));
    });
    const svc = backend(fetchImpl);

    await svc.create(binding(), { summary: 'x', description: 'plain text body' });
  });
});

describe('JiraTrackerBackend two REST bases (issue #214 acceptance)', () => {
  it('routes every call through https://api.atlassian.com/ex/jira/{cloudId} for an OAuth 3LO credential', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${OAUTH_BASE}/rest/api/3/issue/LB-213`);
      return jsonResponse(200, issuePayload());
    });
    const svc = backend(fetchImpl, {
      resolveCredential: async () => ({
        baseUrl: OAUTH_BASE,
        authHeader: 'Bearer oauth-3lo-token',
      }),
    });

    const item = await svc.get(binding(), 'LB-213');

    // api.atlassian.com/ex/jira/{cloudId} isn't itself a browsable host —
    // falls back to the issue's own `self` link (see this backend's own
    // `issueBrowseUrl` doc comment).
    expect(item.url).toBe(issuePayload().self as string);
  });

  it('routes every call straight to the site host for an API-token credential', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213`);
      return jsonResponse(200, issuePayload());
    });
    const svc = backend(fetchImpl, {
      resolveCredential: async () => ({ baseUrl: SITE_BASE, authHeader: 'Basic dGVzdDp0ZXN0' }),
    });

    const item = await svc.get(binding(), 'LB-213');

    expect(item.url).toBe(`${SITE_BASE}/browse/LB-213`);
  });
});

describe('JiraTrackerBackend.listTransitions/transition (issue #216 acceptance)', () => {
  it("listTransitions() GETs .../issue/{key}/transitions and maps id/name/requiresFields/targetCategory (issue #696) from Jira's own discovered workflow", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213/transitions`);
      expect(init?.method).toBeUndefined();
      return jsonResponse(200, {
        transitions: [
          { id: '11', name: 'To Do', fields: {}, to: { statusCategory: { key: 'new' } } },
          {
            id: '21',
            name: 'Done',
            fields: { resolution: { required: true, name: 'Resolution' } },
            to: { statusCategory: { key: 'done' } },
          },
        ],
      });
    });
    const svc = backend(fetchImpl);

    const transitions = await svc.listTransitions(binding(), 'LB-213');

    expect(transitions).toEqual([
      { id: '11', name: 'To Do', requiresFields: false, targetCategory: 'new' },
      { id: '21', name: 'Done', requiresFields: true, targetCategory: 'done' },
    ]);
  });

  it('listTransitions() defaults targetCategory to "new" when Jira omits `to.statusCategory` entirely (issue #696)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { transitions: [{ id: '31', name: 'Some future status', fields: {} }] }),
    );
    const svc = backend(fetchImpl);

    const transitions = await svc.listTransitions(binding(), 'LB-213');

    expect(transitions).toEqual([
      { id: '31', name: 'Some future status', requiresFields: false, targetCategory: 'new' },
    ]);
  });

  it('listTransitions() rejects a binding whose target is not a JiraTarget', async () => {
    const svc = backend(vi.fn());
    const githubShapedBinding = {
      connectionId: 'conn_1',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    } as unknown as TrackerBinding;

    await expect(svc.listTransitions(githubShapedBinding, 'LB-213')).rejects.toBeInstanceOf(
      JiraTrackerAccessError,
    );
  });

  it('transition() POSTs the discovered transition id to .../transitions', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213/transitions`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ transition: { id: '21' } });
      return emptyResponse(204);
    });
    const svc = backend(fetchImpl);

    await expect(svc.transition(binding(), 'LB-213', '21')).resolves.toBeUndefined();
  });

  it('transition() forwards options.fields verbatim and converts options.comment to the same ADF shape addComment uses', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213/transitions`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        transition: { id: '21' },
        fields: { resolution: { name: 'Done' } },
        update: {
          comment: [
            {
              add: {
                body: {
                  type: 'doc',
                  version: 1,
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'closing out' }] },
                  ],
                },
              },
            },
          ],
        },
      });
      return emptyResponse(204);
    });
    const svc = backend(fetchImpl);

    await expect(
      svc.transition(binding(), 'LB-213', '21', {
        fields: { resolution: { name: 'Done' } },
        comment: 'closing out',
      }),
    ).resolves.toBeUndefined();
  });

  it("transition() surfaces Jira's own 400 required-field validation as a typed error, never a silent success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        errorMessages: [],
        errors: { resolution: 'Resolution is required' },
      }),
    );
    const svc = backend(fetchImpl);

    const error = await svc
      .transition(binding(), 'LB-213', '21')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JiraTrackerTransitionValidationError);
    expect((error as JiraTrackerTransitionValidationError).errors).toEqual({
      resolution: 'Resolution is required',
    });
  });

  it('listTransitions()/transition() route through both REST bases like every other call', async () => {
    const oauthFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${OAUTH_BASE}/rest/api/3/issue/LB-213/transitions`);
      return jsonResponse(200, { transitions: [{ id: '11', name: 'To Do' }] });
    });
    const oauthSvc = backend(oauthFetch, {
      resolveCredential: async () => ({ baseUrl: OAUTH_BASE, authHeader: 'Bearer oauth' }),
    });
    await oauthSvc.listTransitions(binding(), 'LB-213');
    expect(oauthFetch).toHaveBeenCalledTimes(1);

    const siteFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213/transitions`);
      expect(init?.method).toBe('POST');
      return emptyResponse(204);
    });
    const siteSvc = backend(siteFetch);
    await siteSvc.transition(binding(), 'LB-213', '11');
    expect(siteFetch).toHaveBeenCalledTimes(1);
  });
});
