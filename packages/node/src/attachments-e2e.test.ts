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
  type BlobRef,
  type EncryptedEnvelope,
  type FileEventPayloadV1,
  type SessionUpdateEnvelopeV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import {
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
  openJson,
} from '@loombox/crypto';

import { attachmentResourceId, type BlobSource } from './attachments';
import {
  createNode,
  type AttachmentHandoffDeclined,
  type NodeDaemon,
  type ResolvedAttachment,
} from './node-daemon';
import {
  openRemoteSessionsSandbox,
  type RemoteSessionsSandbox,
} from './ssh/remote-sessions-test-sandbox';

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

// Advertises `promptCapabilities.image: true` and echoes back the exact
// image content block it received (SPEC §7.25, issue #158) — this is what
// lets a node-level test prove the inline base64 hand-off reaches a
// Codex-shaped agent over the real JSON-RPC/stdio wire, not just that
// `buildInlineImageContentBlock` produces the right shape in isolation
// (already covered by `packages/providers/codex/src/image.test.ts` and
// `conformance.test.ts`).
const CODEX_LIKE_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'codex-like-acp-agent.mjs',
);

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

function codexLikeProvider(): AcpProvider {
  return {
    id: 'test-codex-like',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [CODEX_LIKE_FIXTURE], cwd }),
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
      // Real-time poll interval driving a real WebSocket/relay/subprocess
      // integration test — there is no in-process clock to fake here.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
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

/**
 * Waits until `phone` has seen a `session_update` for `sessionId`, at
 * array index strictly greater than `afterIndex`, whose decrypted payload
 * is `kind: 'turn_ended'` — a turn's own last envelope (SPEC §7.24; issue
 * #128), so seeing it is proof every earlier envelope that turn produced
 * has already been enqueued for delivery (and, for anything that survived
 * a bounded/overflowing client queue, actually delivered). Returns the
 * matched message's index so a caller can chain further calls with it as
 * the next `afterIndex`.
 *
 * The `afterIndex` cursor matters on a session with more than one turn:
 * `phone.messages` never shrinks (a delivered message stays put), so a
 * naive "does any session_update ever received have kind turn_ended"
 * scan matches a PREVIOUS turn's already-seen turn_ended and returns
 * instantly instead of waiting for the turn actually in flight. That
 * false-instant return — not "at least one session_update arrived" being
 * too weak a completion signal on its own — is what let a still-draining
 * primer turn's tail envelopes interleave with the next turn's own and
 * corrupt this file's ordering assertion under full-suite load (issue
 * #886).
 */
async function waitForTurnEnded(
  phone: TestPhone,
  sessionId: string,
  key: CryptoKey,
  afterIndex = -1,
  timeoutMs = 10000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let index = afterIndex + 1; index < phone.messages.length; index++) {
      const message = phone.messages[index];
      if (message.type !== 'session_update' || message.sessionId !== sessionId) continue;
      const decrypted = await openJson<{ kind?: string }>(sessionId, message.envelope, key);
      if (decrypted.kind === 'turn_ended') return index;
    }
    if (Date.now() > deadline) {
      throw new Error('waitForTurnEnded: timed out waiting for turn_ended');
    }
    // Real-time poll interval driving a real WebSocket/relay/subprocess
    // integration test — there is no in-process clock to fake here.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let remoteSessions: RemoteSessionsSandbox | undefined;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box', providers: [] };
const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-attachments-e2e-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-attachments-e2e-state-'));
  remoteSessions = openRemoteSessionsSandbox();
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

