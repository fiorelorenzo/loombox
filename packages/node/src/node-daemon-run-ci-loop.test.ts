import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CiCheckStateV1,
  type EncryptedEnvelope,
  type RunStatusPayloadV1,
} from '@loombox/protocol';
import { deriveSessionKey, openJson } from '@loombox/crypto';

import { AccountPinStore } from './account-pin-store';
import { GithubConnectService } from './github-connect';
import { NodeDaemon } from './node-daemon';
import type { Session } from './session-manager';
import { SpendCapStore } from './spend-cap-store';
import { TestRunnerConfigStore } from './test-runner-config-store';

/**
 * Issue #247: a local runner result joins the SAME PR/CI loop
 * (`CiAutoIterateController`, issue #246) and the SAME attention inbox
 * shape (`AttentionInboxItem`, issue #243) a remote CI result already
 * does. This file proves the node-side half: a failing local run pushes
 * a durable `run_status` (the wire sibling of `ci_check_status`), a
 * passing one clears it, and — the real risk this issue calls out — a CI
 * failure and a local runner failure that are really the SAME underlying
 * commit never drive `promptSession`/`ciAutoIterateController` twice.
 * The client-side "same shape" `AttentionInboxItem` proof lives in
 * `apps/web/src/lib/relay-client.test.ts`'s own `run_failure` suite.
 *
 * Same harness convention as `node-daemon-ci-auto-iterate.test.ts`: a
 * bare, never-connected `NodeDaemon`, a real (local, tiny) git repo so
 * `resolveWorkspaceHeadSha` has real state to read, and real `sh -c`
 * subprocesses (`exit 0`/`exit 1`) standing in for a test command — no
 * real GitHub or relay network call, ever. `handleCiCheckFailure` is
 * invoked directly (this suite's own seam, mirroring
 * `registerCiCheckWatch`'s identical direct-call convention in the
 * sibling file) rather than through a stubbed `fetch`/`CiCheckWatcher`
 * poll, since issue #239's own poll/dedup machinery is already proven
 * elsewhere and is not what this file is about.
 *
 * Every wait below is a deterministic signal (a specific wire message
 * observed, a spied method's own returned promise settling, or — for the
 * "gated, so a synchronous early return" paths — nothing to wait for at
 * all) rather than a fixed sleep; see each test's own comment for which.
 */

const AMK = new Uint8Array(32);
const ACCOUNT_ID = 'acct-run-ci-loop';

let stateDir: string;
let projectPath: string;

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-run-ci-loop-daemon-'));
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-run-ci-loop-project-'));
  await git(projectPath, ['init', '-b', 'main']);
  await git(projectPath, ['config', 'user.email', 'test@loombox.dev']);
  await git(projectPath, ['config', 'user.name', 'loombox test']);
  await git(projectPath, ['commit', '--allow-empty', '-m', 'initial commit']);
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function bareDaemon(): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-run-ci-loop',
    deviceId: 'device-run-ci-loop',
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
    spendCapStore: new SpendCapStore({ stateDir }),
    testRunnerConfigStore: new TestRunnerConfigStore({ stateDir }),
  });
}

type RunRouting = { session: Session; targetId: string };

