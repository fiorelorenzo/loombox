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
    // can't be narrowed inside the `vi.waitFor` closure below.
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
    // session/client before the attachment turn ever runs.
    for (let i = 0; i < 2; i++) {
      const primerEnvelope = await phoneSeal(session.id, { text: `priming turn ${i}` }, key);
      activePhone.send({
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        promptId: `prompt-primer-${i}`,
        envelope: primerEnvelope,
      });
      // Give each primer turn's burst a moment to land (and overflow the
      // depth-2 queue) before the next one fires.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(activePhone.count((m) => m.type === 'resync_marker')).toBeGreaterThan(0); // real backpressure genuinely happened for this session/client

    // Now the attachment turn. `deliverPrompt` resolves the attachment and
    // awaits `sendFileEvent` *before* ever calling `beginTurn`/`prompt()`
    // (see that method's doc comment), so on the node→relay connection the
    // `blob_ref` frame is always sent strictly before any session_update
    // this turn produces even exists to be sent.
    const sessionUpdateCountBeforeAttachmentTurn = activePhone.count(
      (m) => m.type === 'session_update',
    );
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

    const blobRefMsg = (await activePhone.waitFor(
      (m) => m.type === 'blob_ref',
    )) as unknown as BlobRef;
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
    // blocked/starved the agent's own prompt delivery either.
    await vi.waitFor(() =>
      expect(activePhone.count((m) => m.type === 'session_update')).toBeGreaterThan(
        sessionUpdateCountBeforeAttachmentTurn,
      ),
    );

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
  });
});