describe('NodeDaemon attachment fetch-and-decrypt (SPEC §7.25, issue #156)', () => {
  it('fetches and decrypts a prompt-referenced attachment on a local target, then still delivers the prompt to the agent', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-local';
    const blobSource = new FakeBlobSource();

    node = createNode({
      stateDir: nodeStateDir,
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
        attachments: [
          {
            ref: 'ref-1',
            mimeType: 'image/png',
            name: 'photo.png',
            dimensions: { width: 4, height: 3 },
            thumbhash: 'aGVsbG8=',
          },
        ],
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

    // ...and this node also sent the tiny encrypted file event (issue #154)
    // on its own `blob_ref` channel — metadata only, never the bytes.
    const blobRefMsg = (await phone.waitFor((m) => m.type === 'blob_ref')) as unknown as BlobRef;
    expect(blobRefMsg.sessionId).toBe(session.id);
    expect(blobRefMsg.ref).toBe('ref-1');
    const fileEvent = await openJson<FileEventPayloadV1>(session.id, blobRefMsg.envelope, key);
    expect(fileEvent).toEqual({
      ref: 'ref-1',
      mimeType: 'image/png',
      name: 'photo.png',
      dimensions: { width: 4, height: 3 },
      thumbhash: 'aGVsbG8=',
    });

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
      stateDir: nodeStateDir,
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
      sshTransportFactory: () => remoteSessions!.createTransport(),
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

    // The file event still goes out identically on an ssh: target, and with
    // no `name`/`dimensions`/`thumbhash` supplied it carries only the
    // required fields — the optional metadata is genuinely optional, not
    // padded with placeholders.
    const blobRefMsg = (await phone.waitFor((m) => m.type === 'blob_ref')) as unknown as BlobRef;
    expect(blobRefMsg.sessionId).toBe(session.id);
    expect(blobRefMsg.ref).toBe('ref-9');
    const fileEvent = await openJson<FileEventPayloadV1>(session.id, blobRefMsg.envelope, key);
    expect(fileEvent).toEqual({ ref: 'ref-9', mimeType: 'image/jpeg' });

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
      stateDir: nodeStateDir,
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
    // No attachment, no file event: `deliverPrompt`'s loop never ran, so
    // `sendFileEvent` was never called either.
    expect(phone.count((m) => m.type === 'blob_ref')).toBe(0);
  });

  it('a blob the fake relay cannot serve fails the prompt loudly (logged) rather than silently dropping the attachment', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-missing';
    const blobSource = new FakeBlobSource(); // nothing seeded

    node = createNode({
      stateDir: nodeStateDir,
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
    // A broken ref never reaches the file-event side channel either (SPEC
    // §7.25's "a broken ref must never reach the agent" — the same holds for
    // this side channel: `resolveAttachment` throws before `sendFileEvent`
    // is ever reached).
    expect(phone.count((m) => m.type === 'blob_ref')).toBe(0);

    warnSpy.mockRestore();
  });

  it('hands off a resolved attachment to the agent as an inline base64 ACP image content block when the session negotiated the image capability (SPEC §7.25 "Hand off to the agent"; issue #158)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-image-handoff';
    const blobSource = new FakeBlobSource();

    node = createNode({
      stateDir: nodeStateDir,
      relayUrl: relay.url,
      nodeId: 'node-attach-image-handoff',
      deviceId: 'device-node-attach-image-handoff',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      blobSource,
      supervisor: new AgentSupervisor({ providers: [codexLikeProvider()] }),
    });

    const declinedEvents: AttachmentHandoffDeclined[] = [];
    node.on('attachment_handoff_declined', (event: AttachmentHandoffDeclined) =>
      declinedEvents.push(event),
    );

    const session = await node.createSession({ projectPath, provider: 'test-codex-like' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    // Genuinely PNG-shaped magic bytes: `buildInlineImageContentBlock`
    // re-sniffs rather than trusting the declared mimeType below.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    blobSource.seed(
      session.id,
      'ref-image',
      await phoneSealAttachment(session.id, 'ref-image', pngBytes, key),
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-attach-image-handoff',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    // The fixture's "describe-image" text (see `codex-like-acp-agent.mjs`)
    // echoes back the mimeType and base64 length of the FIRST `type:
    // 'image'` block it finds in the full `prompt` content array — the
    // only way to prove `deliverPrompt` actually appended the block Codex
    // expects onto the real JSON-RPC turn, not just that the builder
    // produces the right shape in isolation.
    const envelope = await phoneSeal(
      session.id,
      { text: 'describe-image', attachments: [{ ref: 'ref-image', mimeType: 'image/png' }] },
      key,
    );
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-image-handoff',
      envelope,
    });

    const expectedBase64Length = Buffer.from(pngBytes).toString('base64').length;
    await vi.waitFor(async () => {
      const sessionUpdates = phone!.messages.filter(
        (m) => m.type === 'session_update',
      ) as unknown as SessionUpdateEnvelopeV1[];
      expect(sessionUpdates.length).toBeGreaterThan(0);
      const decoded = await Promise.all(
        sessionUpdates.map((update) => openJson<unknown>(session.id, update.envelope, key)),
      );
      const serialized = decoded.map((d) => JSON.stringify(d)).join('\n');
      expect(serialized).toContain(`received image: image/png ${expectedBase64Length}b64`);
    });

    // The capability WAS negotiated (the fixture advertises `image: true`),
    // so this attachment's hand-off must never have been declined.
    expect(declinedEvents).toHaveLength(0);
  });

  it('emits attachment_handoff_declined with "capability-not-negotiated" (never blocking the turn) when the session\'s agent never advertised the image capability (SPEC §7.25; issue #158)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach-image-declined';
    const blobSource = new FakeBlobSource();

    node = createNode({
      stateDir: nodeStateDir,
      relayUrl: relay.url,
      nodeId: 'node-attach-image-declined',
      deviceId: 'device-node-attach-image-declined',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      blobSource,
      // The plain echo fixture advertises `promptCapabilities.image: false`.
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const declinedEvents: AttachmentHandoffDeclined[] = [];
    node.on('attachment_handoff_declined', (event: AttachmentHandoffDeclined) =>
      declinedEvents.push(event),
    );

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03, 0x04]);
    blobSource.seed(
      session.id,
      'ref-declined',
      await phoneSealAttachment(session.id, 'ref-declined', pngBytes, key),
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-attach-image-declined',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(
      session.id,
      { text: 'look at this', attachments: [{ ref: 'ref-declined', mimeType: 'image/png' }] },
      key,
    );
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-image-declined',
      envelope,
    });

    await vi.waitFor(() => expect(declinedEvents).toHaveLength(1));
    expect(declinedEvents[0]).toEqual({
      sessionId: session.id,
      ref: 'ref-declined',
      reason: 'capability-not-negotiated',
    });

    // A declined hand-off degrades the turn, it never fails it: the prompt
    // still reaches the agent as plain text and the turn completes.
    await phone.waitFor(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
    );
  });
});

