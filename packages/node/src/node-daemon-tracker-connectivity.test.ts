import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_V1,
  connectedAccountSecretRef,
  type ConnectedAccount,
  type EncryptedEnvelope,
  type TrackerConnectivityStatusPayloadV1,
  type TrackerMode,
} from '@loombox/protocol';
import { deriveSessionKey, openJson } from '@loombox/crypto';

import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import { JiraConnectService } from './jira-connect';
import { NodeDaemon } from './node-daemon';
import type { Session } from './session-manager';
import { TrackerModeStore } from './tracker-mode-store';

/**
 * `NodeDaemon`'s own composition of `TrackerConnectivityWatcher` (SPEC
 * §7.10; issue #219) — `resolveTrackerConnectivityTarget`,
 * `pushTrackerConnectivityStatus`, `sendTrackerConnectivityStatus`, and
 * the constructor's watch-registration/`handleTrackerModeSetRequest`
 * wiring. None of these are touched by `tracker-connectivity-watcher.test.ts`
 * (which proves `TrackerConnectivityWatcher` itself, fully decoupled
 * behind an injected `resolveTarget`) or `tracker-connectivity.test.ts`
 * (which proves the error classifier in isolation); this file proves the
 * daemon-side wiring around them: the real `resolveTrackerBackend`
 * composition, the real encrypted `tracker_connectivity_status` push, and
 * that it lands on the right session — using a bare, never-connected
 * `NodeDaemon` (mirrors `node-daemon-ci-check.test.ts`'s identical
 * convention) and a stubbed `trackerBackendFetchImpl`. No real GitHub or
 * relay network call, ever.
 */

const AMK = new Uint8Array(32);
const ACCOUNT_ID = 'acct-tracker-connectivity';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-tracker-connectivity-daemon-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
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

/** Mirrors `node-daemon-ci-check.test.ts`'s identical helper. */
async function seedToken(secretRef: string, token: string): Promise<void> {
  const keyring = createConnectedAccountKeyring({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
  });
  await keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, token);
}

const githubMode: TrackerMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'github:github.com:1111',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
};

interface DaemonOverrides {
  trackerModeStore?: TrackerModeStore;
  trackerBackendFetchImpl?: typeof fetch;
}

function bareDaemon(overrides: DaemonOverrides = {}): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-tracker-connectivity',
    deviceId: 'device-tracker-connectivity',
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
    nodeId: 'node-tracker-connectivity',
    targetId: 'local',
    spendCapUsd: undefined,
    acpSessionId: undefined,
    ...overrides,
  };
}

