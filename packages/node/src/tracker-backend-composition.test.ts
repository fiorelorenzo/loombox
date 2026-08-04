import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectedAccountSecretRef,
  type ConnectedAccount,
  type TrackerMode,
} from '@loombox/protocol';
import type { TrackerBinding } from '@loombox/shared';

import type { AccountPinMap } from './account-pin';
import {
  createConnectedAccountKeyring,
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
} from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import { JiraConnectService } from './jira-connect';
import {
  resolveTrackerBackend,
  type ResolveTrackerBackendOptions,
} from './tracker-backend-composition';

/**
 * `resolveTrackerBackend` (SPEC §7.10, §7.26; issue #631) against stub
 * `githubConnectService`/`jiraConnectService` collaborators for most
 * cases (fast, focused on this module's own resolution logic) plus a
 * handful of end-to-end cases against the real `GithubConnectService`/
 * `JiraConnectService` and a real file-fallback keyring, proving the
 * credential-from-keyring-only property genuinely end to end rather than
 * only through a stub's own promise.
 */

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base: ConnectedAccount = {
    id: 'github:github.com:1111',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1111',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo', 'read:user', 'read:org'],
    capabilities: ['repo', 'issues'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef('github:github.com:1111'),
  };
  return { ...base, ...overrides };
}

function jiraAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base: ConnectedAccount = {
    id: 'jira:myteam.atlassian.net:5b10ac8d',
    provider: 'jira',
    host: 'myteam.atlassian.net',
    providerAccountId: '5b10ac8d',
    label: 'Jane Doe',
    credentialSource: 'api_token',
    scopes: null,
    capabilities: ['issues', 'boards'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef('jira:myteam.atlassian.net:5b10ac8d'),
  };
  return { ...base, ...overrides };
}

function liveGithubMode(
  overrides: Partial<Extract<TrackerMode, { kind: 'live' }>> = {},
): TrackerMode {
  return {
    kind: 'live',
    provider: 'github',
    connectionId: 'github:github.com:1111',
    target: { owner: 'fiorelorenzo', repo: 'loombox' },
    ...overrides,
  };
}

function liveJiraMode(
  overrides: Partial<Extract<TrackerMode, { kind: 'live' }>> = {},
): TrackerMode {
  return {
    kind: 'live',
    provider: 'jira',
    connectionId: 'jira:myteam.atlassian.net:5b10ac8d',
    target: { cloudId: 'cloud-id-123', projectKey: 'LB' },
    ...overrides,
  };
}

/** A `githubConnectService`/`jiraConnectService` double backed by a plain in-memory map — no keyring, no file system — for every test that isn't specifically proving the real-keyring round trip below. */
function stubGithubConnectService(tokens: Record<string, string | undefined> = {}) {
  return {
    getAccessToken: vi.fn(async (account: Pick<ConnectedAccount, 'secretRef'>) =>
      Object.prototype.hasOwnProperty.call(tokens, account.secretRef)
        ? tokens[account.secretRef]
        : undefined,
    ),
  };
}

function stubJiraConnectService(
  credentials: Record<string, { baseUrl: string; authHeader: string } | undefined> = {},
) {
  return {
    getCredential: vi.fn(
      async (account: Pick<ConnectedAccount, 'host' | 'secretRef' | 'credentialSource'>) =>
        Object.prototype.hasOwnProperty.call(credentials, account.secretRef)
          ? credentials[account.secretRef]
          : undefined,
    ),
  };
}

function baseOptions(
  overrides: Partial<ResolveTrackerBackendOptions> = {},
): ResolveTrackerBackendOptions {
  return {
    mode: liveGithubMode(),
    projectPath: '/projects/a',
    intent: 'read',
    accounts: [githubAccount()],
    pins: {},
    githubConnectService: stubGithubConnectService({
      [connectedAccountSecretRef('github:github.com:1111')]: 'ghp_token',
    }),
    jiraConnectService: stubJiraConnectService(),
    ...overrides,
  };
}

describe('resolveTrackerBackend — native mode is not this module\u2019s job', () => {
  it('returns {ok:false, error:{kind:"nativeMode"}} for a native mode, never a fabricated backend', async () => {
    const result = await resolveTrackerBackend(baseOptions({ mode: { kind: 'native' } }));
    expect(result).toEqual({ ok: false, error: { kind: 'nativeMode' } });
  });
});

