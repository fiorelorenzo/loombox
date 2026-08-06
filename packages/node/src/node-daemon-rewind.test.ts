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
  type EncryptedEnvelope,
  type SessionRewindPreviewResultPayloadV1,
  type SessionRewindResultPayloadV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor, TranscriptStore } from '@loombox/supervisor';
import { decryptEnvelope, deriveKeyTree, generateAmk, importAesGcmKey } from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';
import {
  openRemoteSessionsSandbox,
  type RemoteSessionsSandbox,
} from './ssh/remote-sessions-test-sandbox';

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * Wire-level proof for issue #747's own acceptance bar: a real relay, a
 * real encrypted session, two real turns against a real local git
 * worktree, `session_rewind_preview`/`session_rewind` round-tripped over
 * it, proving the worktree AND the transcript roll back TOGETHER. Harness
 * duplicated from `node-daemon-checkpoint.test.ts` (this package's own
 * established per-file convention, that file's own doc comment), not
 * shared, so this file stays self-contained.
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

/** Asserts a wire envelope's ciphertext bytes contain none of `plainSubstrings` verbatim — the relay-sees-only-ciphertext assertion (mirrors `node-daemon-checkpoint.test.ts`'s own `assertOpaque`). */
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
let supervisorStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-rewind-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-rewind-state-'));
  supervisorStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-rewind-supervisor-'));
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
  await rm(supervisorStateDir, { recursive: true, force: true });
  await relay.close();
});

/** Boots a node + phone over a real relay, with the `AgentSupervisor`'s own transcript persistence pointed at `supervisorStateDir` (rather than that class's real-homedir default) so a test can independently verify what actually landed on disk via a fresh `TranscriptStore` — `workInPlace` mirrors `CreateNodeSessionOptions.worktree: false`. */
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
    supervisor: new AgentSupervisor({
      providers: [echoProvider()],
      stateDir: supervisorStateDir,
    }),
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

/** The single session's persisted transcript, read straight off disk via a fresh `TranscriptStore` (never the live `AgentSession`) — the most direct possible proof that a rewind's truncation actually landed, not just that the wire reported it did. */
function readPersistedTranscriptUpdates() {
  const store = new TranscriptStore({ stateDir: supervisorStateDir });
  const [acpSessionId] = store.listSessionIds();
  expect(acpSessionId).toBeDefined();
  return store.readTranscriptUpdates(acpSessionId!);
}

