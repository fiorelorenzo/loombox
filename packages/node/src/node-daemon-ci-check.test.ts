import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_V1,
  connectedAccountSecretRef,
  type CiCheckStateV1,
  type CiCheckStatusPayloadV1,
  type ConnectedAccount,
  type EncryptedEnvelope,
} from '@loombox/protocol';
import { deriveSessionKey, openJson } from '@loombox/crypto';

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
import type { Session } from './session-manager';
import type { ExecutionTarget } from './target';

/**
 * `NodeDaemon`'s own composition of `CiCheckWatcher` (SPEC §7.14; issue
 * #239) — `resolveCiCheckGithubToken`, `sendCiCheckStatus`,
 * `handleCiCheckFailure`, and `registerCiCheckWatch`. None of these are
 * touched by `ci-check-watcher.test.ts` (which proves `CiCheckWatcher`
 * itself, fully decoupled behind an injected `resolveToken`/`fetchImpl`);
 * this file proves the daemon-side wiring around it: the real
 * `accountPinStore`/`githubConnectService` credential composition, the
 * real encrypted `ci_check_status` push, and the real `promptSession`
 * hook — using a bare, never-connected `NodeDaemon`
 * (`amk-epoch.test.ts`'s own "`new NodeDaemon(...)` doesn't dial the
 * relay itself" convention), a real file-fallback keyring, and a stubbed
 * `global.fetch`. No real GitHub or relay network call, ever.
 */

const AMK = new Uint8Array(32);
const ACCOUNT_ID = 'acct-ci-check';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-ci-check-daemon-'));
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

/** Writes directly into the same shared (file-fallback) keyring a `GithubConnectService({stateDir})` reads from — the local equivalent of a prior `connect()` device-flow run (mirrors `tracker-backend-composition.test.ts`'s identical real-keyring seeding). */
async function seedToken(secretRef: string, token: string): Promise<void> {
  const keyring = createConnectedAccountKeyring({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
  });
  await keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, token);
}

interface DaemonOverrides {
  accountPinStore?: AccountPinStore;
  ciCheckWatchStore?: CiWatchStore;
}

function bareDaemon(overrides: DaemonOverrides = {}): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-ci-check',
    deviceId: 'device-ci-check',
    devicePublicKey: 'YWJjZA==',
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk: AMK,
    stateDir,
    accountPinStore: overrides.accountPinStore ?? new AccountPinStore({ stateDir }),
    githubConnectService: new GithubConnectService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
    }),
    ciCheckWatchStore: overrides.ciCheckWatchStore ?? new CiWatchStore({ stateDir }),
  });
}

/** Seeds `node`'s `connectedAccounts` through the real `connected_account_list` inbound path — the same one a relay round trip drives (see `NodeDaemon.handleConnectedAccountList`'s own doc comment) — rather than poking the private field directly. */
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
    nodeId: 'node-ci-check',
    targetId: 'local',
    spendCapUsd: undefined,
    ...overrides,
  };
}

