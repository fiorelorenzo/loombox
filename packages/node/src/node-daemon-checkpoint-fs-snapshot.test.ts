import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

type CryptoKey = webcrypto.CryptoKey;

/**
 * Wire-level proof for issue #267's own acceptance bar: a non-git project
 * (no `.git` anywhere — never `git init`ed by this file's own setup) gets
 * checkpointed and restored over the SAME `checkpoint_create`/`_list`/
 * `_restore_preview`/`_restore` wire messages and the SAME `NodeDaemon`
 * handlers `node-daemon-checkpoint.test.ts`'s git-worktree tests exercise
 * — proving `NodeDaemon.getCheckpointStore`'s routing decision (git vs.
 * `FsSnapshotCheckpointStore`) is invisible above the engine boundary, per
 * that method's own doc comment. Harness duplicated from
 * `node-daemon-checkpoint.test.ts` (this package's own established
 * per-file convention, stated in that file's own doc comment) rather than
 * shared, so this file stays self-contained.
 *
 * Only a `workInPlace` session can be non-git at all — `SessionManager`
 * only requires a git repo when isolating into a fresh worktree
 * (`assertIsGitRepo`, `./session-manager.ts`) — so every session here is
 * created with `worktree: false`.
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
  // Deliberately NOT git-inited — a plain folder, per SPEC §6 ("does not
  // have to be a git repository"). The whole point of this file.
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-fs-checkpoint-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-fs-checkpoint-state-'));
  await writeFile(path.join(projectPath, 'README.md'), '# a plain, non-git project\n');
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

/** Boots a node + phone over a real relay and returns a `workInPlace` session ready for checkpoint wire calls, against the non-git `projectPath` from `beforeEach`. */
async function bootstrapSession(
  accountId: string,
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

  // worktree: false → workInPlace: true — the only session shape that can
  // be non-git at all (this file's own doc comment).
  const session = await node.createSession({ projectPath, provider: 'test-echo', worktree: false });
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

describe('checkpoint_create/_list over a non-git project (issue #267)', () => {
  it(
    'checkpoints a plain folder with no git init anywhere, and the checkpoint is listable',
    { retry: 0, timeout: 20000 },
    async () => {
      expect(existsSync(path.join(projectPath, '.git'))).toBe(false);
      const { sessionId, key, worktreePath } = await bootstrapSession('acct-fs-checkpoint-create');
      expect(worktreePath).toBe(projectPath); // workInPlace: worktreePath IS projectPath

      const createEnvelope = await phoneSeal(sessionId, { message: 'before refactor' }, key);
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
      const createPayload = await phoneOpen<CheckpointResultPayloadV1>(
        sessionId,
        createResult.envelope,
        key,
      );
      expect(createPayload.outcome).toBe('ok');
      if (createPayload.outcome !== 'ok') throw new Error('unreachable');
      expect(createPayload.checkpoint.message).toBe('before refactor');
      // workInPlace: true — no isolated worktree, matching `Session.branch === ''`.
      expect(createPayload.checkpoint.isWorkInPlace).toBe(true);

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

describe('checkpoint_restore on a non-git project — the SAME restore path git checkpoints use (issue #267)', () => {
  it(
    'previews (uncommitted, unconfirmed refuses), then confirms — an agent-written file is gone afterward and a deleted one comes back',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await bootstrapSession('acct-fs-checkpoint-restore');

      const preexisting = path.join(worktreePath, 'README.md');
      expect(existsSync(preexisting)).toBe(true);

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

      // An agent "did something destructive": wrote a new file and deleted
      // the pre-existing one — exactly the non-git scenario issue #267
      // exists to make recoverable.
      const writtenFile = path.join(worktreePath, 'agent-wrote-this.txt');
      await writeFile(writtenFile, 'content the agent produced\n');
      await rm(preexisting, { force: true });
      expect(existsSync(writtenFile)).toBe(true);
      expect(existsSync(preexisting)).toBe(false);

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
        preview: { hasUncommittedChangesToDiscard: true, isWorkInPlace: true },
      });

      // An unconfirmed restore refuses and does NOT touch the worktree —
      // same confirmation gate `performCheckpointRestore` enforces for a
      // git checkpoint.
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
      expect(existsSync(preexisting)).toBe(false);

      // Confirmed restore actually runs.
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
      expect(existsSync(writtenFile)).toBe(false); // the agent's new file is gone
      expect(existsSync(preexisting)).toBe(true); // the deleted file came back
    },
  );
});

describe('automatic checkpoint before each turn works for a non-git project too (SPEC §7.20; issue #267)', () => {
  it(
    "promptSession's turn start takes a checkpoint before the prompt reaches the agent, listable over checkpoint_list",
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key } = await bootstrapSession('acct-fs-checkpoint-auto');

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
    },
  );
});