describe('session_rewind_preview/session_rewind roll back the worktree and the transcript together (design spec C6-3; issue #747)', () => {
  it(
    'rewinding to turn 1 restores the worktree to its state at turn 1 and truncates the transcript to match, discarding a file turn 2 wrote',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await bootstrapSession('acct-rewind-core');

      await node!.promptSession(sessionId, 'turn 1');
      await node!.promptSession(sessionId, 'turn 2');

      // Turn 2's own effect: a file the agent produced during it.
      const writtenFile = path.join(worktreePath, 'written-during-turn-2.txt');
      await writeFile(writtenFile, 'content the agent produced in turn 2\n');
      expect(existsSync(writtenFile)).toBe(true);

      const transcriptBeforeRewind = readPersistedTranscriptUpdates();
      const turnIdsBeforeRewind = transcriptBeforeRewind
        .map((u) => ('turnId' in u ? u.turnId : undefined))
        .filter((turnId): turnId is string => turnId !== undefined);
      expect(new Set(turnIdsBeforeRewind)).toEqual(new Set(['turn:1', 'turn:2']));

      // Preview names both what will be lost: the file, and the turn.
      phone!.send({
        type: 'session_rewind_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-preview-1',
        turn: 1,
      });
      const previewMsg = (await phone!.waitFor(
        (m) =>
          m.type === 'session_rewind_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-preview-1',
      )) as { envelope: EncryptedEnvelope };
      assertOpaque(previewMsg.envelope, ['written-during-turn-2.txt']);
      const previewPayload = await phoneOpen<SessionRewindPreviewResultPayloadV1>(
        sessionId,
        previewMsg.envelope,
        key,
      );
      expect(previewPayload).toMatchObject({
        outcome: 'ok',
        preview: { turn: 1, turnsAtRisk: 1, isWorkInPlace: false },
      });
      if (previewPayload.outcome !== 'ok') throw new Error('unreachable');
      expect(previewPayload.preview.filesAtRisk).toContainEqual({
        path: 'written-during-turn-2.txt',
        action: 'delete',
      });

      // An unconfirmed rewind refuses and touches neither the worktree nor the transcript.
      phone!.send({
        type: 'session_rewind',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-rewind-unconfirmed',
        turn: 1,
        confirm: false,
      });
      const unconfirmedMsg = (await phone!.waitFor(
        (m) =>
          m.type === 'session_rewind_result' &&
          (m as { requestId?: string }).requestId === 'req-rewind-unconfirmed',
      )) as { envelope: EncryptedEnvelope };
      const unconfirmedPayload = await phoneOpen<SessionRewindResultPayloadV1>(
        sessionId,
        unconfirmedMsg.envelope,
        key,
      );
      expect(unconfirmedPayload.outcome).toBe('confirmation_required');
      expect(existsSync(writtenFile)).toBe(true);
      expect(readPersistedTranscriptUpdates()).toHaveLength(transcriptBeforeRewind.length);

      // A confirmed rewind restores the worktree AND truncates the
      // transcript, as one operation.
      phone!.send({
        type: 'session_rewind',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-rewind-confirmed',
        turn: 1,
        confirm: true,
      });
      const confirmedMsg = (await phone!.waitFor(
        (m) =>
          m.type === 'session_rewind_result' &&
          (m as { requestId?: string }).requestId === 'req-rewind-confirmed',
      )) as { envelope: EncryptedEnvelope };
      const confirmedPayload = await phoneOpen<SessionRewindResultPayloadV1>(
        sessionId,
        confirmedMsg.envelope,
        key,
      );
      expect(confirmedPayload).toMatchObject({
        outcome: 'ok',
        result: { turn: 1, turnsDiscarded: 1 },
      });

      // The worktree: turn 2's file is gone.
      expect(existsSync(writtenFile)).toBe(false);

      // The transcript: truncated to turn 1 only, both live and on disk.
      const transcriptAfterRewind = readPersistedTranscriptUpdates();
      expect(transcriptAfterRewind.length).toBeGreaterThan(0);
      expect(transcriptAfterRewind.every((u) => !('turnId' in u) || u.turnId === 'turn:1')).toBe(
        true,
      );
      expect(transcriptAfterRewind.length).toBeLessThan(transcriptBeforeRewind.length);

      // Re-previewing a rewind to turn 1 now finds nothing left to
      // discard — the session's own transcript agrees there is no turn 2
      // anymore, independent corroboration of the truncation above.
      phone!.send({
        type: 'session_rewind_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-preview-2',
        turn: 1,
      });
      const previewAfter = (await phone!.waitFor(
        (m) =>
          m.type === 'session_rewind_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-preview-2',
      )) as { envelope: EncryptedEnvelope };
      const previewAfterPayload = await phoneOpen<SessionRewindPreviewResultPayloadV1>(
        sessionId,
        previewAfter.envelope,
        key,
      );
      expect(previewAfterPayload).toMatchObject({ outcome: 'error', errorType: 'turn_not_found' });
    },
  );

  it(
    'rewinding to turn 0 restores the pristine worktree and empties the transcript entirely',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await bootstrapSession('acct-rewind-zero');

      await node!.promptSession(sessionId, 'only turn');
      const writtenFile = path.join(worktreePath, 'only-turn.txt');
      await writeFile(writtenFile, 'content\n');

      phone!.send({
        type: 'session_rewind',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-rewind-zero',
        turn: 0,
        confirm: true,
      });
      const msg = (await phone!.waitFor(
        (m) =>
          m.type === 'session_rewind_result' &&
          (m as { requestId?: string }).requestId === 'req-rewind-zero',
      )) as { envelope: EncryptedEnvelope };
      const payload = await phoneOpen<SessionRewindResultPayloadV1>(sessionId, msg.envelope, key);
      expect(payload).toMatchObject({ outcome: 'ok', result: { turn: 0, turnsDiscarded: 1 } });

      expect(existsSync(writtenFile)).toBe(false);
      expect(readPersistedTranscriptUpdates()).toEqual([]);
    },
  );
});

