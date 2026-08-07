import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_V1,
  connectedAccountSecretRef,
  type ConnectedAccount,
  type EncryptedEnvelope,
  type PrMergeOutcome,
  type PrMergeRequestPayloadV1,
  type PrMergeResultPayloadV1,
  type ReviewCommentStatusPayloadV1,
} from '@loombox/protocol';
import { deriveSessionKey, openJson, sealJson } from '@loombox/crypto';

import { AccountPinStore } from './account-pin-store';
import { CiWatchStore } from './ci-watch-store';
import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import { LocalExecutionTarget } from './local-execution-target';
import { NodeDaemon } from './node-daemon';
import type { OpenPrResult } from './pr-open';
import type { CiWatchEntry } from './ci-check-watcher';
import type { Session } from './session-manager';

/**
 * `NodeDaemon`'s own composition of `ReviewCommentWatcher`/`mergePr`
 * (SPEC §7.14; issue #240) — `registerCiCheckWatch`'s doubled-up
 * registration, `sendReviewCommentStatus`, and `handlePrMergeRequest`.
 * Mirrors `node-daemon-ci-check.test.ts`'s own harness almost exactly: a
 * bare, never-connected `NodeDaemon`, a real file-fallback keyring, and a
 * stubbed `global.fetch`. No real GitHub or relay network call, ever.
 */

const AMK = new Uint8Array(32);
const ACCOUNT_ID = 'acct-review-comment';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-review-comment-daemon-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
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

async function seedToken(secretRef: string, token: string): Promise<void> {
  const keyring = createConnectedAccountKeyring({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
  });
  await keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, token);
}

function bareDaemon(overrides: { ciCheckWatchStore?: CiWatchStore } = {}): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-review-comment',
    deviceId: 'device-review-comment',
    devicePublicKey: 'YWJjZA==',
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk: AMK,
    stateDir,
    accountPinStore: new AccountPinStore({ stateDir }),
    githubConnectService: new GithubConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
    }),
    ciCheckWatchStore: overrides.ciCheckWatchStore ?? new CiWatchStore({ stateDir }),
  });
}

