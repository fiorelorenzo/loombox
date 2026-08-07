import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectedAccountSecretRef,
  PROTOCOL_V1,
  type ConnectedAccount,
  type PrOpenRequestPayloadV1,
  type TrackerMode,
} from '@loombox/protocol';

import { AccountPinStore } from './account-pin-store';
import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import { JiraConnectService } from './jira-connect';
import { NodeDaemon } from './node-daemon';
import type { OpenPrResult } from './pr-open';
import type { Session } from './session-manager';
import { TrackerModeStore } from './tracker-mode-store';

/**
 * `NodeDaemon`'s own composition of `./tracker-pr-linkage-live.ts` (SPEC
 * §7.14 lines 526-530; issue #242) — `writeLiveTrackerPrLinkage` itself:
 * the real `resolveTrackerDispatch` (`resolveTrackerBackend` against a
 * real `GithubConnectService`/`JiraConnectService` and a real
 * file-fallback keyring) plumbed into `LiveTrackerPrLinkageWriter`. Not
 * touched by `tracker-pr-linkage-live.test.ts` (which proves the writer
 * itself, fully decoupled behind a stub `TrackerBackend`) — this file
 * proves the daemon-side wiring around it, mirroring
 * `node-daemon-tracker-connectivity.test.ts`'s identical "bare,
 * never-connected `NodeDaemon` + stubbed `global.fetch`" convention. No
 * real GitHub/Jira/relay network call, ever.
 */

const AMK = new Uint8Array(32);
const ACCOUNT_ID = 'acct-tracker-pr-linkage';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-tracker-pr-linkage-daemon-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base: ConnectedAccount = {
    id: 'github:github.com:1111',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1111',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo'],
    capabilities: ['repo'],
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
    capabilities: ['issues'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef('jira:myteam.atlassian.net:5b10ac8d'),
  };
  return { ...base, ...overrides };
}

/** Mirrors `node-daemon-ci-check.test.ts`'s identical helper. */
async function seedGithubToken(secretRef: string, token: string): Promise<void> {
  const keyring = createConnectedAccountKeyring({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
  });
  await keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, token);
}

/** The keyring-side half of a prior `JiraConnectService.connect()` — mirrors that class's own `JiraApiTokenSecret` JSON shape (`jira-connect.ts`), so `JiraConnectService.getCredential` decodes it back exactly like a real prior device-flow-equivalent connect would have left it. */
async function seedJiraCredential(
  secretRef: string,
  email: string,
  apiToken: string,
): Promise<void> {
  const keyring = createConnectedAccountKeyring({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
  });
  await keyring.set(
    CONNECTED_ACCOUNT_KEYRING_SERVICE,
    secretRef,
    JSON.stringify({ email, apiToken }),
  );
}

const githubMode: TrackerMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'github:github.com:1111',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
};

const jiraMode: TrackerMode = {
  kind: 'live',
  provider: 'jira',
  connectionId: 'jira:myteam.atlassian.net:5b10ac8d',
  target: { cloudId: 'cloud-id-123', projectKey: 'PROJ' },
};

interface DaemonOverrides {
  trackerModeStore?: TrackerModeStore;
  trackerBackendFetchImpl?: typeof fetch;
  accountPinStore?: AccountPinStore;
}

function bareDaemon(overrides: DaemonOverrides = {}): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-tracker-pr-linkage',
    deviceId: 'device-tracker-pr-linkage',
    devicePublicKey: 'YWJjZA==',
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk: AMK,
    stateDir,
    githubConnectService: new GithubConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
    }),
    jiraConnectService: new JiraConnectService({ stateDir }),
    trackerModeStore: overrides.trackerModeStore ?? new TrackerModeStore({ stateDir }),
    trackerBackendFetchImpl: overrides.trackerBackendFetchImpl,
    accountPinStore: overrides.accountPinStore ?? new AccountPinStore({ stateDir }),
  });
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    projectPath: '/proj',
    worktreePath: '/proj-worktree',
    target: 'local',
    provider: 'test-provider',
    branch: 'loombox/session-1',
    createdAt: Date.now(),
    state: 'running',
    nodeId: 'node-tracker-pr-linkage',
    targetId: 'local',
    spendCapUsd: undefined,
    acpSessionId: undefined,
    ...overrides,
  };
}

