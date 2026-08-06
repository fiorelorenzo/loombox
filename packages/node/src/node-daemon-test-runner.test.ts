import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type PermissionPolicyViolationPayloadV1,
  type RunCancel,
  type RunExit,
  type RunOutput,
  type RunStart,
  type RunStarted,
  type TestRunnerKindV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';
import { PermissionPolicyStore } from './permission-policy-store';
import type { PermissionPolicy } from './permission-policy';
import { TestRunnerConfigStore, type TestRunnerCommands } from './test-runner-config-store';
import {
  openRemoteSessionsSandbox,
  type RemoteSessionsSandbox,
} from './ssh/remote-sessions-test-sandbox';

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * The full wire-level proof for SPEC §7.15/issue #244's streaming runner
 * surface: `run_start`/`run_started`/`run_output`/`run_exit`/`run_cancel`
 * against a REAL relay and a REAL spawned process (local `sh`/`sleep`, or a
 * real local process standing in for an `ssh:` target via
 * `RemoteProcessRunner` — same hermetic pattern `node-daemon-ssh.test.ts`
 * uses). `test-runner-process.test.ts` already covers the lower-level
 * spawn/stream/cancel mechanics exhaustively (both targets); this file's
 * job is the plumbing above that — routing, encryption, target/policy
 * resolution, and the `TestRunnerConfigStore` lookup — that only exists
 * once wired through `NodeDaemon` itself.
 */

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
    spawnConfig: ({ cwd }) => ({
      command: process.execPath,
      args: [
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          '..',
          '..',
          'providers',
          'core',
          'test',
          'fixtures',
          'echo-acp-agent.mjs',
        ),
      ],
      cwd,
    }),
    enrich: (update) => update,
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function derivePhoneSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

async function phoneSeal(
  sessionId: string,
  value: unknown,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const envelope = await encryptEnvelope(sessionId, plaintext, key);
  return {
    resourceId: envelope.resourceId,
    iv: toBase64(envelope.iv),
    ciphertext: toBase64(envelope.ciphertext),
    alg: 'AES-256-GCM',
  };
}

async function phoneOpen<T>(
  sessionId: string,
  wire: EncryptedEnvelope,
  key: CryptoKey,
): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

class TestPhone {
  readonly messages: WireMessageV1[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, opts: { deviceId: string; devicePublicKey: string; authToken: string }) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({
            type: 'initialize',
            protocolVersion: PROTOCOL_V1,
            role: 'client',
            authToken: opts.authToken,
            deviceId: opts.deviceId,
            devicePublicKey: opts.devicePublicKey,
          }),
        );
      });
      this.socket.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data)) as { type?: string };
        if (!settled && parsed.type === 'initialize_result') {
          settled = true;
          resolve();
          return;
        }
        this.messages.push(parsed as WireMessageV1);
      });
      this.socket.addEventListener('error', () => {
        if (!settled) reject(new Error(`TestPhone: cannot reach ${url}`));
      });
    });
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 10000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error('TestPhone: timed out waiting for a matching message');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }
}

/** True while a process with `pid` still exists (`kill -0`'s own semantics) — the tree-kill assertion's one real check. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let remoteSessions: RemoteSessionsSandbox | undefined;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-test-runner-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-test-runner-state-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@loombox.dev'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'loombox test'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: projectPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'loombox test',
      GIT_AUTHOR_EMAIL: 'test@loombox.dev',
      GIT_COMMITTER_NAME: 'loombox test',
      GIT_COMMITTER_EMAIL: 'test@loombox.dev',
    },
  });
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  await remoteSessions?.close();
  remoteSessions = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box', providers: [] };
const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

/** Boots a real node + relay + client, configures `commands`/`policy` for `projectPath`, resumes the session, sends `run_start` for `kind`, and returns everything a test needs to follow the run (its own `runId`, the session decryption `key`, and the already-observed `run_started` reply). */
async function startRunOverTheWire(options: {
  kind: TestRunnerKindV1;
  commands?: TestRunnerCommands;
  policy?: PermissionPolicy;
  targetId?: 'local' | 'devbox';
}): Promise<{ sessionId: string; key: CryptoKey; runId: string; started: RunStarted }> {
  const testRunnerConfigStore = new TestRunnerConfigStore({ stateDir: nodeStateDir });
  const permissionPolicyStore = new PermissionPolicyStore({ stateDir: nodeStateDir });
  const amk = generateAmk();
  const accountId = 'acct-test-runner';
  const targetId = options.targetId ?? 'local';

  if (targetId === 'devbox') {
    remoteSessions = openRemoteSessionsSandbox();
  }

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-test-runner',
    deviceId: 'device-node-test-runner',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    testRunnerConfigStore,
    permissionPolicyStore,
    ...(targetId === 'devbox'
      ? {
          targets: [SSH_TARGET],
          sshTargets: [SSH_TARGET_CONFIG],
          sshTransportFactory: () => remoteSessions!.createTransport(),
        }
      : {}),
  });

  const session = await node.createSession({
    projectPath,
    provider: 'test-echo',
    targetId,
  });
  if (options.commands) testRunnerConfigStore.save(projectPath, options.commands);
  if (options.policy) permissionPolicyStore.save(projectPath, options.policy);
  const key = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-test-runner',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  const runId = 'run-1';
  const startEnvelope = await phoneSeal(session.id, { kind: options.kind }, key);
  phone.send({
    type: 'run_start',
    protocolVersion: PROTOCOL_V1,
    sessionId: session.id,
    targetId,
    runId,
    requestId: 'req-run-1',
    envelope: startEnvelope,
  } satisfies RunStart);

  const startedMessage = (await phone.waitFor(
    (m) => m.type === 'run_started' && (m as RunStarted).requestId === 'req-run-1',
  )) as RunStarted;

  return { sessionId: session.id, key, runId, started: startedMessage };
}

