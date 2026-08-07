import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type AgentInstructionsGetResponsePayloadV1,
  type AgentInstructionsSetRequestPayloadV1,
  type AgentInstructionsSetResponsePayloadV1,
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
import { hashAgentInstructionsContent } from './agent-instructions';

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * The full wire-level proof for SPEC §7.18/issue #260: a real session, in
 * its own real isolated git worktree (`SessionManager`'s default), reads
 * and writes real `AGENTS.md`/`CLAUDE.md` files through
 * `agent_instructions_get_request`/`_response` and
 * `agent_instructions_set_request`/`_response` over a real relay — the
 * same "real node, real relay, real filesystem, fake ACP provider"
 * pattern `node-daemon-pr-open.test.ts` established.
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

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-agent-instructions-test-'));
  nodeStateDir = await mkdtemp(
    path.join(tmpdir(), 'loombox-node-daemon-agent-instructions-state-'),
  );

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

/** Creates a real node + a real isolated-worktree session over a real relay, resumed by a real phone. Returns the session id, its decryption key, and the real absolute worktree path a test can read/write directly. */
async function createSessionOverWire(): Promise<{
  sessionId: string;
  key: CryptoKey;
  worktreePath: string;
}> {
  const amk = generateAmk();
  const accountId = 'acct-agent-instructions';

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-agent-instructions',
    deviceId: 'device-node-agent-instructions',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
  });

  const session = await node.createSession({ projectPath, provider: 'test-echo' });
  const key = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-agent-instructions',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  return { sessionId: session.id, key, worktreePath: session.worktreePath };
}

async function getAgentInstructions(
  sessionId: string,
  key: CryptoKey,
  requestId: string,
): Promise<AgentInstructionsGetResponsePayloadV1> {
  phone!.send({
    type: 'agent_instructions_get_request',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    requestId,
  });
  const msg = (await phone!.waitFor(
    (m) =>
      m.type === 'agent_instructions_get_response' &&
      (m as { requestId?: string }).requestId === requestId,
  )) as { envelope: EncryptedEnvelope };
  return phoneOpen<AgentInstructionsGetResponsePayloadV1>(sessionId, msg.envelope, key);
}

async function setAgentInstructions(
  sessionId: string,
  key: CryptoKey,
  requestId: string,
  payload: AgentInstructionsSetRequestPayloadV1,
): Promise<AgentInstructionsSetResponsePayloadV1> {
  const envelope = await phoneSeal(sessionId, payload, key);
  phone!.send({
    type: 'agent_instructions_set_request',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    requestId,
    envelope,
  });
  const msg = (await phone!.waitFor(
    (m) =>
      m.type === 'agent_instructions_set_response' &&
      (m as { requestId?: string }).requestId === requestId,
  )) as { envelope: EncryptedEnvelope };
  return phoneOpen<AgentInstructionsSetResponsePayloadV1>(sessionId, msg.envelope, key);
}

describe('agent_instructions_get_request / agent_instructions_set_request wire round trip (SPEC §7.18; issue #260)', () => {
  it('a project with neither file: get reports [], set creates AGENTS.md, and a second get reflects it', async () => {
    const { sessionId, key, worktreePath } = await createSessionOverWire();

    const empty = await getAgentInstructions(sessionId, key, 'req-get-1');
    expect(empty).toEqual({ outcome: 'ok', files: [] });

    const created = await setAgentInstructions(sessionId, key, 'req-set-1', {
      fileName: 'AGENTS.md',
      content: '# hello agents\n',
      baseHash: null,
    });
    expect(created).toEqual({
      outcome: 'ok',
      fileName: 'AGENTS.md',
      content: '# hello agents\n',
      hash: hashAgentInstructionsContent('# hello agents\n'),
    });

    const onDisk = await readFile(path.join(worktreePath, 'AGENTS.md'), 'utf8');
    expect(onDisk).toBe('# hello agents\n');

    const afterCreate = await getAgentInstructions(sessionId, key, 'req-get-2');
    expect(afterCreate).toEqual({
      outcome: 'ok',
      files: [
        {
          fileName: 'AGENTS.md',
          content: '# hello agents\n',
          hash: hashAgentInstructionsContent('# hello agents\n'),
        },
      ],
    });
  });

  it('a project with a real AGENTS.md and CLAUDE.md: get reports both, keyed by the file actually on disk', async () => {
    const { sessionId, key } = await createSessionOverWire();
    await setAgentInstructions(sessionId, key, 'req-seed-agents', {
      fileName: 'AGENTS.md',
      content: 'agents body',
      baseHash: null,
    });
    await setAgentInstructions(sessionId, key, 'req-seed-claude', {
      fileName: 'CLAUDE.md',
      content: '@AGENTS.md\n',
      baseHash: null,
    });

    const result = await getAgentInstructions(sessionId, key, 'req-get-both');
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.files.map((file) => file.fileName)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    }
  });

  it('never overwrites blindly: a write against a stale baseHash comes back as conflict, and the on-disk content is untouched', async () => {
    const { sessionId, key, worktreePath } = await createSessionOverWire();
    const first = await setAgentInstructions(sessionId, key, 'req-set-first', {
      fileName: 'AGENTS.md',
      content: 'v1',
      baseHash: null,
    });
    expect(first.outcome).toBe('ok');

    // Something else (an agent, a human editing on disk) changes the file
    // directly, bypassing this wire pair entirely — exactly the scenario
    // this feature exists to detect.
    await writeFile(path.join(worktreePath, 'AGENTS.md'), 'changed on disk directly', 'utf8');

    const staleWrite = await setAgentInstructions(sessionId, key, 'req-set-stale', {
      fileName: 'AGENTS.md',
      content: 'my stale edit built on v1',
      baseHash: first.outcome === 'ok' ? first.hash : '',
    });

    expect(staleWrite).toEqual({
      outcome: 'conflict',
      fileName: 'AGENTS.md',
      current: {
        fileName: 'AGENTS.md',
        content: 'changed on disk directly',
        hash: hashAgentInstructionsContent('changed on disk directly'),
      },
    });

    const onDisk = await readFile(path.join(worktreePath, 'AGENTS.md'), 'utf8');
    expect(onDisk).toBe('changed on disk directly');
  });

  it('an edit built on the current hash applies cleanly and the new hash chains to the next write', async () => {
    const { sessionId, key, worktreePath } = await createSessionOverWire();
    const created = await setAgentInstructions(sessionId, key, 'req-set-a', {
      fileName: 'CLAUDE.md',
      content: 'draft one',
      baseHash: null,
    });
    expect(created.outcome).toBe('ok');
    const firstHash = created.outcome === 'ok' ? created.hash : '';

    const edited = await setAgentInstructions(sessionId, key, 'req-set-b', {
      fileName: 'CLAUDE.md',
      content: 'draft two',
      baseHash: firstHash,
    });
    expect(edited).toEqual({
      outcome: 'ok',
      fileName: 'CLAUDE.md',
      content: 'draft two',
      hash: hashAgentInstructionsContent('draft two'),
    });

    const onDisk = await readFile(path.join(worktreePath, 'CLAUDE.md'), 'utf8');
    expect(onDisk).toBe('draft two');
  });
});
