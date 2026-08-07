import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_V1,
  connectedAccountSecretRef,
  type CiAutoIterateStatusPayloadV1,
  type ConnectedAccount,
  type EncryptedEnvelope,
} from '@loombox/protocol';
import { deriveSessionKey, openJson } from '@loombox/crypto';

import { AccountPinStore } from './account-pin-store';
import { CiAutoIterateController } from './ci-auto-iterate';
import { CiWatchStore } from './ci-watch-store';
import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import { LocalExecutionTarget } from './local-execution-target';
import { NodeDaemon } from './node-daemon';
import type { OpenPrResult } from './pr-open';
import type { Session } from './session-manager';
import { SpendCapStore } from './spend-cap-store';

/**
 * The daemon-side loop issue #246 asks for, built on top of #239's watcher
 * wiring (proven separately by `node-daemon-ci-check.test.ts`, left
 * untouched by this file): a failing check drives an agent turn, a
 * subsequent green check ends the loop, the attempt cap ends the loop, a
 * user stop ends it immediately, and a paused or spend-capped session is
 * never auto-iterated in the first place. Same harness convention as
 * `node-daemon-ci-check.test.ts` — a bare, never-connected `NodeDaemon`, a
 * real file-fallback keyring, and a stubbed `global.fetch`. No real GitHub
 * or relay network call, ever.
 */

const AMK = new Uint8Array(32);
const ACCOUNT_ID = 'acct-ci-auto-iterate';

let stateDir: string;
let projectPath: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-ci-auto-iterate-daemon-'));
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-ci-auto-iterate-project-'));
  // A real (if minimal) git repo: `registerCiCheckWatch`'s own
  // `resolveSessionBranch` needs a real branch to watch, and only a
  // worktree-isolated session (the only kind that can open a PR at all)
  // has one.
  const execFileAsync = promisify(execFile);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@loombox.dev'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'loombox test'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: projectPath,
  });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base: ConnectedAccount = {
    id: 'github:github.com:2222',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '2222',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo'],
    capabilities: ['repo'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef('github:github.com:2222'),
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

interface DaemonOverrides {
  ciAutoIterateController?: CiAutoIterateController;
  spendCapStore?: SpendCapStore;
}

function bareDaemon(overrides: DaemonOverrides = {}): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-ci-auto-iterate',
    deviceId: 'device-ci-auto-iterate',
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
    ciCheckWatchStore: new CiWatchStore({ stateDir }),
    spendCapStore: overrides.spendCapStore ?? new SpendCapStore({ stateDir }),
    ciAutoIterateController: overrides.ciAutoIterateController,
  });
}

function seedConnectedAccounts(node: NodeDaemon, accounts: readonly ConnectedAccount[]): void {
  internals(node).handleInbound({
    type: 'connected_account_list',
    protocolVersion: PROTOCOL_V1,
    accounts,
  });
}