/** Decrypts every `run_output` seen so far for `sessionId`/`runId`, concatenates their `data` in arrival order, and polls until the result contains `substring` or times out. */
async function waitForRunOutputContains(
  sessionId: string,
  runId: string,
  key: CryptoKey,
  substring: string,
  timeoutMs = 10000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidates = phone!.messages.filter(
      (m): m is RunOutput =>
        m.type === 'run_output' && m.sessionId === sessionId && m.runId === runId,
    );
    const chunks = await Promise.all(
      candidates.map((m) => phoneOpen<{ data: string }>(sessionId, m.envelope, key)),
    );
    const text = chunks
      .map((c) => fromBase64(c.data))
      .reduce((acc, bytes) => acc + Buffer.from(bytes).toString('utf8'), '');
    if (text.includes(substring)) return text;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForRunOutputContains: timed out waiting for "${substring}" (saw: ${JSON.stringify(text)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForRunExit(
  sessionId: string,
  runId: string,
  key: CryptoKey,
): Promise<{ outcome: string; exitCode: number | null; reason?: string; cancelled?: boolean }> {
  const message = (await phone!.waitFor(
    (m) =>
      m.type === 'run_exit' &&
      (m as RunExit).sessionId === sessionId &&
      (m as RunExit).runId === runId,
  )) as RunExit;
  return phoneOpen(sessionId, message.envelope, key);
}

describe('NodeDaemon test/lint/build runner (SPEC §7.15; issue #244)', () => {
  it(
    'runs a configured local command, streams its output live, and reports outcome: pass with the real exit code',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, runId, started } = await startRunOverTheWire({
        kind: 'test',
        commands: { test: 'echo hello-run-1; echo hello-run-2' },
      });
      expect(await phoneOpen(sessionId, started.envelope, key)).toEqual({ outcome: 'ok' });

      const output = await waitForRunOutputContains(sessionId, runId, key, 'hello-run-2');
      expect(output).toBe('hello-run-1\nhello-run-2\n');

      const exit = await waitForRunExit(sessionId, runId, key);
      expect(exit).toEqual({ outcome: 'pass', exitCode: 0 });
    },
  );

  it(
    'reports outcome: fail with the real non-zero exit code for a configured command that fails',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, runId } = await startRunOverTheWire({
        kind: 'lint',
        commands: { lint: 'exit 2' },
      });
      const exit = await waitForRunExit(sessionId, runId, key);
      expect(exit).toEqual({ outcome: 'fail', exitCode: 2 });
    },
  );

  it(
    'reports outcome: could_not_start with exitCode 127 for a configured command that does not exist',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, runId } = await startRunOverTheWire({
        kind: 'build',
        commands: { build: 'this-command-does-not-exist-anywhere' },
      });
      const exit = await waitForRunExit(sessionId, runId, key);
      expect(exit.outcome).toBe('could_not_start');
      expect(exit.exitCode).toBe(127);
    },
  );

  it(
    'run_started replies outcome: error, with no tracking, when nothing is configured for the requested kind',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, started } = await startRunOverTheWire({ kind: 'test' }); // no commands saved
      const payload = await phoneOpen<{ outcome: string; message?: string }>(
        sessionId,
        started.envelope,
        key,
      );
      expect(payload.outcome).toBe('error');
      expect(payload.message).toMatch(/no test command configured/);
    },
  );

  it(
    'a command matching a permission-policy deny rule never spawns — run_exit reports could_not_start with a policy reason, real exit code null',
    { retry: 0, timeout: 20000 },
    async () => {
      const marker = path.join(projectPath, 'marker');
      const { sessionId, key, runId } = await startRunOverTheWire({
        kind: 'test',
        commands: { test: `touch ${marker}` },
        policy: { command: { allow: [], deny: ['touch *'] }, network: { allow: [], deny: [] } },
      });

      const exit = await waitForRunExit(sessionId, runId, key);
      expect(exit.outcome).toBe('could_not_start');
      expect(exit.exitCode).toBeNull();
      expect(exit.reason).toMatch(/policy denied/);

      // The same denial also reaches the client as a structured
      // permission_policy_violation (D3-4 attribution, issue #751) —
      // never only the free-text run_exit.reason above.
      const violationMessage = (await phone!.waitFor(
        (m) => m.type === 'permission_policy_violation',
      )) as { envelope: EncryptedEnvelope };
      const violation = await phoneOpen<PermissionPolicyViolationPayloadV1>(
        sessionId,
        violationMessage.envelope,
        key,
      );
      expect(violation.reason).toEqual({
        kind: 'permission_policy',
        dimension: 'command',
        rule: 'touch *',
        matched: `touch ${marker}`,
      });
      expect(violation.surface).toBe('exec');

      // The command never actually ran.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(readFile(marker)).rejects.toThrow();
    },
  );

  it(
    'run_cancel kills the whole local process tree, including a forked grandchild, and run_exit reports cancelled: true',
    { retry: 0, timeout: 20000 },
    async () => {
      const pidFile = path.join(projectPath, 'child-pid');
      const { sessionId, key, runId } = await startRunOverTheWire({
        kind: 'test',
        commands: { test: `sleep 30 & echo $! > ${pidFile}; wait` },
      });

      let childPid = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          childPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
          if (childPid > 0) break;
        } catch {
          // pidFile not written yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(childPid).toBeGreaterThan(0);
      expect(processAlive(childPid)).toBe(true);

      phone!.send({
        type: 'run_cancel',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        runId,
      } satisfies RunCancel);

      const exit = await waitForRunExit(sessionId, runId, key);
      expect(exit.cancelled).toBe(true);
      expect(processAlive(childPid)).toBe(false);
    },
  );

  it(
    'closing the node cancels a still-running local run instead of leaking the process',
    { retry: 0, timeout: 20000 },
    async () => {
      const pidFile = path.join(projectPath, 'child-pid-close');
      await startRunOverTheWire({
        kind: 'test',
        commands: { test: `sleep 30 & echo $! > ${pidFile}; wait` },
      });

      let childPid = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          childPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
          if (childPid > 0) break;
        } catch {
          // pidFile not written yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(childPid).toBeGreaterThan(0);
      expect(processAlive(childPid)).toBe(true);

      node!.close();
      node = undefined;

      const closeDeadline = Date.now() + 2000;
      while (processAlive(childPid) && Date.now() < closeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(processAlive(childPid)).toBe(false);
    },
  );

  it(
    'runs a configured command on an ssh: target through the pooled transport, streaming output and reporting outcome: pass',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, runId, started } = await startRunOverTheWire({
        kind: 'test',
        commands: { test: 'echo hello-ssh-run' },
        targetId: 'devbox',
      });
      expect(await phoneOpen(sessionId, started.envelope, key)).toEqual({ outcome: 'ok' });

      await waitForRunOutputContains(sessionId, runId, key, 'hello-ssh-run');
      const exit = await waitForRunExit(sessionId, runId, key);
      expect(exit).toEqual({ outcome: 'pass', exitCode: 0 });
    },
  );

  it('ignores a run_start/run_cancel for an unknown session instead of throwing', async () => {
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-test-runner-unknown',
      deviceId: 'device-node-test-runner-unknown',
      devicePublicKey: randomBase64(),
      authToken: 'acct-test-runner-unknown',
      accountId: 'acct-test-runner-unknown',
      amk: generateAmk(),
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-test-runner-unknown',
      devicePublicKey: randomBase64(),
      authToken: 'acct-test-runner-unknown',
    });
    await phone.ready;

    const envelope = await phoneSeal(
      'sess-nonexistent',
      { kind: 'test' },
      await derivePhoneSessionKey(generateAmk(), 'acct-test-runner-unknown', 'sess-nonexistent'),
    );
    phone.send({
      type: 'run_start',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess-nonexistent',
      targetId: 'local',
      runId: 'run-orphan',
      requestId: 'req-orphan',
      envelope,
    } satisfies RunStart);
    phone.send({
      type: 'run_cancel',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess-nonexistent',
      runId: 'run-orphan',
    } satisfies RunCancel);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(phone.messages.filter((m) => m.type === 'run_started').length).toBe(0);
  });
});