function seedConnectedAccounts(node: NodeDaemon, accounts: readonly ConnectedAccount[]): void {
  internals(node).handleInbound({
    type: 'connected_account_list',
    protocolVersion: PROTOCOL_V1,
    accounts,
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
    nodeId: 'node-review-comment',
    targetId: 'local',
    spendCapUsd: undefined,
    acpSessionId: undefined,
    ...overrides,
  };
}

interface SentMessage {
  readonly type: string;
  readonly sessionId: string;
  readonly envelope: EncryptedEnvelope;
}

/** Casts every captured `relay.send` call once into a typed array — the one place this suite ever reads `.type` off a raw `unknown` send, so every later filter/find below is a plain, checked property access rather than a repeated inline cast. */
function sentMessagesOf(sendSpy: ReturnType<typeof vi.spyOn>): SentMessage[] {
  return sendSpy.mock.calls.map(([message]) => message as SentMessage);
}

interface DaemonInternals {
  handleInbound(message: unknown): void;
  registerCiCheckWatch(
    session: Session,
    target: LocalExecutionTarget,
    opened: OpenPrResult,
  ): Promise<void>;
  ciCheckWatchStore: CiWatchStore;
  reviewCommentWatcher: { pollNow(): Promise<void> };
  sessionManager: { sessions: Map<string, Session> };
  relay: { send(message: unknown): void };
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

function reviewThreadsResponse(
  threads: Array<{
    id: string;
    isResolved: boolean;
    comments: Array<{ id: string; body: string }>;
  }>,
): Response {
  return new Response(
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: threads.map((thread) => ({
                id: thread.id,
                isResolved: thread.isResolved,
                comments: {
                  nodes: thread.comments.map((comment) => ({
                    id: comment.id,
                    body: comment.body,
                    path: 'src/foo.ts',
                    line: 10,
                    createdAt: '2026-08-01T00:00:00Z',
                    url: null,
                    author: { login: 'reviewer1' },
                  })),
                },
              })),
            },
          },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function pullRequestResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ state: 'open', ...body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Seeds `node`'s watched-PR store directly (`ciCheckWatchStore`) without touching git at all — merging needs no worktree, so this suite never resolves a session branch, unlike `registerCiCheckWatch`'s own tests below. */
function seedWatch(node: NodeDaemon, sessionId: string, entry: CiWatchEntry): void {
  internals(node).ciCheckWatchStore.set(sessionId, entry);
}

describe('NodeDaemon.registerCiCheckWatch also registers the review-comment watch (SPEC §7.14; issue #240)', () => {
  it('a session whose PR was just opened is polled by reviewCommentWatcher too, from the exact same registration call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reviewThreadsResponse([]));
    vi.stubGlobal('fetch', fetchImpl);

    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_review_token');
    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    const session = fakeSession();
    const opened: OpenPrResult = {
      url: 'https://github.com/fiorelorenzo/loombox/pull/42',
      number: 42,
    };

    try {
      await internals(node).registerCiCheckWatch(session, new LocalExecutionTarget(), opened);
      await internals(node).reviewCommentWatcher.pollNow();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/graphql');
      const body = JSON.parse(String(init.body)) as {
        variables: { owner: string; repo: string; number: number };
      };
      expect(body.variables).toEqual({ owner: 'fiorelorenzo', repo: 'loombox', number: 42 });
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon review-comment wiring end to end (SPEC §7.14; issue #240)', () => {
  it('a new review comment is detected, its state reaches the client (review_comment_status), and a resolved thread clears it — no real network call', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_review_wiring_token');

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        reviewThreadsResponse([
          {
            id: 'PRRT_1',
            isResolved: false,
            comments: [{ id: 'PRRC_1', body: 'please fix the null check' }],
          },
        ]),
      )
      .mockResolvedValueOnce(
        reviewThreadsResponse([
          {
            id: 'PRRT_1',
            isResolved: false,
            comments: [{ id: 'PRRC_1', body: 'please fix the null check' }],
          },
        ]),
      )
      .mockResolvedValueOnce(
        reviewThreadsResponse([
          {
            id: 'PRRT_1',
            isResolved: true,
            comments: [{ id: 'PRRC_1', body: 'please fix the null check' }],
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchImpl);

    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    const session = fakeSession();
    const opened: OpenPrResult = {
      url: 'https://github.com/fiorelorenzo/loombox/pull/42',
      number: 42,
    };

    try {
      await internals(node).registerCiCheckWatch(session, new LocalExecutionTarget(), opened);

      await internals(node).reviewCommentWatcher.pollNow();
      await internals(node).reviewCommentWatcher.pollNow();
      await internals(node).reviewCommentWatcher.pollNow();

      expect(fetchImpl).toHaveBeenCalledTimes(3);

      let reviewMessages: SentMessage[] = [];
      await vi.waitFor(() => {
        reviewMessages = sentMessagesOf(sendSpy).filter(
          (message) => message.type === 'review_comment_status',
        );
        if (reviewMessages.length < 3) {
          throw new Error(
            `only ${reviewMessages.length}/3 review_comment_status sends observed so far`,
          );
        }
      });
      expect(reviewMessages).toHaveLength(3);

      const key = await deriveSessionKey(AMK, ACCOUNT_ID, session.id);
      const states = await Promise.all(
        reviewMessages.map(async (message) => {
          expect(message.sessionId).toBe(session.id);
          const payload = await openJson<ReviewCommentStatusPayloadV1>(
            session.id,
            message.envelope,
            key,
          );
          return payload.status;
        }),
      );

      // Detected once, reaches the client, on both of the first two polls.
      expect(states[0].state).toBe('pending');
      expect(states[0].threads).toHaveLength(1);
      expect(states[0].threads[0]).toMatchObject({
        commentId: 'PRRC_1',
        body: 'please fix the null check',
      });
      expect(states[1].state).toBe('pending');

      // The thread resolves — the third poll's state clears it.
      expect(states[2].state).toBe('clear');
      expect(states[2].threads).toEqual([]);
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon.handlePrMergeRequest (SPEC §7.14; issue #240)', () => {
  async function sendMergeRequest(
    node: NodeDaemon,
    sessionId: string,
    payload: PrMergeRequestPayloadV1,
    requestId = 'req-merge-1',
  ): Promise<void> {
    const key = await deriveSessionKey(AMK, ACCOUNT_ID, sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    internals(node).handleInbound({
      type: 'pr_merge_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  async function waitForMergeResult(
    sendSpy: ReturnType<typeof vi.spyOn>,
    sessionId: string,
  ): Promise<PrMergeOutcome> {
    await vi.waitFor(() => {
      if (!sentMessagesOf(sendSpy).some((message) => message.type === 'pr_merge_result')) {
        throw new Error('pr_merge_result not sent yet');
      }
    });
    const message = sentMessagesOf(sendSpy).find((m) => m.type === 'pr_merge_result');
    expect(message).toBeDefined();
    expect(message?.sessionId).toBe(sessionId);
    const key = await deriveSessionKey(AMK, ACCOUNT_ID, sessionId);
    return openJson<PrMergeResultPayloadV1>(sessionId, (message as SentMessage).envelope, key).then(
      (payload) => payload.result,
    );
  }

  const watchEntry: CiWatchEntry = {
    owner: 'fiorelorenzo',
    repo: 'loombox',
    ref: 'loombox/session-1',
    prNumber: 42,
    prUrl: 'https://github.com/fiorelorenzo/loombox/pull/42',
    projectPath: '/proj',
  };

  it('merges a clean PR and reports the merged outcome to the client', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_merge_token');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pullRequestResponse({ mergeable: true, mergeable_state: 'clean' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ merged: true, sha: 'merged-sha' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchImpl);

    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    const session = fakeSession();
    internals(node).sessionManager.sessions.set(session.id, session);
    seedWatch(node, session.id, watchEntry);
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    try {
      await sendMergeRequest(node, session.id, { method: 'squash' });
      const outcome = await waitForMergeResult(sendSpy, session.id);
      expect(outcome).toEqual({ outcome: 'merged', sha: 'merged-sha' });
      const [, mergeInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(String(mergeInit.body))).toEqual({ merge_method: 'squash' });
    } finally {
      node.close();
    }
  });

  it('reports a conflict outcome honestly, distinct from blocked', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_merge_token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(pullRequestResponse({ mergeable: false, mergeable_state: 'dirty' })),
    );

    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    const session = fakeSession();
    internals(node).sessionManager.sessions.set(session.id, session);
    seedWatch(node, session.id, watchEntry);
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    try {
      await sendMergeRequest(node, session.id, { method: 'merge' });
      const outcome = await waitForMergeResult(sendSpy, session.id);
      expect(outcome).toEqual({ outcome: 'conflict' });
    } finally {
      node.close();
    }
  });

  it('reports a blocked outcome honestly, distinct from conflict', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_merge_token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          pullRequestResponse({ mergeable: true, mergeable_state: 'blocked' }),
        ),
    );

    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    const session = fakeSession();
    internals(node).sessionManager.sessions.set(session.id, session);
    seedWatch(node, session.id, watchEntry);
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    try {
      await sendMergeRequest(node, session.id, { method: 'rebase' });
      const outcome = await waitForMergeResult(sendSpy, session.id);
      expect(outcome).toEqual({ outcome: 'blocked', reason: 'requirements_not_met' });
    } finally {
      node.close();
    }
  });

  it('reports failed/no_pr for a session with no watched PR at all — never attempts a fetch', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_merge_token');
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    const session = fakeSession();
    internals(node).sessionManager.sessions.set(session.id, session);
    // Deliberately never seeded a watch entry.
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    try {
      await sendMergeRequest(node, session.id, { method: 'squash' });
      const outcome = await waitForMergeResult(sendSpy, session.id);
      expect(outcome).toEqual({ outcome: 'failed', category: 'no_pr' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      node.close();
    }
  });

  it('reports failed/no_credential when no GitHub credential resolves — never attempts a fetch', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const node = bareDaemon();
    // Deliberately never seeded any connected account.
    const session = fakeSession();
    internals(node).sessionManager.sessions.set(session.id, session);
    seedWatch(node, session.id, watchEntry);
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    try {
      await sendMergeRequest(node, session.id, { method: 'squash' });
      const outcome = await waitForMergeResult(sendSpy, session.id);
      expect(outcome).toEqual({ outcome: 'failed', category: 'no_credential' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      node.close();
    }
  });

  it('ignores a pr_merge_request for a session this node does not own — no response sent at all', async () => {
    const node = bareDaemon();
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    try {
      // resolveSessionRouting's guard returns synchronously (no live
      // bridge, no sessionManager entry) — by the time this await
      // resolves, handlePrMergeRequest has already returned, so no
      // polling wait is needed to observe "nothing was sent".
      await sendMergeRequest(node, 'sess-unowned', { method: 'squash' });
      expect(sentMessagesOf(sendSpy).some((message) => message.type === 'pr_merge_result')).toBe(
        false,
      );
    } finally {
      node.close();
    }
  });
});
