import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type CheckpointListResultPayloadV1,
  type CheckpointResultPayloadV1,
  type CheckpointRestorePreviewResultPayloadV1,
  type CheckpointRestoreResultPayloadV1,
  type EncryptedEnvelope,
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
import {
  openRemoteSessionsSandbox,
  type RemoteSessionsSandbox,
} from './ssh/remote-sessions-test-sandbox';

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * Wire-level proof for issue #603's own acceptance bar: a real relay, a real
 * encrypted session, `checkpoint_create`/`_list`/`_restore_preview`/
 * `_restore` round-tripped over it against a REAL local git worktree (never
 * a mocked `GitCheckpointStore`). Harness duplicated from
 * `node-daemon-permission-policy.test.ts` (this package's own established
 * per-file convention) rather than shared, so this file stays self-contained.
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

/** Asserts a wire envelope's ciphertext bytes contain none of `plainSubstrings` verbatim — the relay-sees-only-ciphertext assertion (mirrors `node-daemon.test.ts`'s own `assertOpaque`). */
function assertOpaque(wire: EncryptedEnvelope, plainSubstrings: string[]): void {
  const raw = Buffer.from(wire.ciphertext, 'base64').toString('latin1');
  for (const needle of plainSubstrings) {
    expect(raw.includes(needle)).toBe(false);
  }
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
      if (Date.now() > deadline)
        throw new Error('TestPhone: timed out waiting for a matching message');
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

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-checkpoint-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-checkpoint-state-'));
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
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

/** Boots a node + phone over a real relay and returns a session ready for checkpoint wire calls — `workInPlace` mirrors `CreateNodeSessionOptions.worktree: false`. */
async function bootstrapSession(
  accountId: string,
  options: { workInPlace?: boolean } = {},
): Promise<{ sessionId: string; key: CryptoKey; worktreePath: string }> {
  const amk = generateAmk();

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: `node-${accountId}`,
    deviceId: `device-node-${accountId}`,
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
  });

  const session = await node.createSession({
    projectPath,
    provider: 'test-echo',
    worktree: options.workInPlace ? false : undefined,
  });
  const key = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: `device-phone-${accountId}`,
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  return { sessionId: session.id, key, worktreePath: session.worktreePath };
}

describe('automatic checkpoint at the defined trigger point — before each turn (SPEC §7.20; issue #603)', () => {
  it(
    "promptSession's turn start takes a checkpoint before the prompt reaches the agent, one per turn, listable over checkpoint_list",
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key } = await bootstrapSession('acct-checkpoint-auto');

      phone!.send({
        type: 'checkpoint_list',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-list-before',
      });
      const before = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_list_result' &&
          (m as { requestId?: string }).requestId === 'req-list-before',
      )) as { envelope: EncryptedEnvelope };
      const beforePayload = await phoneOpen<CheckpointListResultPayloadV1>(
        sessionId,
        before.envelope,
        key,
      );
      expect(beforePayload).toMatchObject({ outcome: 'ok', checkpoints: [] });

      await node!.promptSession(sessionId, 'go do the thing');

      phone!.send({
        type: 'checkpoint_list',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-list-after-1',
      });
      const after1 = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_list_result' &&
          (m as { requestId?: string }).requestId === 'req-list-after-1',
      )) as { envelope: EncryptedEnvelope };
      const after1Payload = await phoneOpen<CheckpointListResultPayloadV1>(
        sessionId,
        after1.envelope,
        key,
      );
      expect(after1Payload.outcome).toBe('ok');
      if (after1Payload.outcome !== 'ok') throw new Error('unreachable');
      expect(after1Payload.checkpoints).toHaveLength(1);
      expect(after1Payload.checkpoints[0]!.message).toBe('auto: before turn 1');

      await node!.promptSession(sessionId, 'go do another thing');

      phone!.send({
        type: 'checkpoint_list',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-list-after-2',
      });
      const after2 = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_list_result' &&
          (m as { requestId?: string }).requestId === 'req-list-after-2',
      )) as { envelope: EncryptedEnvelope };
      const after2Payload = await phoneOpen<CheckpointListResultPayloadV1>(
        sessionId,
        after2.envelope,
        key,
      );
      expect(after2Payload.outcome).toBe('ok');
      if (after2Payload.outcome !== 'ok') throw new Error('unreachable');
      expect(after2Payload.checkpoints.map((c) => c.message)).toEqual([
        'auto: before turn 1',
        'auto: before turn 2',
      ]);
    },
  );
});