/** This suite's only seam into the daemon's private CI-check methods/fields — TS `private` is compile-time only, and there is no public surface for any of these (by design: none of them are a wire message handler). */
interface DaemonInternals {
  handleInbound(message: unknown): void;
  resolveCiCheckGithubToken(projectPath: string): Promise<string | undefined>;
  registerCiCheckWatch(
    session: Session,
    target: ExecutionTarget,
    opened: OpenPrResult,
  ): Promise<void>;
  ciCheckWatcher: { pollNow(): Promise<void> };
  relay: { send(message: unknown): void };
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

function checkRunsResponse(
  runs: Array<{
    id?: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
  }>,
): Response {
  return new Response(
    JSON.stringify({
      total_count: runs.length,
      check_runs: runs.map((run, i) => ({ id: run.id ?? i + 1, ...run })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('NodeDaemon.resolveCiCheckGithubToken (SPEC §7.14, §7.26; issue #239)', () => {
  it('resolves undefined with no connected accounts at all — never attempts a fetch', async () => {
    const node = bareDaemon();
    try {
      await expect(internals(node).resolveCiCheckGithubToken('/proj')).resolves.toBeUndefined();
    } finally {
      node.close();
    }
  });

  it('resolves the real keyring-stored token for an unambiguous single candidate with no pin', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_unit_token');
    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    try {
      await expect(internals(node).resolveCiCheckGithubToken('/proj')).resolves.toBe(
        'ghp_unit_token',
      );
    } finally {
      node.close();
    }
  });

  it('resolves undefined for an explicit opt-out pin, even with an unambiguous candidate present', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_unit_token');
    const accountPinStore = new AccountPinStore({ stateDir });
    accountPinStore.setPin('/proj', 'github', null);
    const node = bareDaemon({ accountPinStore });
    seedConnectedAccounts(node, [account]);
    try {
      await expect(internals(node).resolveCiCheckGithubToken('/proj')).resolves.toBeUndefined();
    } finally {
      node.close();
    }
  });

  it('resolves undefined (never throws) for two github.com candidates and no pin', async () => {
    const a = githubAccount();
    const b = githubAccount({
      id: 'github:github.com:2222',
      providerAccountId: '2222',
      secretRef: connectedAccountSecretRef('github:github.com:2222'),
    });
    await seedToken(a.secretRef, 'ghp_a');
    await seedToken(b.secretRef, 'ghp_b');
    const node = bareDaemon();
    seedConnectedAccounts(node, [a, b]);
    try {
      await expect(internals(node).resolveCiCheckGithubToken('/proj')).resolves.toBeUndefined();
    } finally {
      node.close();
    }
  });

  it('resolves the pinned account’s own token when two candidates exist', async () => {
    const a = githubAccount();
    const b = githubAccount({
      id: 'github:github.com:2222',
      providerAccountId: '2222',
      secretRef: connectedAccountSecretRef('github:github.com:2222'),
    });
    await seedToken(a.secretRef, 'ghp_a');
    await seedToken(b.secretRef, 'ghp_b');
    const accountPinStore = new AccountPinStore({ stateDir });
    accountPinStore.setPin('/proj', 'github', b.id);
    const node = bareDaemon({ accountPinStore });
    seedConnectedAccounts(node, [a, b]);
    try {
      await expect(internals(node).resolveCiCheckGithubToken('/proj')).resolves.toBe('ghp_b');
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon.registerCiCheckWatch (SPEC §7.14; issue #239)', () => {
  it('records a CiWatchEntry parsed from the PR URL, keyed by session id', async () => {
    const ciCheckWatchStore = new CiWatchStore({ stateDir });
    const node = bareDaemon({ ciCheckWatchStore });
    const session = fakeSession();
    const opened: OpenPrResult = {
      url: 'https://github.com/fiorelorenzo/loombox/pull/42',
      number: 42,
    };
    try {
      await internals(node).registerCiCheckWatch(session, new LocalExecutionTarget(), opened);
      expect(ciCheckWatchStore.get(session.id)).toEqual({
        owner: 'fiorelorenzo',
        repo: 'loombox',
        ref: 'loombox/session-1',
        prNumber: 42,
        prUrl: opened.url,
        projectPath: session.projectPath,
      });
    } finally {
      node.close();
    }
  });

  it('registers nothing for a non-github.com PR URL — out of this watcher’s scope', async () => {
    const ciCheckWatchStore = new CiWatchStore({ stateDir });
    const node = bareDaemon({ ciCheckWatchStore });
    const session = fakeSession();
    const opened: OpenPrResult = {
      url: 'https://gitlab.example.com/fiorelorenzo/loombox/-/merge_requests/1',
      number: 1,
    };
    try {
      await internals(node).registerCiCheckWatch(session, new LocalExecutionTarget(), opened);
      expect(ciCheckWatchStore.get(session.id)).toBeUndefined();
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon CI check wiring end to end (SPEC §7.14; issue #239)', () => {
  it('a failing check is detected, its state reaches the client (ci_check_status), and the auto-iterate hook fires exactly once per failure, not once per poll — no real network call', async () => {
    const account = githubAccount();
    await seedToken(account.secretRef, 'ghp_wiring_token');

    // A fresh Response per call (see ci-check-watcher.test.ts's own note
    // on why `mockResolvedValue` would be wrong here): three genuinely
    // successful, genuinely 'failing' polls, not one real read plus two
    // swallowed "body already used" errors.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          checkRunsResponse([
            { name: 'unit-tests', head_sha: 'sha-a', status: 'completed', conclusion: 'failure' },
          ]),
        ),
      );
    vi.stubGlobal('fetch', fetchImpl);

    // `CiCheckWatcher`'s default `fetchImpl` is read from the global once,
    // at construction time — the stub above must be in place before this.
    const node = bareDaemon();
    seedConnectedAccounts(node, [account]);
    const promptSpy = vi.spyOn(node, 'promptSession').mockResolvedValue();
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    const session = fakeSession();
    const opened: OpenPrResult = {
      url: 'https://github.com/fiorelorenzo/loombox/pull/42',
      number: 42,
    };

    try {
      await internals(node).registerCiCheckWatch(session, new LocalExecutionTarget(), opened);

      await internals(node).ciCheckWatcher.pollNow();
      await internals(node).ciCheckWatcher.pollNow();
      await internals(node).ciCheckWatcher.pollNow();

      // No real network call, ever — only the stubbed global fetch, once
      // per poll, carrying the resolved token.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const [, firstInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect((firstInit.headers as Record<string, string>).authorization).toBe(
        'Bearer ghp_wiring_token',
      );

      // Its state reaches the client: a ci_check_status envelope the relay
      // never opens, decrypting to the same 'failing' state on every poll.
      // `onUpdate`'s own `sendCiCheckStatus(...).catch(...)` wiring is
      // fire-and-forget (never awaited by `CiCheckWatcher.pollOne`), so
      // `pollNow()` resolving is no guarantee the encrypt-and-send chain
      // it kicked off has settled yet — wait for it explicitly instead of
      // asserting on a snapshot that can still be one send short.
      let ciCheckMessages: Array<{ type: string; sessionId: string; envelope: EncryptedEnvelope }> =
        [];
      await vi.waitFor(() => {
        ciCheckMessages = sendSpy.mock.calls
          .map(
            ([message]) =>
              message as { type: string; sessionId: string; envelope: EncryptedEnvelope },
          )
          .filter((message) => message.type === 'ci_check_status');
        if (ciCheckMessages.length < 3) {
          throw new Error(`only ${ciCheckMessages.length}/3 ci_check_status sends observed so far`);
        }
      });
      expect(ciCheckMessages).toHaveLength(3);
      const key = await deriveSessionKey(AMK, ACCOUNT_ID, session.id);
      for (const message of ciCheckMessages) {
        expect(message.sessionId).toBe(session.id);
        const payload = await openJson<CiCheckStatusPayloadV1>(session.id, message.envelope, key);
        expect(payload.status.state).toBe('failing' satisfies CiCheckStateV1['state']);
        expect(payload.status.checkRuns[0].conclusion).toBe('failure');
      }

      // The auto-iterate hook fires exactly once, despite three polls of
      // the same still-failing commit. `onFailure`'s own
      // `handleCiCheckFailure(...).catch(...)` wiring is fire-and-forget
      // too, so wait for it rather than racing it the same way.
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('promptSession not called yet');
      });
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy).toHaveBeenCalledWith(session.id, expect.stringContaining('unit-tests'));
    } finally {
      node.close();
    }
  });
});