describe('the file event is decoupled from the session_update bounded queue (SPEC §7.16, issue #154)', () => {
  it('a saturated session_update queue does not gate/delay the file event, and attachment bytes never enter the session_update fan-out', async () => {
    // A deliberately tiny bound so an ordinary turn's own burst of
    // session_update messages (two transcript chunks plus status/turn_ended
    // events) reliably overflows it and produces a real resync_marker —
    // concrete evidence this session's queue actually experienced
    // drop-oldest backpressure, not just a theoretical bound.
    await relay.close();
    relay = await startRelay({ maxClientQueueDepth: 2 });

    const amk = generateAmk();
    const accountId = 'acct-file-event-decoupled';
    const blobSource = new FakeBlobSource();

    node = createNode({
      stateDir: nodeStateDir,
      relayUrl: relay.url,
      nodeId: 'node-file-event-decoupled',
      deviceId: 'device-node-file-event-decoupled',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      blobSource,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    // A "multi-megabyte blob" stand-in, scaled down for test speed — large
    // enough that if it ever leaked into a session_update envelope's
    // plaintext, the scan below would catch it. (`getRandomValues` itself
    // caps out at 65,536 bytes per call, hence the chunked fill.)
    const attachmentBytes = new Uint8Array(200_000);
    for (let offset = 0; offset < attachmentBytes.length; offset += 65_536) {
      crypto.getRandomValues(attachmentBytes.subarray(offset, offset + 65_536));
    }
    blobSource.seed(
      session.id,
      'ref-big',
      await phoneSealAttachment(session.id, 'ref-big', attachmentBytes, key),
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-file-event-decoupled',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    // A local, non-`undefined`-typed alias: the module-level `let phone`
    // can't be narrowed inside the closures below.
    const activePhone = phone;
    await activePhone.ready;
    activePhone.send({
      type: 'session_resume',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
    });
    await activePhone.waitFor((m) => m.type === 'session_announce');

    // Saturate this session's bounded client queue with a couple of
    // ordinary (attachment-less) turns first, so a genuine drop-oldest
    // overflow (a resync_marker) has already happened for this exact
    // session/client before the attachment turn ever runs. Each iteration
    // waits for its OWN turn_ended (tracked via `turnEndedCursor`, so the
    // second iteration can't re-match the first primer's already-seen
    // turn_ended — see `waitForTurnEnded`'s doc comment) before the next
    // one fires. A blind fixed sleep here, before that, was the same
    // wall-clock-as-synchronisation bug as #793's PTY test.
    let turnEndedCursor = -1;
    for (let i = 0; i < 2; i++) {
      const primerEnvelope = await phoneSeal(session.id, { text: `priming turn ${i}` }, key);
      activePhone.send({
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        promptId: `prompt-primer-${i}`,
        envelope: primerEnvelope,
      });
      turnEndedCursor = await waitForTurnEnded(activePhone, session.id, key, turnEndedCursor);
    }
    // Waits for the marker itself to actually arrive, driven off
    // `TestPhone`'s own message-arrival poll (the same idiom every other
    // wait in this file already uses), instead of guessing a fixed sleep
    // was long enough after the loop above. `waitFor` throws (failing the
    // test for a real reason) if no resync_marker shows up within its
    // bound — widened past the 5000ms default because under full-suite
    // load a real relay/node/agent round trip can genuinely need more
    // than that (issue #886).
    await activePhone.waitFor((m) => m.type === 'resync_marker', 10_000); // real backpressure genuinely happened for this session/client

    // Now the attachment turn. `deliverPrompt` resolves the attachment and
    // awaits `sendFileEvent` *before* ever calling `beginTurn`/`prompt()`
    // (see that method's doc comment), so on the node→relay connection the
    // `blob_ref` frame is always sent strictly before any session_update
    // this turn produces even exists to be sent. The assertions below
    // prove that on the wire, not just in the implementation's doc
    // comment: `turnEndedCursor` (already pointing at the last primer's
    // own turn_ended) anchors "this turn's own updates start after here",
    // and the index comparison after `blobRefMsg` arrives (below) proves
    // "strictly before" as an ordering fact about one WebSocket's
    // message-arrival sequence, not a timing race (issue #886).
    const sessionUpdateBaselineIndex = turnEndedCursor;
    const attachmentEnvelope = await phoneSeal(
      session.id,
      { text: 'here is a big file', attachments: [{ ref: 'ref-big', mimeType: 'image/png' }] },
      key,
    );
    activePhone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-big-attachment',
      envelope: attachmentEnvelope,
    });

    // Widened past the 5000ms default for the same reason as the
    // resync_marker wait above (issue #886): fetching and decrypting a
    // real 200KB blob and round-tripping through a real relay/node under
    // full-suite CPU contention can take longer than that.
    const blobRefMsg = (await activePhone.waitFor(
      (m) => m.type === 'blob_ref',
      15_000,
    )) as unknown as BlobRef;
    const blobRefIndex = activePhone.messages.indexOf(blobRefMsg as unknown as WireMessageV1);
    expect(blobRefMsg.sessionId).toBe(session.id);
    expect(blobRefMsg.ref).toBe('ref-big');
    // Structurally a different animal from a bounded-queue item
    // (`OutboxItem` is always `SessionUpdateEnvelopeV1 | ResyncMarker`, both
    // of which carry seq-range fields): `blob_ref` has no `seq`/`fromSeq`/
    // `toSeq` at all, confirming it never rides that queue.
    expect(blobRefMsg).not.toHaveProperty('seq');
    expect(blobRefMsg).not.toHaveProperty('fromSeq');

    // Metadata only — matches `FileEventPayloadV1` exactly, no byte field.
    const fileEvent = await openJson<FileEventPayloadV1>(session.id, blobRefMsg.envelope, key);
    expect(fileEvent).toEqual({ ref: 'ref-big', mimeType: 'image/png' });

    // The turn still completes normally afterward — the file event never
    // blocked/starved the agent's own prompt delivery either. Waiting for
    // this turn's own turn_ended (cursored past `turnEndedCursor`, so it
    // can't re-match a primer's) is both the real completion signal and
    // what pins the exact index range the ordering check below scans.
    const attachmentTurnEndedIndex = await waitForTurnEnded(
      activePhone,
      session.id,
      key,
      turnEndedCursor,
    );

    // The causal ordering proof itself: every session_update this turn
    // produced (strictly after `sessionUpdateBaselineIndex`, up to and
    // including its own turn_ended) arrived, on the wire, strictly after
    // blob_ref — never gated or delayed behind the very queue it
    // deliberately bypasses. Message arrival order on one WebSocket
    // connection is deterministic (the socket's `message` listener fires
    // in frame-arrival order), so comparing array indices proves
    // ordering, not a race against the clock.
    const thisTurnsSessionUpdateIndices = activePhone.messages
      .map((m, index) => ({ type: m.type, index }))
      .filter(
        ({ type, index }) =>
          type === 'session_update' &&
          index > sessionUpdateBaselineIndex &&
          index <= attachmentTurnEndedIndex,
      )
      .map(({ index }) => index);
    expect(thisTurnsSessionUpdateIndices.length).toBeGreaterThan(0);
    for (const index of thisTurnsSessionUpdateIndices) {
      expect(index).toBeGreaterThan(blobRefIndex);
    }

    // The core byte-boundary guarantee: scan every session_update this
    // client ever received (this session's whole transcript stream,
    // decrypted) and confirm the attachment's actual bytes never appear
    // anywhere in it — the bytes traveled only via `blob_upload`/
    // `blob_download`, never through the live session_update fan-out.
    const attachmentBase64 = Buffer.from(attachmentBytes).toString('base64');
    const sessionUpdates = activePhone.messages.filter(
      (m) => m.type === 'session_update',
    ) as unknown as SessionUpdateEnvelopeV1[];
    expect(sessionUpdates.length).toBeGreaterThan(0);
    for (const update of sessionUpdates) {
      const decrypted = await openJson<unknown>(session.id, update.envelope, key);
      const serialized = JSON.stringify(decrypted);
      expect(serialized).not.toContain(attachmentBase64);
      expect(serialized.length).toBeLessThan(attachmentBase64.length);
    }
    // This test does real end-to-end work through a real relay, node, and
    // spawned ACP agent process: two priming turns each waiting for their
    // own turn_ended, the resync_marker wait, the attachment turn's
    // blob_ref wait, and its own turn_ended wait — each generously bounded
    // on its own, and each genuinely slower under full-suite CPU
    // contention than on an idle box. Vitest's 5000ms default test
    // timeout is tighter than the sum of those bounds even in a
    // merely-slow (not stuck) run, which is exactly what made this test
    // time out under load (issue #886) rather than fail any individual
    // assertion. 60s leaves real headroom without masking an actual hang.
  }, 60_000);
});