/** This suite's only seam into the daemon's private runner/CI-loop machinery — TS `private` is compile-time only, mirroring `node-daemon-ci-auto-iterate.test.ts`'s identical `DaemonInternals` convention. */
interface DaemonInternals {
  handleCiCheckFailure(sessionId: string, state: CiCheckStateV1): Promise<void>;
  executeRun(
    routing: RunRouting,
    runId: string,
    kind: 'test' | 'lint' | 'build',
    command: string,
  ): Promise<void>;
  driveAutoIterateFromRunFailure(
    routing: RunRouting,
    kind: 'test' | 'lint' | 'build',
    result: { outcome: string; exitCode: number | null; reason?: string; cancelled?: boolean },
  ): Promise<void>;
  relay: { send(message: unknown): void };
  sessionManager: {
    createSession(options: {
      projectPath: string;
      provider: string;
      workInPlace?: boolean;
    }): Promise<Session>;
  };
  testRunnerConfigStore: { save(projectPath: string, commands: { test?: string }): void };
  ciAutoIterateController: { getState(sessionId: string): { attempts: number; active: boolean } };
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

async function decryptEnvelopePayload<T>(
  sessionId: string,
  envelope: EncryptedEnvelope,
): Promise<T> {
  const key = await deriveSessionKey(AMK, ACCOUNT_ID, sessionId);
  return openJson<T>(sessionId, envelope, key);
}

function sentMessagesOfType(
  sendSpy: { mock: { calls: unknown[][] } },
  type: string,
): Array<{ sessionId: string; envelope: EncryptedEnvelope }> {
  return sendSpy.mock.calls
    .map(([message]) => message as { type: string; sessionId: string; envelope: EncryptedEnvelope })
    .filter((message) => message.type === type);
}

async function waitForMessageCount(
  sendSpy: { mock: { calls: unknown[][] } },
  type: string,
  count: number,
): Promise<Array<{ sessionId: string; envelope: EncryptedEnvelope }>> {
  let messages: Array<{ sessionId: string; envelope: EncryptedEnvelope }> = [];
  await vi.waitFor(() => {
    messages = sentMessagesOfType(sendSpy, type);
    if (messages.length < count) {
      throw new Error(`only ${messages.length}/${count} ${type} sends observed so far`);
    }
  });
  return messages;
}

function ciFailure(headSha: string, updatedAt: number): CiCheckStateV1 {
  return {
    state: 'failing',
    headSha,
    prUrl: 'https://github.com/fiorelorenzo/loombox/pull/247',
    prNumber: 247,
    checkRuns: [{ id: 1, name: 'unit-tests', status: 'completed', conclusion: 'failure' }],
    updatedAt,
  };
}

describe('NodeDaemon: local runner joins the PR/CI loop and the attention inbox (SPEC §7.14/§7.15; issue #247)', () => {
  it('a failing local run pushes a run_status carrying the same failing/entry shape as ci_check_status, and drives the auto-iterate loop', async () => {
    const node = bareDaemon();
    const sendSpy = vi.spyOn(internals(node).relay, 'send');
    const promptSpy = vi.spyOn(node, 'promptSession').mockResolvedValue();

    const session = await internals(node).sessionManager.createSession({
      projectPath,
      provider: 'test-provider',
      workInPlace: true,
    });
    internals(node).testRunnerConfigStore.save(projectPath, { test: 'exit 1' });

    try {
      await internals(node).executeRun({ session, targetId: 'local' }, 'run-1', 'test', 'exit 1');

      const statusMessages = await waitForMessageCount(sendSpy, 'run_status', 1);
      const status = (
        await decryptEnvelopePayload<RunStatusPayloadV1>(session.id, statusMessages[0]!.envelope)
      ).status;
      expect(status.state).toBe('failing');
      expect(status.entries).toEqual([
        {
          kind: 'test',
          outcome: 'fail',
          runId: 'run-1',
          reason: undefined,
          updatedAt: expect.any(Number),
        },
      ]);

      // The runner's own auto-iterate hook fired too, exactly like a CI
      // failure's `handleCiCheckFailure` would.
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('promptSession not called yet');
      });
      expect(promptSpy).toHaveBeenCalledWith(session.id, expect.stringContaining('test'));
      expect(internals(node).ciAutoIterateController.getState(session.id).attempts).toBe(1);
    } finally {
      node.close();
    }
  });

  it('a passing local run clears the failing status, back to passing', async () => {
    const node = bareDaemon();
    const sendSpy = vi.spyOn(internals(node).relay, 'send');
    vi.spyOn(node, 'promptSession').mockResolvedValue();

    const session = await internals(node).sessionManager.createSession({
      projectPath,
      provider: 'test-provider',
      workInPlace: true,
    });
    internals(node).testRunnerConfigStore.save(projectPath, { test: 'exit 1' });

    try {
      await internals(node).executeRun({ session, targetId: 'local' }, 'run-1', 'test', 'exit 1');
      await waitForMessageCount(sendSpy, 'run_status', 1);

      await internals(node).executeRun({ session, targetId: 'local' }, 'run-2', 'test', 'exit 0');
      const statusMessages = await waitForMessageCount(sendSpy, 'run_status', 2);
      const status = (
        await decryptEnvelopePayload<RunStatusPayloadV1>(session.id, statusMessages[1]!.envelope)
      ).status;

      expect(status.state).toBe('passing');
      expect(status.entries).toEqual([
        {
          kind: 'test',
          outcome: 'pass',
          runId: 'run-2',
          reason: undefined,
          updatedAt: expect.any(Number),
        },
      ]);
    } finally {
      node.close();
    }
  });