/** This suite's only seam into the daemon's private write-back method — TS `private` is compile-time only, mirrors `node-daemon-ci-check.test.ts`'s identical convention. */
interface DaemonInternals {
  handleInbound(message: unknown): void;
  writeLiveTrackerPrLinkage(
    session: Session,
    payload: PrOpenRequestPayloadV1,
    opened: OpenPrResult,
  ): Promise<void>;
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

const opened: OpenPrResult = {
  url: 'https://github.com/fiorelorenzo/loombox/pull/42',
  number: 42,
};

describe('NodeDaemon.writeLiveTrackerPrLinkage — GitHub (SPEC §7.14 lines 526-530; issue #242)', () => {
  it('relies on GitHub\u2019s own issue-closing keywords: writes nothing, calls fetch zero times', async () => {
    const fetchImpl = vi.fn();
    const trackerModeStore = new TrackerModeStore({ stateDir });
    trackerModeStore.set('/proj', githubMode);
    const accountPinStore = new AccountPinStore({ stateDir });
    accountPinStore.setPin('/proj', 'github', githubAccount().id);
    const node = bareDaemon({
      trackerModeStore,
      trackerBackendFetchImpl: fetchImpl,
      accountPinStore,
    });
    seedConnectedAccounts(node, [githubAccount()]);
    await seedGithubToken(githubAccount().secretRef, 'ghp_token');

    try {
      await internals(node).writeLiveTrackerPrLinkage(
        fakeSession(),
        { title: 'Closes #123', body: '' },
        opened,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon.writeLiveTrackerPrLinkage — Jira (SPEC §7.14 lines 526-530; issue #242)', () => {
  async function setUpJiraProject(fetchImpl: typeof fetch): Promise<{ node: NodeDaemon }> {
    const trackerModeStore = new TrackerModeStore({ stateDir });
    trackerModeStore.set('/proj', jiraMode);
    const accountPinStore = new AccountPinStore({ stateDir });
    accountPinStore.setPin('/proj', 'jira', jiraAccount().id);
    const node = bareDaemon({
      trackerModeStore,
      trackerBackendFetchImpl: fetchImpl,
      accountPinStore,
    });
    seedConnectedAccounts(node, [jiraAccount()]);
    await seedJiraCredential(jiraAccount().secretRef, 'jane@example.com', 'jira-api-token');
    return { node };
  }

  it('posts a comment linking the PR to the issue named in the PR title/body', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://myteam.atlassian.net/rest/api/3/issue/PROJ-7/comment');
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    const { node } = await setUpJiraProject(fetchImpl);

    try {
      await internals(node).writeLiveTrackerPrLinkage(
        fakeSession(),
        { title: 'PROJ-7: fix the thing', body: '' },
        opened,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      node.close();
    }
  });

  it('is idempotent: a second write-back for the identical (issue, PR) pair calls fetch zero additional times', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const { node } = await setUpJiraProject(fetchImpl);
    const payload: PrOpenRequestPayloadV1 = { title: 'PROJ-7: fix the thing', body: '' };

    try {
      await internals(node).writeLiveTrackerPrLinkage(fakeSession(), payload, opened);
      await internals(node).writeLiveTrackerPrLinkage(fakeSession(), payload, opened);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      node.close();
    }
  });

  it('logs unreachable distinctly from authFailed rather than swallowing either', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unreachableFetch = vi.fn(async () => jsonResponse(503, {})) as unknown as typeof fetch;
    const { node: unreachableNode } = await setUpJiraProject(unreachableFetch);
    try {
      await internals(unreachableNode).writeLiveTrackerPrLinkage(
        fakeSession(),
        { title: 'PROJ-7: fix the thing', body: '' },
        opened,
      );
    } finally {
      unreachableNode.close();
    }
    expect(warnSpy.mock.calls.some(([message]) => String(message).includes('unreachable'))).toBe(
      true,
    );
    expect(warnSpy.mock.calls.some(([message]) => String(message).includes('authFailed'))).toBe(
      false,
    );
    warnSpy.mockClear();

    const authFailedFetch = vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch;
    const { node: authFailedNode } = await setUpJiraProject(authFailedFetch);
    try {
      await internals(authFailedNode).writeLiveTrackerPrLinkage(
        fakeSession(),
        { title: 'PROJ-7: fix the thing', body: '' },
        { url: 'https://github.com/fiorelorenzo/loombox/pull/99', number: 99 },
      );
    } finally {
      authFailedNode.close();
    }
    expect(warnSpy.mock.calls.some(([message]) => String(message).includes('authFailed'))).toBe(
      true,
    );
    expect(warnSpy.mock.calls.some(([message]) => String(message).includes('unreachable'))).toBe(
      false,
    );
  });
});

describe('NodeDaemon.writeLiveTrackerPrLinkage — native mode (issue #242 is never this one\u2019s job)', () => {
  it('is a silent no-op for a native-mode project — issue #241\u2019s job, not this one\u2019s', async () => {
    const fetchImpl = vi.fn();
    const trackerModeStore = new TrackerModeStore({ stateDir });
    trackerModeStore.set('/proj', { kind: 'native' });
    const node = bareDaemon({ trackerModeStore, trackerBackendFetchImpl: fetchImpl });

    try {
      await internals(node).writeLiveTrackerPrLinkage(
        fakeSession(),
        { title: 'fix the thing', body: '' },
        opened,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      node.close();
    }
  });
});

function seedConnectedAccounts(node: NodeDaemon, accounts: readonly ConnectedAccount[]): void {
  internals(node).handleInbound({
    type: 'connected_account_list',
    protocolVersion: PROTOCOL_V1,
    accounts,
  });
}