describe('a workInPlace session is warned about more loudly than an isolated one (issue #747)', () => {
  it(
    'isWorkInPlace is true throughout the preview and the confirmation_required outcome',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await bootstrapSession('acct-rewind-inplace', {
        workInPlace: true,
      });
      expect(worktreePath).toBe(projectPath);

      await node!.promptSession(sessionId, 'turn 1');
      await node!.promptSession(sessionId, 'turn 2');
      await writeFile(path.join(worktreePath, 'human-was-editing-this.txt'), "the user's edit\n");

      phone!.send({
        type: 'session_rewind_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-inplace-preview',
        turn: 1,
      });
      const previewMsg = (await phone!.waitFor(
        (m) =>
          m.type === 'session_rewind_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-inplace-preview',
      )) as { envelope: EncryptedEnvelope };
      const previewPayload = await phoneOpen<SessionRewindPreviewResultPayloadV1>(
        sessionId,
        previewMsg.envelope,
        key,
      );
      expect(previewPayload).toMatchObject({ outcome: 'ok', preview: { isWorkInPlace: true } });

      phone!.send({
        type: 'session_rewind',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-inplace-rewind-unconfirmed',
        turn: 1,
        confirm: false,
      });
      const unconfirmedMsg = (await phone!.waitFor(
        (m) =>
          m.type === 'session_rewind_result' &&
          (m as { requestId?: string }).requestId === 'req-inplace-rewind-unconfirmed',
      )) as { envelope: EncryptedEnvelope };
      const unconfirmedPayload = await phoneOpen<SessionRewindResultPayloadV1>(
        sessionId,
        unconfirmedMsg.envelope,
        key,
      );
      expect(unconfirmedPayload).toMatchObject({
        outcome: 'confirmation_required',
        preview: { isWorkInPlace: true },
      });
    },
  );
});

describe('an ssh: session shows why it cannot rewind, rather than offering a control that cannot work (issue #747)', () => {
  let remoteSessions: RemoteSessionsSandbox | undefined;
  let remoteWorkspace: string;

  const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box', providers: [] };
  const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

  beforeEach(async () => {
    remoteWorkspace = await mkdtemp(path.join(tmpdir(), 'loombox-rewind-ssh-'));
    remoteSessions = openRemoteSessionsSandbox();
  });

  afterEach(async () => {
    await remoteSessions?.close();
    remoteSessions = undefined;
    await rm(remoteWorkspace, { recursive: true, force: true });
  });

  it(
    'session_rewind_preview and session_rewind both answer outcome: error, errorType: unsupported_target',
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-rewind-ssh';

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-rewind-ssh',
        deviceId: 'device-node-rewind-ssh',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        targets: [SSH_TARGET],
        sshTargets: [SSH_TARGET_CONFIG],
        sshTransportFactory: () => remoteSessions!.createTransport(),
        remoteChildPollIntervalMs: 30,
        supervisor: new AgentSupervisor({
          providers: [echoProvider()],
          stateDir: supervisorStateDir,
        }),
      });

      const session = await node.createSession({
        projectPath: remoteWorkspace,
        provider: 'test-echo',
        targetId: 'devbox',
      });
      expect(session.target).toBe('ssh');

      const key = await derivePhoneSessionKey(amk, accountId, session.id);
      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-rewind-ssh',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');

      phone.send({
        type: 'session_rewind_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-ssh-preview',
        turn: 0,
      });
      const previewMsg = (await phone.waitFor(
        (m) =>
          m.type === 'session_rewind_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-ssh-preview',
      )) as { envelope: EncryptedEnvelope };
      const previewPayload = await phoneOpen<SessionRewindPreviewResultPayloadV1>(
        session.id,
        previewMsg.envelope,
        key,
      );
      expect(previewPayload).toMatchObject({ outcome: 'error', errorType: 'unsupported_target' });

      phone.send({
        type: 'session_rewind',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-ssh-rewind',
        turn: 0,
        confirm: true,
      });
      const rewindMsg = (await phone.waitFor(
        (m) =>
          m.type === 'session_rewind_result' &&
          (m as { requestId?: string }).requestId === 'req-ssh-rewind',
      )) as { envelope: EncryptedEnvelope };
      const rewindPayload = await phoneOpen<SessionRewindResultPayloadV1>(
        session.id,
        rewindMsg.envelope,
        key,
      );
      expect(rewindPayload).toMatchObject({ outcome: 'error', errorType: 'unsupported_target' });
    },
  );
});