/** This suite's only seam into the daemon's private tracker-connectivity fields — TS `private` is compile-time only, mirrors `node-daemon-ci-check.test.ts`'s identical convention. */
interface DaemonInternals {
  handleInbound(message: unknown): void;
  trackerConnectivityWatcher: { pollNow(): Promise<void>; watch(projectPath: string): void };
  sessionManager: { sessions: Map<string, Session> };
  relay: { send(message: unknown): void };
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

function seedConnectedAccounts(node: NodeDaemon, accounts: readonly ConnectedAccount[]): void {
  internals(node).handleInbound({
    type: 'connected_account_list',
    protocolVersion: PROTOCOL_V1,
    accounts,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

/**
 * Registers the project's live mode, its session, and its watch entry —
 * the three prerequisites every test case below shares. Deliberately
 * constructs the daemon against an EMPTY `TrackerModeStore` and only
 * saves the project's mode + calls `watch()` AFTER construction: the
 * daemon's own constructor re-`watch`es (and its `start()` immediately
 * `pollNow()`s) every live-mode project already present in the store it
 * was GIVEN, so seeding the mode beforehand would let that implicit
 * startup poll silently consume the test's first `fetchImpl` call before
 * the test's own explicit `pollNow()` ever runs — exactly the kind of
 * off-by-one this suite's own "recovers" test exists to catch elsewhere,
 * not accidentally reproduce here.
 */
function setUpWatchedProject(
  fetchImpl: typeof fetch,
  overrides: { mode?: TrackerMode } = {},
): { node: NodeDaemon; session: Session; sendSpy: ReturnType<typeof vi.spyOn> } {
  const trackerModeStore = new TrackerModeStore({ stateDir });
  const projectPath = '/proj';

  const node = bareDaemon({ trackerModeStore, trackerBackendFetchImpl: fetchImpl });
  trackerModeStore.set(projectPath, overrides.mode ?? githubMode);
  const session = fakeSession({ projectPath });
  internals(node).sessionManager.sessions.set(session.id, session);
  internals(node).trackerConnectivityWatcher.watch(projectPath);
  const sendSpy = vi.spyOn(internals(node).relay, 'send');
  return { node, session, sendSpy };
}

interface SentMessage {
  type: string;
  sessionId?: string;
  envelope?: EncryptedEnvelope;
}

function sentMessagesOfType(sendSpy: ReturnType<typeof vi.spyOn>, type: string): SentMessage[] {
  const messages = sendSpy.mock.calls.map(([message]) => message as SentMessage);
  return messages.filter((message) => message.type === type);
}

async function latestTrackerConnectivityStatus(
  sendSpy: ReturnType<typeof vi.spyOn>,
  sessionId: string,
): Promise<TrackerConnectivityStatusPayloadV1['status']> {
  const messages = sentMessagesOfType(sendSpy, 'tracker_connectivity_status');
  expect(messages.length).toBeGreaterThan(0);
  const last = messages[messages.length - 1];
  expect(last.sessionId).toBe(sessionId);
  expect(last.envelope).toBeDefined();
  const key = await deriveSessionKey(AMK, ACCOUNT_ID, sessionId);
  const payload = await openJson<TrackerConnectivityStatusPayloadV1>(
    sessionId,
    last.envelope as EncryptedEnvelope,
    key,
  );
  return payload.status;
}

describe('NodeDaemon tracker connectivity wiring end to end (SPEC §7.10; issue #219)', () => {
  it('a healthy poll reaches the client as a reachable tracker_connectivity_status, even with zero items returned', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_wiring_token');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));

    const { node, session, sendSpy } = setUpWatchedProject(fetchImpl);
    seedConnectedAccounts(node, [account]);

    try {
      await internals(node).trackerConnectivityWatcher.pollNow();
      const status = await vi.waitFor(() => latestTrackerConnectivityStatus(sendSpy, session.id));
      expect(status).toMatchObject({ state: 'reachable', provider: 'github' });
      const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBe(
        'Bearer ghp_wiring_token',
      );
    } finally {
      node.close();
    }
  });

  it('a 500 from the tracker API reaches the client as unreachable, not authFailed', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_wiring_token');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'server error' }));

    const { node, session, sendSpy } = setUpWatchedProject(fetchImpl);
    seedConnectedAccounts(node, [account]);

    try {
      await internals(node).trackerConnectivityWatcher.pollNow();
      const status = await vi.waitFor(() => latestTrackerConnectivityStatus(sendSpy, session.id));
      expect(status).toMatchObject({ state: 'unreachable', provider: 'github' });
    } finally {
      node.close();
    }
  });

  it('a 401 from the tracker API (expired/revoked token) reaches the client as authFailed, not unreachable', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_expired_token');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' }));

    const { node, session, sendSpy } = setUpWatchedProject(fetchImpl);
    seedConnectedAccounts(node, [account]);

    try {
      await internals(node).trackerConnectivityWatcher.pollNow();
      const status = await vi.waitFor(() => latestTrackerConnectivityStatus(sendSpy, session.id));
      expect(status).toMatchObject({ state: 'authFailed', provider: 'github' });
    } finally {
      node.close();
    }
  });

  it('no connected account at all (a resolution failure, never even an attempted fetch) also reaches the client as authFailed', async () => {
    const fetchImpl = vi.fn();
    const { node, session, sendSpy } = setUpWatchedProject(fetchImpl);
    // Deliberately never seeds any connected account — resolveTrackerBackend
    // fails before ever touching the network.

    try {
      await internals(node).trackerConnectivityWatcher.pollNow();
      const status = await vi.waitFor(() => latestTrackerConnectivityStatus(sendSpy, session.id));
      expect(status).toMatchObject({ state: 'authFailed', provider: 'github' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      node.close();
    }
  });

  it('recovers: an unreachable poll followed by a healthy one pushes reachable, not a stale unreachable reading', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_wiring_token');
    let healthy = false;
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(healthy ? jsonResponse(200, []) : jsonResponse(503, { message: 'down' })),
      );

    const { node, session, sendSpy } = setUpWatchedProject(fetchImpl);
    seedConnectedAccounts(node, [account]);

    try {
      await internals(node).trackerConnectivityWatcher.pollNow();
      const firstStatus = await vi.waitFor(() =>
        latestTrackerConnectivityStatus(sendSpy, session.id),
      );
      expect(firstStatus.state).toBe('unreachable');

      // A construction-time implicit poll (the daemon's own `start()`
      // fires one immediately) can land anywhere in this sequence — wait
      // for the LATEST push to actually read 'reachable' rather than for
      // a specific message count, which would be one flaky guess at
      // exactly how many polls happened by when.
      healthy = true;
      await internals(node).trackerConnectivityWatcher.pollNow();
      const secondStatus = await vi.waitFor(async () => {
        const status = await latestTrackerConnectivityStatus(sendSpy, session.id);
        if (status.state !== 'reachable') {
          throw new Error(`latest tracker_connectivity_status is still "${status.state}"`);
        }
        return status;
      });
      expect(secondStatus.state).toBe('reachable');
    } finally {
      node.close();
    }
  });

  it('a session outside the watched project never receives its tracker_connectivity_status', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_wiring_token');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));

    const { node, sendSpy } = setUpWatchedProject(fetchImpl);
    seedConnectedAccounts(node, [account]);
    const otherSession = fakeSession({ id: 'sess-other-project', projectPath: '/other-proj' });
    internals(node).sessionManager.sessions.set(otherSession.id, otherSession);

    try {
      await internals(node).trackerConnectivityWatcher.pollNow();
      await vi.waitFor(() => latestTrackerConnectivityStatus(sendSpy, 'sess-1'));
      const sentToOther = sendSpy.mock.calls
        .map(([message]) => message as SentMessage)
        .some((message) => message.sessionId === otherSession.id);
      expect(sentToOther).toBe(false);
    } finally {
      node.close();
    }
  });
});