  it('a CI failure and a local runner failure for the SAME underlying commit drive the auto-iterate loop only once', async () => {
    const node = bareDaemon();
    vi.spyOn(internals(node).relay, 'send');
    const promptSpy = vi.spyOn(node, 'promptSession').mockResolvedValue();
    // Spied (not mocked) so it still calls through — its own returned
    // promise is the deterministic "the runner's own drive decision has
    // fully resolved" signal (`getExecutionTarget`/`resolveWorkspaceHeadSha`
    // are real async work `run_status` alone does not wait on).
    const driveSpy = vi.spyOn(internals(node), 'driveAutoIterateFromRunFailure');

    const session = await internals(node).sessionManager.createSession({
      projectPath,
      provider: 'test-provider',
      workInPlace: true,
    });
    internals(node).testRunnerConfigStore.save(projectPath, { test: 'exit 1' });
    const headSha = await git(projectPath, ['rev-parse', 'HEAD']);

    try {
      // The CI check watcher observes this commit failing first.
      await internals(node).handleCiCheckFailure(session.id, ciFailure(headSha, 1000));
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('CI-driven prompt not sent yet');
      });
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(internals(node).ciAutoIterateController.getState(session.id).attempts).toBe(1);

      // The local runner independently observes the exact same commit's
      // own test command failing — must NOT drive a second agent turn
      // for what is really the same failing change.
      await internals(node).executeRun({ session, targetId: 'local' }, 'run-1', 'test', 'exit 1');
      await vi.waitFor(() => {
        if (driveSpy.mock.calls.length < 1) throw new Error('runner drive decision not made yet');
      });
      await driveSpy.mock.results[0]!.value;

      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(internals(node).ciAutoIterateController.getState(session.id).attempts).toBe(1);
    } finally {
      node.close();
    }
  });

  it('is order-independent: a local runner failure observed first also blocks a same-commit CI failure from driving a second turn', async () => {
    const node = bareDaemon();
    const sendSpy = vi.spyOn(internals(node).relay, 'send');
    const promptSpy = vi.spyOn(node, 'promptSession').mockResolvedValue();

    const session = await internals(node).sessionManager.createSession({
      projectPath,
      provider: 'test-provider',
      workInPlace: true,
    });
    internals(node).testRunnerConfigStore.save(projectPath, { test: 'exit 1' });
    const headSha = await git(projectPath, ['rev-parse', 'HEAD']);

    try {
      await internals(node).executeRun({ session, targetId: 'local' }, 'run-1', 'test', 'exit 1');
      await waitForMessageCount(sendSpy, 'run_status', 1);
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('runner-driven prompt not sent yet');
      });
      expect(promptSpy).toHaveBeenCalledTimes(1);

      // `handleCiCheckFailure`'s own gate check is the very first,
      // synchronous statement in its body (returns before any `await`
      // when blocked) — awaiting the call itself is already the
      // deterministic signal that the (refused) decision has been made.
      await internals(node).handleCiCheckFailure(session.id, ciFailure(headSha, 2000));

      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(internals(node).ciAutoIterateController.getState(session.id).attempts).toBe(1);
    } finally {
      node.close();
    }
  });

  it('a genuinely NEW commit still drives its own attempt — the gate only suppresses a repeat of the SAME commit', async () => {
    const node = bareDaemon();
    const sendSpy = vi.spyOn(internals(node).relay, 'send');
    const promptSpy = vi.spyOn(node, 'promptSession').mockResolvedValue();

    const session = await internals(node).sessionManager.createSession({
      projectPath,
      provider: 'test-provider',
      workInPlace: true,
    });
    internals(node).testRunnerConfigStore.save(projectPath, { test: 'exit 1' });
    const firstSha = await git(projectPath, ['rev-parse', 'HEAD']);

    try {
      await internals(node).handleCiCheckFailure(session.id, ciFailure(firstSha, 1000));
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 1) throw new Error('first prompt not sent yet');
      });

      await git(projectPath, ['commit', '--allow-empty', '-m', 'a fix attempt']);

      await internals(node).executeRun({ session, targetId: 'local' }, 'run-1', 'test', 'exit 1');
      await waitForMessageCount(sendSpy, 'run_status', 1);
      await vi.waitFor(() => {
        if (promptSpy.mock.calls.length < 2) throw new Error('second prompt not sent yet');
      });

      expect(promptSpy).toHaveBeenCalledTimes(2);
      expect(internals(node).ciAutoIterateController.getState(session.id).attempts).toBe(2);
    } finally {
      node.close();
    }
  });

  it('a could_not_start run (invalid run id) is still tracked for the inbox but never drives the loop', async () => {
    const node = bareDaemon();
    const sendSpy = vi.spyOn(internals(node).relay, 'send');
    const promptSpy = vi.spyOn(node, 'promptSession').mockResolvedValue();

    const session = await internals(node).sessionManager.createSession({
      projectPath,
      provider: 'test-provider',
      workInPlace: true,
    });
    internals(node).testRunnerConfigStore.save(projectPath, { test: 'exit 1' });

    try {
      // The unsafe-run-id guard clause is a synchronous early return
      // right after its own `sendRunExit` await — by the time this call
      // resolves, the "never drive" decision has already been made; no
      // further wait is needed to assert the negative.
      await internals(node).executeRun(
        { session, targetId: 'local' },
        'not a safe run id!',
        'test',
        'exit 1',
      );

      const statusMessages = await waitForMessageCount(sendSpy, 'run_status', 1);
      const status = (
        await decryptEnvelopePayload<RunStatusPayloadV1>(session.id, statusMessages[0]!.envelope)
      ).status;
      expect(status.state).toBe('failing');
      expect(status.entries[0]?.outcome).toBe('could_not_start');
      expect(promptSpy).not.toHaveBeenCalled();
    } finally {
      node.close();
    }
  });
});