describe('resolveTrackerBackend — connected-account registry lookup', () => {
  it('accountNotConnected when connectionId names no known account', async () => {
    const result = await resolveTrackerBackend(baseOptions({ accounts: [] }));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'accountNotConnected', connectionId: 'github:github.com:1111' },
    });
  });

  it('accountNotConnected when the id matches but the provider does not (a corrupted/mismatched mode)', async () => {
    // Deliberately constructs a fixture whose `id` collides with the
    // mode's connectionId but whose `provider` field disagrees —
    // `composeConnectedAccountId` would never produce this on a real
    // connect flow; this proves the registry lookup checks `provider`
    // too, not just `id`.
    const corrupted = githubAccount({ provider: 'jira' });
    const result = await resolveTrackerBackend(baseOptions({ accounts: [corrupted] }));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'accountNotConnected', connectionId: 'github:github.com:1111' },
    });
  });
});

describe('resolveTrackerBackend — every #227 hard-fail case', () => {
  it('AccountPinRequiredError -> accountPinRequired (write intent, no pin at all)', async () => {
    const result = await resolveTrackerBackend(baseOptions({ intent: 'write', pins: {} }));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'accountPinRequired', capability: 'github' },
    });
  });

  it('AccountPinMalformedError -> accountPinMalformed (explicit pin does not parse as a connected-account id)', async () => {
    const result = await resolveTrackerBackend(
      baseOptions({ intent: 'write', pins: { github: 'not-a-valid-id' } }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'accountPinMalformed',
        capability: 'github',
        pinnedAccountId: 'not-a-valid-id',
      },
    });
  });

  it('AccountPinDanglingError -> accountPinDangling (explicit pin names an unknown account)', async () => {
    const result = await resolveTrackerBackend(
      baseOptions({ intent: 'write', pins: { github: 'github:github.com:9999' } }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'accountPinDangling',
        capability: 'github',
        pinnedAccountId: 'github:github.com:9999',
      },
    });
  });

  it('AccountHostMismatchError -> accountHostMismatch (pinned account is a real account of a different host)', async () => {
    const ghes = githubAccount({
      id: 'github:ghes.example.com:2222',
      host: 'ghes.example.com',
      providerAccountId: '2222',
      secretRef: connectedAccountSecretRef('github:ghes.example.com:2222'),
    });
    const result = await resolveTrackerBackend(
      baseOptions({
        intent: 'write',
        accounts: [githubAccount(), ghes],
        pins: { github: 'github:ghes.example.com:2222' },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'accountHostMismatch',
        capability: 'github',
        pinnedAccountId: 'github:ghes.example.com:2222',
        expectedHost: 'github.com',
        actualHost: 'ghes.example.com',
      },
    });
  });

  it('AmbiguousAccountError -> accountAmbiguous (read intent, no pin, two matching candidates)', async () => {
    const other = githubAccount({
      id: 'github:github.com:2222',
      providerAccountId: '2222',
      secretRef: connectedAccountSecretRef('github:github.com:2222'),
    });
    const result = await resolveTrackerBackend(
      baseOptions({ intent: 'read', accounts: [githubAccount(), other], pins: {} }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'accountAmbiguous',
        capability: 'github',
        candidateAccountIds: expect.arrayContaining([
          'github:github.com:1111',
          'github:github.com:2222',
        ]),
      },
    });
  });

  it('an explicit opt-out (pin === null) resolves to accountPinOptedOut for a read, never a silent fallback', async () => {
    const result = await resolveTrackerBackend(
      baseOptions({ intent: 'read', pins: { github: null } }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'accountPinOptedOut', capability: 'github' },
    });
  });
});