describe('checkpoint_create/_list wire round trip, encrypted end to end (issue #603)', () => {
  it(
    'a manual checkpoint_create is listable via checkpoint_list, and the relay never sees the label in the clear',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key } = await bootstrapSession('acct-checkpoint-create');

      const createEnvelope = await phoneSeal(sessionId, { message: 'before refactor' }, key);
      assertOpaque(createEnvelope, ['before refactor']);
      phone!.send({
        type: 'checkpoint_create',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-create-1',
        envelope: createEnvelope,
      });
      const createResult = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_result' &&
          (m as { requestId?: string }).requestId === 'req-create-1',
      )) as { envelope: EncryptedEnvelope };
      assertOpaque(createResult.envelope, ['before refactor']);
      const createPayload = await phoneOpen<CheckpointResultPayloadV1>(
        sessionId,
        createResult.envelope,
        key,
      );
      expect(createPayload.outcome).toBe('ok');
      if (createPayload.outcome !== 'ok') throw new Error('unreachable');
      expect(createPayload.checkpoint.message).toBe('before refactor');
      expect(createPayload.checkpoint.isWorkInPlace).toBe(false);

      phone!.send({
        type: 'checkpoint_list',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-list-1',
      });
      const listResult = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_list_result' &&
          (m as { requestId?: string }).requestId === 'req-list-1',
      )) as { envelope: EncryptedEnvelope };
      const listPayload = await phoneOpen<CheckpointListResultPayloadV1>(
        sessionId,
        listResult.envelope,
        key,
      );
      expect(listPayload.outcome).toBe('ok');
      if (listPayload.outcome !== 'ok') throw new Error('unreachable');
      expect(listPayload.checkpoints.map((c) => c.id)).toEqual([createPayload.checkpoint.id]);
    },
  );
});

describe('checkpoint_restore actually restores the worktree, with an honest confirm gate (issue #603)', () => {
  it(
    'writes a file, previews (uncommitted, unconfirmed refuses), then confirms — the file is gone afterward',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await bootstrapSession('acct-checkpoint-restore');

      const createEnvelope = await phoneSeal(sessionId, {}, key);
      phone!.send({
        type: 'checkpoint_create',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-baseline',
        envelope: createEnvelope,
      });
      const baseline = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_result' &&
          (m as { requestId?: string }).requestId === 'req-baseline',
      )) as { envelope: EncryptedEnvelope };
      const baselinePayload = await phoneOpen<CheckpointResultPayloadV1>(
        sessionId,
        baseline.envelope,
        key,
      );
      expect(baselinePayload.outcome).toBe('ok');
      if (baselinePayload.outcome !== 'ok') throw new Error('unreachable');
      const checkpointId = baselinePayload.checkpoint.id;

      const writtenFile = path.join(worktreePath, 'agent-wrote-this.txt');
      await writeFile(writtenFile, 'content the agent produced\n');
      expect(existsSync(writtenFile)).toBe(true);

      phone!.send({
        type: 'checkpoint_restore_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-preview-1',
        checkpointId,
      });
      const previewResult = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_restore_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-preview-1',
      )) as { envelope: EncryptedEnvelope };
      const previewPayload = await phoneOpen<CheckpointRestorePreviewResultPayloadV1>(
        sessionId,
        previewResult.envelope,
        key,
      );
      expect(previewPayload).toMatchObject({
        outcome: 'ok',
        preview: { hasUncommittedChangesToDiscard: true, isWorkInPlace: false },
      });

      // An unconfirmed restore refuses and does NOT touch the worktree.
      phone!.send({
        type: 'checkpoint_restore',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-restore-unconfirmed',
        checkpointId,
        confirm: false,
      });
      const unconfirmed = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_restore_result' &&
          (m as { requestId?: string }).requestId === 'req-restore-unconfirmed',
      )) as { envelope: EncryptedEnvelope };
      const unconfirmedPayload = await phoneOpen<CheckpointRestoreResultPayloadV1>(
        sessionId,
        unconfirmed.envelope,
        key,
      );
      expect(unconfirmedPayload.outcome).toBe('confirmation_required');
      expect(existsSync(writtenFile)).toBe(true);

      // Confirmed restore actually runs and reports what it discarded.
      phone!.send({
        type: 'checkpoint_restore',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-restore-confirmed',
        checkpointId,
        confirm: true,
      });
      const confirmed = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_restore_result' &&
          (m as { requestId?: string }).requestId === 'req-restore-confirmed',
      )) as { envelope: EncryptedEnvelope };
      const confirmedPayload = await phoneOpen<CheckpointRestoreResultPayloadV1>(
        sessionId,
        confirmed.envelope,
        key,
      );
      expect(confirmedPayload).toMatchObject({
        outcome: 'ok',
        result: { discardedUncommittedChanges: true },
      });
      expect(existsSync(writtenFile)).toBe(false);
    },
  );
});