/** This suite's only seam into the daemon's private CI-auto-iterate machinery/fields — TS `private` is compile-time only, and none of these are wire handlers with a public surface (mirrors `node-daemon-ci-check.test.ts`'s identical `DaemonInternals` convention). */
interface DaemonInternals {
  handleInbound(message: unknown): void;
  registerCiCheckWatch(
    session: Session,
    target: LocalExecutionTarget,
    opened: OpenPrResult,
  ): Promise<void>;
  ciCheckWatcher: { pollNow(): Promise<void> };
  relay: { send(message: unknown): void };
  sessionManager: {
    createSession(options: {
      projectPath: string;
      provider: string;
      workInPlace?: boolean;
    }): Promise<Session>;
    pauseSession(id: string): Session;
    setSpendCapUsd(id: string, capUsd: number | undefined): Session;
  };
  bridges: Map<string, { spendCumulativeCostUsd?: number }>;
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

function checkRunsResponse(runs: Array<{ head_sha: string; conclusion: string | null }>): Response {
  return new Response(
    JSON.stringify({
      total_count: runs.length,
      check_runs: runs.map((run, i) => ({
        id: i + 1,
        name: 'unit-tests',
        status: 'completed',
        ...run,
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A fresh `Response` per call, one per queued `headSha`/`conclusion` pair, consumed in order across successive `pollNow()` calls — mirrors `ci-check-watcher.test.ts`'s own note on why `mockResolvedValue` (a single reused `Response`, whose body can only be read once) would be wrong here. */
function queuedFetch(
  polls: Array<{ headSha: string; conclusion: string | null }>,
): ReturnType<typeof vi.fn> {
  const queue = [...polls];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift();
    if (!next) throw new Error('queuedFetch: no more queued polls');
    return Promise.resolve(
      checkRunsResponse([{ head_sha: next.headSha, conclusion: next.conclusion }]),
    );
  });
}

async function waitForAutoIterateMessages(
  sendSpy: { mock: { calls: unknown[][] } },
  count: number,
): Promise<Array<{ sessionId: string; envelope: EncryptedEnvelope }>> {
  let messages: Array<{ sessionId: string; envelope: EncryptedEnvelope }> = [];
  await vi.waitFor(() => {
    messages = sendSpy.mock.calls
      .map(
        ([message]) => message as { type: string; sessionId: string; envelope: EncryptedEnvelope },
      )
      .filter((message) => message.type === 'ci_auto_iterate_status');
    if (messages.length < count) {
      throw new Error(
        `only ${messages.length}/${count} ci_auto_iterate_status sends observed so far`,
      );
    }
  });
  return messages;
}

async function decryptState(message: {
  sessionId: string;
  envelope: EncryptedEnvelope;
}): Promise<CiAutoIterateStatusPayloadV1['state']> {
  const key = await deriveSessionKey(AMK, ACCOUNT_ID, message.sessionId);
  const payload = await openJson<CiAutoIterateStatusPayloadV1>(
    message.sessionId,
    message.envelope,
    key,
  );
  return payload.state;
}

/** Sets up a daemon with a seeded GitHub credential, a real `SessionManager` session (worktree-isolated, running), and a watched PR — the shared starting point for every scenario below. */
async function setUp(overrides: DaemonOverrides = {}) {
  const account = githubAccount();
  await seedToken(account.secretRef, 'ghp_auto_iterate_token');

  const node = bareDaemon(overrides);
  seedConnectedAccounts(node, [account]);
  const promptSpy = vi.spyOn(node, 'promptSession').mockResolvedValue();
  const sendSpy = vi.spyOn(internals(node).relay, 'send');

  const session = await internals(node).sessionManager.createSession({
    projectPath,
    provider: 'test-provider',
  });

  const opened: OpenPrResult = {
    url: 'https://github.com/fiorelorenzo/loombox/pull/246',
    number: 246,
  };
  await internals(node).registerCiCheckWatch(session, new LocalExecutionTarget(), opened);

  return { node, session, promptSpy, sendSpy };
}

describe('NodeDaemon auto-iterate-until-green loop (SPEC §7.14/§7.15; issue #246)', () => {
  it('a failing check drives an agent turn, and a subsequent green check ends the loop', async () => {
    vi.stubGlobal(
      'fetch',
      queuedFetch([
        { headSha: 'sha-a', conclusion: 'failure' },
        { headSha: 'sha-a', conclusion: 'success' },
      ]),
    );
    const { node, session, promptSpy, sendSpy } = await setUp();

    try {
      await internals(node).ciCheckWatcher.pollNow();
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('promptSession not called yet');
      });
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy).toHaveBeenCalledWith(session.id, expect.stringContaining('unit-tests'));

      const afterFailure = await waitForAutoIterateMessages(sendSpy, 1);
      const failureState = await decryptState(afterFailure[0]);
      expect(failureState).toEqual({
        active: true,
        attempts: 1,
        maxAttempts: 5,
        stoppedReason: undefined,
        history: [{ attempt: 1, headSha: 'sha-a', promptedAt: expect.any(Number) }],
      });

      await internals(node).ciCheckWatcher.pollNow();
      const afterGreen = await waitForAutoIterateMessages(sendSpy, 2);
      const greenState = await decryptState(afterGreen[1]);
      expect(greenState).toEqual({
        active: false,
        attempts: 0,
        maxAttempts: 5,
        stoppedReason: 'green',
        history: [],
      });

      // The green check itself never drives a second agent turn.
      expect(promptSpy).toHaveBeenCalledTimes(1);
    } finally {
      node.close();
    }
  });

  it('the attempt cap ends the loop', async () => {
    vi.stubGlobal(
      'fetch',
      queuedFetch([
        { headSha: 'sha-a', conclusion: 'failure' },
        { headSha: 'sha-b', conclusion: 'failure' },
        { headSha: 'sha-c', conclusion: 'failure' },
      ]),
    );
    const { node, promptSpy, sendSpy } = await setUp({
      ciAutoIterateController: new CiAutoIterateController({ maxAttempts: 2 }),
    });

    try {
      await internals(node).ciCheckWatcher.pollNow();
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('attempt 1 not sent yet');
      });
      await internals(node).ciCheckWatcher.pollNow();
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 2) throw new Error('attempt 2 not sent yet');
      });
      // Third distinct failing commit: the cap is already spent, so this
      // must NOT drive a third agent turn.
      await internals(node).ciCheckWatcher.pollNow();

      const messages = await waitForAutoIterateMessages(sendSpy, 3);
      const finalState = await decryptState(messages[2]);
      expect(finalState).toEqual({
        active: false,
        attempts: 2,
        maxAttempts: 2,
        stoppedReason: 'max_attempts',
        history: [
          { attempt: 1, headSha: 'sha-a', promptedAt: expect.any(Number) },
          { attempt: 2, headSha: 'sha-b', promptedAt: expect.any(Number) },
        ],
      });
      expect(promptSpy).toHaveBeenCalledTimes(2);
    } finally {
      node.close();
    }
  });

  it('a user stop ends it immediately, even while CI is still red', async () => {
    vi.stubGlobal(
      'fetch',
      queuedFetch([
        { headSha: 'sha-a', conclusion: 'failure' },
        { headSha: 'sha-b', conclusion: 'failure' },
      ]),
    );
    const { node, session, promptSpy, sendSpy } = await setUp();

    try {
      await internals(node).ciCheckWatcher.pollNow();
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('attempt 1 not sent yet');
      });
      expect(promptSpy).toHaveBeenCalledTimes(1);

      // The real inbound wire path, not a direct controller call — proves
      // the `ci_auto_iterate_stop` switch case actually reaches the loop.
      internals(node).handleInbound({
        type: 'ci_auto_iterate_stop',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
      });

      const afterStop = await waitForAutoIterateMessages(sendSpy, 2);
      const stoppedState = await decryptState(afterStop[1]);
      expect(stoppedState.active).toBe(false);
      expect(stoppedState.stoppedReason).toBe('user_stop');

      // A brand-new failing commit arrives right after — must NOT resume.
      await internals(node).ciCheckWatcher.pollNow();
      const afterSecondFailure = await waitForAutoIterateMessages(sendSpy, 3);
      const finalState = await decryptState(afterSecondFailure[2]);
      expect(finalState.stoppedReason).toBe('user_stop');
      expect(promptSpy).toHaveBeenCalledTimes(1);
    } finally {
      node.close();
    }
  });

  it('a paused session is never auto-iterated', async () => {
    vi.stubGlobal('fetch', queuedFetch([{ headSha: 'sha-a', conclusion: 'failure' }]));
    const { node, session, promptSpy, sendSpy } = await setUp();

    try {
      internals(node).sessionManager.pauseSession(session.id);

      await internals(node).ciCheckWatcher.pollNow();
      const messages = await waitForAutoIterateMessages(sendSpy, 1);
      const state = await decryptState(messages[0]);
      expect(state.active).toBe(false);
      expect(state.stoppedReason).toBe('ineligible');
      expect(state.attempts).toBe(0);

      expect(promptSpy).not.toHaveBeenCalled();
    } finally {
      node.close();
    }
  });

  it('a spend-capped session is never auto-iterated', async () => {
    vi.stubGlobal('fetch', queuedFetch([{ headSha: 'sha-a', conclusion: 'failure' }]));
    const { node, session, promptSpy, sendSpy } = await setUp();

    try {
      internals(node).sessionManager.setSpendCapUsd(session.id, 5);
      internals(node).bridges.set(session.id, { spendCumulativeCostUsd: 12 });

      await internals(node).ciCheckWatcher.pollNow();
      const messages = await waitForAutoIterateMessages(sendSpy, 1);
      const state = await decryptState(messages[0]);
      expect(state.active).toBe(false);
      expect(state.stoppedReason).toBe('ineligible');
      expect(state.attempts).toBe(0);

      expect(promptSpy).not.toHaveBeenCalled();
    } finally {
      // The fake bridge above has no real `agentSession` — `close()`
      // would otherwise crash trying to stop a non-existent one.
      internals(node).bridges.delete(session.id);
      node.close();
    }
  });
});
