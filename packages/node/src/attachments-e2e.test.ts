import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type SessionUpdateEnvelopeV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import { deriveKeyTree, encryptEnvelope, generateAmk, importAesGcmKey } from '@loombox/crypto';

import { attachmentResourceId, type BlobSource } from './attachments';
import { createNode, type NodeDaemon, type ResolvedAttachment } from './node-daemon';
import { LocalProcessTransport } from './ssh/local-process-transport';

const execFileAsync = promisify(execFile);

type CryptoKey = Awaited<ReturnType<typeof importAesGcmKey>>;

// Same hermetic fixture agent every other package's tests exercise (not a real `claude` binary).
const ECHO_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
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
  resourceId: string,
  value: unknown,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const envelope = await encryptEnvelope(resourceId, plaintext, key);
  return {
    resourceId: envelope.resourceId,
    iv: toBase64(envelope.iv),
    ciphertext: toBase64(envelope.ciphertext),
    alg: 'AES-256-GCM',
  };
}

/** Seals raw bytes (not JSON) under `key`, bound to the same AAD `AttachmentResolver` expects — a phone encrypting an attachment blob before "uploading" it (SPEC §7.25). */
async function phoneSealAttachment(
  sessionId: string,
  ref: string,
  bytes: Uint8Array,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const envelope = await encryptEnvelope(attachmentResourceId(sessionId, ref), bytes, key);
  return {
    resourceId: envelope.resourceId,
    iv: toBase64(envelope.iv),
    ciphertext: toBase64(envelope.ciphertext),
    alg: 'AES-256-GCM',
  };
}

/**
 * A fake blob source standing in for the relay's blob store (issue #156's
 * "fake the relay/blob download" test guidance — real end-to-end blob
 * routing for a *node*-role relay connection needs a relay-side change
 * outside this PR's scope, documented in `attachments.ts`'s doc comment).
 * Seeded per (sessionId, ref); an unseeded lookup rejects, simulating "the
 * relay has nothing under that ref".
 */
class FakeBlobSource implements BlobSource {
  private readonly blobs = new Map<string, EncryptedEnvelope>();

  seed(sessionId: string, ref: string, envelope: EncryptedEnvelope): void {
    this.blobs.set(`${sessionId}:${ref}`, envelope);
  }

  async downloadBlob(sessionId: string, ref: string): Promise<EncryptedEnvelope> {
    const envelope = this.blobs.get(`${sessionId}:${ref}`);
    if (!envelope) {
      throw new Error(`FakeBlobSource: no blob seeded for session ${sessionId} ref ${ref}`);
    }
    return envelope;
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
    timeoutMs = 5000,
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

  count(predicate: (message: WireMessageV1) => boolean): number {
    return this.messages.filter(predicate).length;
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
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box' };
const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-attachments-e2e-test-'));
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
  await relay.close();
});

describe('NodeDaemon attachment fetch-and-decrypt (SPEC §7.25, issue #156)', () => {
  it('fetches and decrypts a prompt-referenced attachment on a local target, then still delivers the prompt to the agent', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-local';
    const blobSource = new FakeBlobSource();

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-attach-local',
      deviceId: 'device-node-attach-local',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      blobSource,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    expect(session.target).toBe('local');
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    const attachmentBytes = new TextEncoder().encode('pretend this is PNG bytes');
    blobSource.seed(
      session.id,
      'ref-1',
      await phoneSealAttachment(session.id, 'ref-1', attachmentBytes, key),
    );

    const resolvedEvents: ResolvedAttachment[] = [];
    node.on('attachment_resolved', (event: ResolvedAttachment) => resolvedEvents.push(event));

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-attach-local',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(
      session.id,
      {
        text: 'look at this image',
        attachments: [{ ref: 'ref-1', mimeType: 'image/png', name: 'photo.png' }],
      },
      key,
    );
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-attach-1',
      envelope,
    });

    // The attachment was resolved to the right, correctly-decrypted plaintext...
    await vi.waitFor(() => expect(resolvedEvents).toHaveLength(1));
    expect(resolvedEvents[0]).toMatchObject({
      sessionId: session.id,
      ref: 'ref-1',
      mimeType: 'image/png',
      name: 'photo.png',
    });
    expect(Array.from(resolvedEvents[0].bytes)).toEqual(Array.from(attachmentBytes));

    // ...and the prompt still reached the agent (the turn completed normally).
    await phone.waitFor(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
    );
  });

  it('fetches and decrypts a prompt-referenced attachment identically on an ssh: target', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-ssh';
    const blobSource = new FakeBlobSource();

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-attach-ssh',
      deviceId: 'device-node-attach-ssh',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      blobSource,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => new LocalProcessTransport(),
      remoteChildPollIntervalMs: 30,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({
      projectPath,
      provider: 'test-echo',
      targetId: 'devbox',
    });
    expect(session.target).toBe('ssh');
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    const attachmentBytes = new TextEncoder().encode('remote-host attachment bytes');
    blobSource.seed(
      session.id,
      'ref-9',
      await phoneSealAttachment(session.id, 'ref-9', attachmentBytes, key),
    );

    const resolvedEvents: ResolvedAttachment[] = [];
    node.on('attachment_resolved', (event: ResolvedAttachment) => resolvedEvents.push(event));

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-attach-ssh',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(
      session.id,
      { text: 'see attached', attachments: [{ ref: 'ref-9', mimeType: 'image/jpeg' }] },
      key,
    );
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-attach-ssh-1',
      envelope,
    });

    await vi.waitFor(() => expect(resolvedEvents).toHaveLength(1));
    expect(resolvedEvents[0]).toMatchObject({
      sessionId: session.id,
      ref: 'ref-9',
      mimeType: 'image/jpeg',
    });
    expect(Array.from(resolvedEvents[0].bytes)).toEqual(Array.from(attachmentBytes));

    await phone.waitFor(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
    );
  });

  it('a prompt with no attachments never touches the blob source at all', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-none';
    let downloadCalls = 0;
    const blobSource: BlobSource = {
      downloadBlob: async () => {
        downloadCalls += 1;
        throw new Error('should not be called');
      },
    };

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-attach-none',
      deviceId: 'device-node-attach-none',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      blobSource,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-attach-none',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(session.id, { text: 'plain prompt, no attachments' }, key);
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-no-attach',
      envelope,
    });

    await phone.waitFor(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
    );
    expect(downloadCalls).toBe(0);
  });

  it('a blob the fake relay cannot serve fails the prompt loudly (logged) rather than silently dropping the attachment', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-missing';
    const blobSource = new FakeBlobSource(); // nothing seeded

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-attach-missing',
      deviceId: 'device-node-attach-missing',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      blobSource,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-attach-missing',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(
      session.id,
      { text: 'missing attachment', attachments: [{ ref: 'ref-missing', mimeType: 'image/png' }] },
      key,
    );
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-attach-missing',
      envelope,
    });

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to handle prompt_inject'),
      ),
    );
    // The turn never ran: no session_update was ever produced for this session.
    expect(phone.count((m) => m.type === 'session_update')).toBe(0);

    warnSpy.mockRestore();
  });
});