describe('a workInPlace session with uncommitted "human" edits is handled explicitly, never silently clobbered (issue #603)', () => {
  it(
    'isWorkInPlace is true throughout, and an uncommitted edit in the real project folder still requires confirm before it is discarded',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await bootstrapSession('acct-checkpoint-inplace', {
        workInPlace: true,
      });
      expect(worktreePath).toBe(projectPath);

      const createEnvelope = await phoneSeal(sessionId, {}, key);
      phone!.send({
        type: 'checkpoint_create',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-inplace-baseline',
        envelope: createEnvelope,
      });
      const baseline = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_result' &&
          (m as { requestId?: string }).requestId === 'req-inplace-baseline',
      )) as { envelope: EncryptedEnvelope };
      const baselinePayload = await phoneOpen<CheckpointResultPayloadV1>(
        sessionId,
        baseline.envelope,
        key,
      );
      expect(baselinePayload.outcome).toBe('ok');
      if (baselinePayload.outcome !== 'ok') throw new Error('unreachable');
      expect(baselinePayload.checkpoint.isWorkInPlace).toBe(true);
      const checkpointId = baselinePayload.checkpoint.id;

      // A "human" edit made directly in the real project folder — this is
      // exactly what a workInPlace session's worktree IS.
      const humanEditedFile = path.join(worktreePath, 'human-was-editing-this.txt');
      await writeFile(humanEditedFile, "the user's own in-progress edit\n");

      phone!.send({
        type: 'checkpoint_restore_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-inplace-preview',
        checkpointId,
      });
      const previewResult = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_restore_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-inplace-preview',
      )) as { envelope: EncryptedEnvelope };
      const previewPayload = await phoneOpen<CheckpointRestorePreviewResultPayloadV1>(
        sessionId,
        previewResult.envelope,
        key,
      );
      expect(previewPayload).toMatchObject({
        outcome: 'ok',
        preview: { hasUncommittedChangesToDiscard: true, isWorkInPlace: true },
      });

      // Not silently clobbered: an unconfirmed restore leaves the human's
      // edit untouched.
      phone!.send({
        type: 'checkpoint_restore',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-inplace-restore-unconfirmed',
        checkpointId,
        confirm: false,
      });
      const unconfirmed = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_restore_result' &&
          (m as { requestId?: string }).requestId === 'req-inplace-restore-unconfirmed',
      )) as { envelope: EncryptedEnvelope };
      const unconfirmedPayload = await phoneOpen<CheckpointRestoreResultPayloadV1>(
        sessionId,
        unconfirmed.envelope,
        key,
      );
      expect(unconfirmedPayload.outcome).toBe('confirmation_required');
      expect(existsSync(humanEditedFile)).toBe(true);

      // Handled explicitly, not refused outright either: an EXPLICIT
      // confirm still restores the user's own real project folder.
      phone!.send({
        type: 'checkpoint_restore',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-inplace-restore-confirmed',
        checkpointId,
        confirm: true,
      });
      const confirmed = (await phone!.waitFor(
        (m) =>
          m.type === 'checkpoint_restore_result' &&
          (m as { requestId?: string }).requestId === 'req-inplace-restore-confirmed',
      )) as { envelope: EncryptedEnvelope };
      const confirmedPayload = await phoneOpen<CheckpointRestoreResultPayloadV1>(
        sessionId,
        confirmed.envelope,
        key,
      );
      expect(confirmedPayload).toMatchObject({
        outcome: 'ok',
        result: { discardedUncommittedChanges: true },
      });
      expect(existsSync(humanEditedFile)).toBe(false);
    },
  );
});