describe('resolveTrackerBackend — cross-project isolation', () => {
  it('never resolves one project\u2019s mode against a different project\u2019s pinned account', async () => {
    const projectAAccount = githubAccount();
    const projectBAccount = githubAccount({
      id: 'github:github.com:2222',
      providerAccountId: '2222',
      secretRef: connectedAccountSecretRef('github:github.com:2222'),
    });
    const accounts = [projectAAccount, projectBAccount];

    // Project A pins its own account for the write capability; project B
    // pins a *different* account. Both maps are individually valid.
    const projectAPins: AccountPinMap = { github: 'github:github.com:1111' };
    const projectBPins: AccountPinMap = { github: 'github:github.com:2222' };

    // Resolving project A's mode through project A's own pins succeeds,
    // against project A's own account.
    const okResult = await resolveTrackerBackend(
      baseOptions({ intent: 'write', accounts, pins: projectAPins, projectPath: '/projects/a' }),
    );
    expect(okResult.ok).toBe(true);

    // Resolving project A's *mode* against project B's *pins* — e.g. a
    // caller bug that mismatched which project's pin map it read — must
    // never silently succeed with project B's pinned account. It is
    // rejected as a mismatch, not laundered through as a valid
    // resolution.
    const crossedResult = await resolveTrackerBackend(
      baseOptions({ intent: 'write', accounts, pins: projectBPins, projectPath: '/projects/a' }),
    );
    expect(crossedResult).toEqual({
      ok: false,
      error: {
        kind: 'connectionPinMismatch',
        connectionId: 'github:github.com:1111',
        pinnedAccountId: 'github:github.com:2222',
      },
    });
  });

  it('a composed backend refuses to serve a connectionId other than the one it was composed for', async () => {
    const result = await resolveTrackerBackend(baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const fetchImpl = vi.fn();
    // Simulate a backend instance being reused for a different
    // project's binding — the exact foot-gun the backends' own "reusable
    // across every bound repo/project" doc comments flag.
    const foreignBinding: TrackerBinding = {
      connectionId: 'github:github.com:9999',
      target: { owner: 'someone-else', repo: 'other-repo' },
    };
    await expect(result.backend.get(foreignBinding, '1')).rejects.toThrow(
      /refusing to serve another project's connected account/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolveTrackerBackend — credential comes from the node keyring only', () => {
  it('credentialUnavailable when the github keyring has no secret for the resolved account, even though the account itself resolves cleanly', async () => {
    const result = await resolveTrackerBackend(
      baseOptions({ githubConnectService: stubGithubConnectService({}) }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'credentialUnavailable', connectionId: 'github:github.com:1111' },
    });
  });

  it('credentialUnavailable when the jira keyring has no secret for the resolved account', async () => {
    const result = await resolveTrackerBackend(
      baseOptions({
        mode: liveJiraMode(),
        accounts: [jiraAccount()],
        jiraConnectService: stubJiraConnectService({}),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'credentialUnavailable', connectionId: 'jira:myteam.atlassian.net:5b10ac8d' },
    });
  });

  it('credentialSourceUnsupported for a jira account connected via a credentialSource this node cannot yet resolve (oauth_3lo)', async () => {
    const result = await resolveTrackerBackend(
      baseOptions({
        mode: liveJiraMode(),
        accounts: [jiraAccount({ credentialSource: 'oauth_3lo' })],
        jiraConnectService: stubJiraConnectService({
          [connectedAccountSecretRef('jira:myteam.atlassian.net:5b10ac8d')]: {
            baseUrl: 'https://api.atlassian.com/ex/jira/cloud-id-123',
            authHeader: 'Bearer x',
          },
        }),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'credentialSourceUnsupported',
        connectionId: 'jira:myteam.atlassian.net:5b10ac8d',
        credentialSource: 'oauth_3lo',
      },
    });
  });

  it('never accepts a credential as an input — no field of ResolveTrackerBackendOptions is a token/secret, only the two connect-service collaborators can ever supply one', () => {
    const options = baseOptions();
    // Structural: the only two fields shaped like a credential source are
    // the injected connect services, which are the sanctioned keyring
    // gateway (SPEC §7.26) — nothing else in the options bag can smuggle
    // a token in from a relay-bound payload.
    const keys = Object.keys(options);
    expect(keys).toEqual(
      expect.arrayContaining([
        'mode',
        'projectPath',
        'intent',
        'accounts',
        'pins',
        'githubConnectService',
        'jiraConnectService',
      ]),
    );
    for (const key of keys) {
      expect(key.toLowerCase()).not.toMatch(/token|secret|credential$/);
    }
  });

  it('end-to-end: a real GithubConnectService + real (file-fallback) keyring — composition fails before connect(), succeeds after, using the actual stored token', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-tracker-composition-gh-'));
    try {
      const githubConnectService = new GithubConnectService({
        stateDir,
        osKeyringBackendFactory: async () => undefined,
      });
      const account = githubAccount();

      const beforeConnect = await resolveTrackerBackend(
        baseOptions({ accounts: [account], githubConnectService }),
      );
      expect(beforeConnect).toEqual({
        ok: false,
        error: { kind: 'credentialUnavailable', connectionId: account.id },
      });

      // Write directly into the same shared keyring this service reads —
      // the local equivalent of a prior `connect()` device-flow run.
      const keyring = createConnectedAccountKeyring({
        stateDir,
        osKeyringBackendFactory: async () => undefined,
      });
      await keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, account.secretRef, 'ghp_real_token');

      const afterConnect = await resolveTrackerBackend(
        baseOptions({ accounts: [account], githubConnectService }),
      );
      expect(afterConnect.ok).toBe(true);
      if (!afterConnect.ok) throw new Error('unreachable');

      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer ghp_real_token',
        );
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            number: 1,
            title: 't',
            html_url: 'https://github.com/a/b/issues/1',
            state: 'open',
            state_reason: null,
            body: '',
            labels: [],
            assignees: [],
            milestone: null,
            user: { login: 'octocat' },
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            closed_at: null,
          }),
        } as unknown as Response;
      });
      const secondBackend = await resolveTrackerBackend(
        baseOptions({ accounts: [account], githubConnectService, fetchImpl }),
      );
      if (!secondBackend.ok) throw new Error('unreachable');
      await secondBackend.backend.get(
        { connectionId: account.id, target: { owner: 'a', repo: 'b' } },
        '1',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('resolveTrackerBackend — successful composition', () => {
  it('github: returns a working TrackerBackend whose resolveCredential is sourced from githubConnectService and re-fetched per call', async () => {
    let currentToken = 'token-v1';
    const githubConnectService = {
      getAccessToken: vi.fn(async () => currentToken),
    };
    const result = await resolveTrackerBackend(baseOptions({ githubConnectService }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.backend.id).toBe('github');

    const binding: TrackerBinding = {
      connectionId: 'github:github.com:1111',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    };
    const seenAuthHeaders: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenAuthHeaders.push((init?.headers as Record<string, string>).authorization);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          number: 1,
          title: 't',
          html_url: 'https://github.com/a/b/issues/1',
          state: 'open',
          state_reason: null,
          body: '',
          labels: [],
          assignees: [],
          milestone: null,
          user: { login: 'octocat' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          closed_at: null,
        }),
      } as unknown as Response;
    });
    // The composed backend's `fetchImpl` was fixed at composition time in
    // `baseOptions()` (undefined -> global fetch); rebuild with the test
    // double instead so this assertion can observe the outgoing header.
    const withFetch = await resolveTrackerBackend(baseOptions({ githubConnectService, fetchImpl }));
    if (!withFetch.ok) throw new Error('unreachable');
    await withFetch.backend.get(binding, '1');
    currentToken = 'token-v2-rotated';
    await withFetch.backend.get(binding, '1');

    expect(seenAuthHeaders).toEqual(['Bearer token-v1', 'Bearer token-v2-rotated']);
  });

  it('jira: returns a working TrackerBackend sourced from jiraConnectService', async () => {
    const credential = { baseUrl: 'https://myteam.atlassian.net', authHeader: 'Basic xyz' };
    const jiraConnectService = { getCredential: vi.fn(async () => credential) };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: '1',
        key: 'LB-1',
        self: 'https://myteam.atlassian.net/rest/api/3/issue/1',
        fields: {
          summary: 's',
          description: null,
          status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
          issuetype: { name: 'Task' },
          assignee: null,
          reporter: null,
          labels: [],
          priority: null,
          created: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:00.000Z',
          resolutiondate: null,
        },
      }),
    })) as unknown as typeof fetch;

    const result = await resolveTrackerBackend(
      baseOptions({
        mode: liveJiraMode(),
        accounts: [jiraAccount()],
        jiraConnectService,
        fetchImpl,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.backend.id).toBe('jira');

    await result.backend.get(
      {
        connectionId: 'jira:myteam.atlassian.net:5b10ac8d',
        target: { cloudId: 'cloud-id-123', projectKey: 'LB' },
      },
      'LB-1',
    );
    expect(jiraConnectService.getCredential).toHaveBeenCalled();
  });
});

describe('resolveTrackerBackend — real GithubConnectService/JiraConnectService round trips stay isolated per node stateDir', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-tracker-composition-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('jira credentialSource gating still applies against a real JiraConnectService with nothing connected', async () => {
    const jiraConnectService = new JiraConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    const result = await resolveTrackerBackend(
      baseOptions({
        mode: liveJiraMode(),
        accounts: [jiraAccount()],
        jiraConnectService,
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'credentialUnavailable',
        connectionId: 'jira:myteam.atlassian.net:5b10ac8d',
      },
    });
  });
});
