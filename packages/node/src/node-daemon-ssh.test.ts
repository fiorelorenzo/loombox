import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import { PROTOCOL_V1, type SessionUpdateEnvelopeV1, type WireMessageV1 } from '@loombox/protocol';
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
import { LocalProcessTransport } from './ssh/local-process-transport';
import { RemoteProcessRunner } from './ssh/remote-process-runner';
import { SessionLeaseManager } from './ssh/session-lease';

// Same hermetic fixture agent every other package's tests exercise (not a
// real `claude` binary).
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

type CryptoKey = Awaited<ReturnType<typeof importAesGcmKey>>;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
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
  wire: { resourceId: string; iv: string; ciphertext: string },
  key: CryptoKey,
): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: new Uint8Array(Buffer.from(wire.iv, 'base64')),
    ciphertext: new Uint8Array(Buffer.from(wire.ciphertext, 'base64')),
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

  async waitForCount(
    predicate: (message: WireMessageV1) => boolean,
    count: number,
    timeoutMs = 5000,
  ): Promise<WireMessageV1[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.filter(predicate);
      if (found.length >= count) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `TestPhone: timed out waiting for ${count} matching messages (saw ${found.length})`,
        );
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
let remoteWorkspace: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box' };
const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

beforeEach(async () => {
  relay = await startRelay();
  remoteWorkspace = await mkdtemp(path.join(tmpdir(), 'loombox-ssh-node-daemon-'));
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  await rm(remoteWorkspace, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon (ssh: targets, issues #80/#81/#82)', () => {
  it('creates a session on an ssh: target through the deploy-and-launch remote machinery, with full E2E-encrypted parity with a local session', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-basic';

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-ssh-1',
      deviceId: 'device-node-ssh-1',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => new LocalProcessTransport(),
      remoteChildPollIntervalMs: 30,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({
      projectPath: remoteWorkspace,
      provider: 'test-echo',
      targetId: 'devbox',
      title: 'remote session',
    });
    expect(session.target).toBe('ssh');

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-ssh-1',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    await node.promptSession(session.id, 'hi there');
    const chunkMessages = (await phone.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
      2,
    )) as SessionUpdateEnvelopeV1[];

    const decryptedChunks = await Promise.all(
      chunkMessages
        .sort((a, b) => a.seq - b.seq)
        .map((message) =>
          phoneOpen<{ kind: string; text: string }>(session.id, message.envelope, key),
        ),
    );
    expect(decryptedChunks.map((update) => update.text).join('')).toBe('Hello world');
  });

  it('this node exiting does not kill the remote agent process, and a fresh runner reattaches to it (issue #80 acceptance)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-survives-close';
    const transport = new LocalProcessTransport();

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-ssh-2',
      deviceId: 'device-node-ssh-2',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => transport,
      remoteChildPollIntervalMs: 30,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({
      projectPath: remoteWorkspace,
      provider: 'test-echo',
      targetId: 'devbox',
    });

    // The node "exits": close() must not terminate the setsid-detached
    // remote agent process. It does close *this node's* connection to the
    // remote host, exactly like an SSH link dropping — a fresh connection
    // (here, just reconnecting the same stand-in transport) is how a
    // reattach would actually reach it again.
    node.close();
    node = undefined;
    await transport.connect();

    const runner = new RemoteProcessRunner(transport);
    const attached = await runner.attach(session.id);
    expect(attached?.alive).toBe(true);

    await runner.stop(attached!.handle);
    await transport.close();
  });

  it('refuses to create a session whose id is already leased to another node (issue #82)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-lease-conflict';
    const leaseManager = new SessionLeaseManager();
    const contestedSessionId = randomUUID();
    await leaseManager.acquire(contestedSessionId, 'some-other-node');

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-ssh-3',
      deviceId: 'device-node-ssh-3',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => new LocalProcessTransport(),
      leaseManager,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const sessionId = contestedSessionId;
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ title: 'contested', projectPath: remoteWorkspace }),
    );
    const envelope = await encryptEnvelope(sessionId, plaintext, key);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-ssh-3',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'devbox',
      provider: 'test-echo',
      privateEnvelope: {
        resourceId: envelope.resourceId,
        iv: toBase64(envelope.iv),
        ciphertext: toBase64(envelope.ciphertext),
        alg: 'AES-256-GCM',
      },
    });

    // The refused session_create is logged (console.warn), not surfaced on
    // the wire — so prove it never got created by checking it never shows
    // up in the account's session list within a reasonably generous window.
    await new Promise((resolve) => setTimeout(resolve, 300));
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const list = await phone.waitFor((m) => m.type === 'session_list');
    expect(
      (list as { sessions: Array<{ session: { id: string } }> }).sessions.some(
        (entry) => entry.session.id === sessionId,
      ),
    ).toBe(false);
  });

  it('refuses to prompt an ssh: session once this node has lost its ownership lease to a reclaim (issue #82)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-lease-lost';
    // A short-ish TTL so the lease actually expires within the test's
    // lifetime, but long enough that session creation itself (which spawns
    // a real child process) reliably finishes well inside it.
    const leaseManager = new SessionLeaseManager({ ttlMs: 2000 });

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-ssh-4',
      deviceId: 'device-node-ssh-4',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => new LocalProcessTransport(),
      remoteChildPollIntervalMs: 30,
      leaseManager,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({
      projectPath: remoteWorkspace,
      provider: 'test-echo',
      targetId: 'devbox',
    });

    // The session is genuinely usable right after creation.
    await expect(node.promptSession(session.id, 'first')).resolves.toBeUndefined();

    // The lease expires, and another node performs the explicit handoff
    // (SPEC §9's "reclaim on expiry, an explicit action in the PWA").
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const reclaimed = await leaseManager.reclaim(session.id, 'some-other-node');
    expect(reclaimed.granted).toBe(true);

    await expect(node.promptSession(session.id, 'still there?')).rejects.toThrow(/lease/);
  }, 10_000);
});