describe('an ssh: target session refuses checkpoint operations explicitly, with a reason (issue #603)', () => {
  let remoteSessions: RemoteSessionsSandbox | undefined;
  let remoteWorkspace: string;

  const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box', providers: [] };
  const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

  beforeEach(async () => {
    remoteWorkspace = await mkdtemp(path.join(tmpdir(), 'loombox-checkpoint-ssh-'));
    remoteSessions = openRemoteSessionsSandbox();
  });

  afterEach(async () => {
    await remoteSessions?.close();
    remoteSessions = undefined;
    await rm(remoteWorkspace, { recursive: true, force: true });
  });

  it(
    'checkpoint_create/_list/_restore_preview all answer outcome: error, errorType: unsupported_target — never silently, never against the wrong local path',
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-checkpoint-ssh';

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-checkpoint-ssh',
        deviceId: 'device-node-checkpoint-ssh',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        targets: [SSH_TARGET],
        sshTargets: [SSH_TARGET_CONFIG],
        sshTransportFactory: () => remoteSessions!.createTransport(),
        remoteChildPollIntervalMs: 30,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });

      const session = await node.createSession({
        projectPath: remoteWorkspace,
        provider: 'test-echo',
        targetId: 'devbox',
      });
      expect(session.target).toBe('ssh');

      const key = await derivePhoneSessionKey(amk, accountId, session.id);
      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-checkpoint-ssh',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');

      phone.send({
        type: 'checkpoint_list',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-ssh-list',
      });
      const listResult = (await phone.waitFor(
        (m) =>
          m.type === 'checkpoint_list_result' &&
          (m as { requestId?: string }).requestId === 'req-ssh-list',
      )) as { envelope: EncryptedEnvelope };
      const listPayload = await phoneOpen<CheckpointListResultPayloadV1>(
        session.id,
        listResult.envelope,
        key,
      );
      expect(listPayload).toMatchObject({ outcome: 'error', errorType: 'unsupported_target' });

      const createEnvelope = await phoneSeal(session.id, {}, key);
      phone.send({
        type: 'checkpoint_create',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-ssh-create',
        envelope: createEnvelope,
      });
      const createResult = (await phone.waitFor(
        (m) =>
          m.type === 'checkpoint_result' &&
          (m as { requestId?: string }).requestId === 'req-ssh-create',
      )) as { envelope: EncryptedEnvelope };
      const createPayload = await phoneOpen<CheckpointResultPayloadV1>(
        session.id,
        createResult.envelope,
        key,
      );
      expect(createPayload).toMatchObject({ outcome: 'error', errorType: 'unsupported_target' });

      phone.send({
        type: 'checkpoint_restore_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-ssh-preview',
        checkpointId: 'cp_whatever',
      });
      const previewResult = (await phone.waitFor(
        (m) =>
          m.type === 'checkpoint_restore_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-ssh-preview',
      )) as { envelope: EncryptedEnvelope };
      const previewPayload = await phoneOpen<CheckpointRestorePreviewResultPayloadV1>(
        session.id,
        previewResult.envelope,
        key,
      );
      expect(previewPayload).toMatchObject({ outcome: 'error', errorType: 'unsupported_target' });
    },
  );
});
