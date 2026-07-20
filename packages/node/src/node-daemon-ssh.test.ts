import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir as fsMkdir, mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type SessionListV1,
  type SessionUpdateEnvelopeV1,
  type SessionWithPrivateEnvelope,
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
import { LocalProcessTransport } from './ssh/local-process-transport';
import { RemoteProcessRunner } from './ssh/remote-process-runner';
import { SessionLeaseManager } from './ssh/session-lease';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

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

/** One `session_update` envelope, decrypted, tagged with its wire `seq`. */
interface DecryptedSessionEvent {
  seq: number;
  kind: string;
  text?: string;
  turnId?: string;
  stopReason?: string;
}

/**
 * Decrypts every `session_update` envelope seen so far for `sessionId` and
 * returns only the ones whose inner `kind` is in `kinds`, seq-sorted. Polls
 * until at least `count` match, or times out — needed now that `@loombox/
 * node` also forwards `session_status`/`config_options`/`turn_started`/
 * `turn_ended` lifecycle events over the exact same `session_update`
 * envelope a transcript chunk rides (SPEC §7.13/§7.24/§8; issues
 * #126/#128/#149), so a raw `type === 'session_update'` count is no longer
 * the same thing as an `agent_message_chunk` count. Mirrors `node-daemon
 * .test.ts`'s identical helper (kept local rather than shared, same as this
 * file's other duplicated `TestPhone`/`phoneOpen`).
 */
async function waitForDecryptedKinds(
  phone: TestPhone,
  sessionId: string,
  key: CryptoKey,
  kinds: string[],
  count: number,
  timeoutMs = 10000,
): Promise<DecryptedSessionEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidates = phone.messages.filter(
      (m): m is SessionUpdateEnvelopeV1 => m.type === 'session_update' && m.sessionId === sessionId,
    );
    const decrypted = await Promise.all(
      candidates.map(async (m) => ({
        seq: m.seq,
        ...(await phoneOpen<Omit<DecryptedSessionEvent, 'seq'>>(sessionId, m.envelope, key)),
      })),
    );
    const matched = decrypted.filter((d) => kinds.includes(d.kind)).sort((a, b) => a.seq - b.seq);
    if (matched.length >= count) return matched;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForDecryptedKinds: timed out waiting for ${count} of [${kinds.join(', ')}] (saw ${matched.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits until `node` has completed the relay handshake at least once — mirrors `node-daemon.test.ts`'s identical helper. */
function waitForConnected(node: NodeDaemon): Promise<void> {
  return new Promise((resolve) => node.once('connected', resolve));
}

/** Polls `session_list_request` until `sessionId` shows up (a client-initiated `session_create` has no direct ack) — mirrors `node-daemon.test.ts`'s identical helper (kept local rather than shared, same as this file's other duplicated `TestPhone`/`phoneOpen`). */
async function waitForSessionInList(
  phone: TestPhone,
  sessionId: string,
  timeoutMs = 5000,
): Promise<SessionWithPrivateEnvelope> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const list = [...phone.messages]
      .reverse()
      .find((m): m is SessionListV1 => m.type === 'session_list');
    const entry = list?.sessions.find((s) => s.session.id === sessionId);
    if (entry) return entry;
    if (Date.now() > deadline) {
      throw new Error(`waitForSessionInList: timed out waiting for session ${sessionId}`);
    }
  }
}

let relay: StartedRelay;
let remoteWorkspace: string;
// Passed as every createNode() call's `stateDir` below, so its default-
// constructed `McpConfigStore`/`NodeMcpSecretManager` (issues #187/#189)
// never touch the real ~/.loombox/node.
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box' };
const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

beforeEach(async () => {
  relay = await startRelay();
  remoteWorkspace = await mkdtemp(path.join(tmpdir(), 'loombox-ssh-node-daemon-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-ssh-node-daemon-state-'));
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  await rm(remoteWorkspace, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon (ssh: targets, issues #80/#81/#82)', () => {
  it('creates a session on an ssh: target through the deploy-and-launch remote machinery, with full E2E-encrypted parity with a local session', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-basic';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
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
    const chunks = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 2);
    expect(chunks.map((update) => update.text).join('')).toBe('Hello world');
  });

  it('this node exiting does not kill the remote agent process, and a fresh runner reattaches to it (issue #80 acceptance)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-survives-close';
    const transport = new LocalProcessTransport();

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
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
      stateDir: nodeStateDir,
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
      stateDir: nodeStateDir,
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
      // This test simulates the owning node going silent (SPEC §9: "an
      // expired lease can be explicitly reclaimed by another node") — it
      // must let the lease's own TTL lapse with nothing renewing it. A very
      // long heartbeat interval keeps `NodeDaemon`'s own renewal (issues
      // #82/#104) from firing within this test's short wait window, so the
      // lease actually goes stale exactly as this test expects.
      leaseHeartbeatIntervalMs: 60_000,
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

  it('cross-node: two separate NodeDaemon processes sharing one relay arbitrate a session lease through it — node A holds, node B is denied; A releases, B acquires (issues #82/#104)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-cross-node-lease';
    const sessionId = randomUUID();
    const nodeAStateDir = await mkdtemp(
      path.join(tmpdir(), 'loombox-ssh-node-daemon-state-cross-a-'),
    );
    const nodeBStateDir = await mkdtemp(
      path.join(tmpdir(), 'loombox-ssh-node-daemon-state-cross-b-'),
    );
    // Node B gets its own distinct target id — the relay's target registry
    // maps one nodeId per targetId (last announcer wins), so reusing
    // `SSH_TARGET`'s id 'devbox' on both nodes would make a `session_create`
    // routed to "devbox" land on whichever node announced most recently,
    // not deterministically on node B. A distinct id sidesteps that and
    // isolates this test to exactly what it means to prove: the SAME
    // sessionId contended across two different nodes.
    const SSH_TARGET_B = { id: 'devbox-b', kind: 'ssh' as const, label: 'Dev box B' };
    const SSH_TARGET_CONFIG_B = {
      id: 'devbox-b',
      label: 'Dev box B',
      host: 'devbox.invalid',
      user: 'dev',
    };

    // Two independent `NodeDaemon`s (their own in-process `SessionLeaseManager`
    // each, exactly like two real processes on two real machines — a Mac
    // node and a devbox node, SPEC §9) connected to the SAME relay under the
    // SAME account. Neither node's local lease state can see the other's —
    // only the relay's own `LeaseStore` (issues #82/#104) can arbitrate
    // between them, which is exactly what this test exercises.
    const nodeA = createNode({
      relayUrl: relay.url,
      stateDir: nodeAStateDir,
      nodeId: 'node-cross-a',
      deviceId: 'device-cross-a',
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
    const nodeB = createNode({
      relayUrl: relay.url,
      stateDir: nodeBStateDir,
      nodeId: 'node-cross-b',
      deviceId: 'device-cross-b',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET_B],
      sshTargets: [SSH_TARGET_CONFIG_B],
      sshTransportFactory: () => new LocalProcessTransport(),
      remoteChildPollIntervalMs: 30,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    let phone: TestPhone | undefined;

    try {
      // Ensures both nodes' target_announce has landed at the relay before
      // either session_create below needs to route off it.
      await Promise.all([waitForConnected(nodeA), waitForConnected(nodeB)]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const key = await derivePhoneSessionKey(amk, accountId, sessionId);
      const plaintext = new TextEncoder().encode(
        JSON.stringify({ title: 'cross-node', projectPath: remoteWorkspace }),
      );
      const envelope = await encryptEnvelope(sessionId, plaintext, key);
      const privateEnvelope = {
        resourceId: envelope.resourceId,
        iv: toBase64(envelope.iv),
        ciphertext: toBase64(envelope.ciphertext),
        alg: 'AES-256-GCM' as const,
      };

      phone = new TestPhone(relay.url, {
        deviceId: 'device-cross-phone',
        devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
        authToken: accountId,
      });
      await phone.ready;

      // node A creates the session (relay-routed, exactly like a real
      // client-initiated session_create).
      phone.send({
        type: 'session_create',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        targetId: 'devbox',
        provider: 'test-echo',
        privateEnvelope,
      });
      const ownedByA = await waitForSessionInList(phone, sessionId);
      expect(ownedByA.session.nodeId).toBe('node-cross-a');

      // node B attempts the exact same sessionId on ITS OWN target — node
      // B's own local leaseManager has never heard of this sessionId (it
      // would happily grant it locally); only the relay's cross-node
      // arbitration can deny it. A denial is logged and dropped, not
      // surfaced on the wire (same as the single-node "already leased"
      // test above), so prove it by confirming the session's owner is
      // still node A after giving it a moment to (not) take effect.
      phone.send({
        type: 'session_create',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        targetId: 'devbox-b',
        provider: 'test-echo',
        privateEnvelope,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const stillOwnedByA = await waitForSessionInList(phone, sessionId);
      expect(stillOwnedByA.session.nodeId).toBe('node-cross-a');

      // node A stops driving the session (SPEC §9's "release on stop/exit");
      // node B's retry now succeeds and becomes the new owner.
      nodeA.close();
      await new Promise((resolve) => setTimeout(resolve, 300));

      phone.send({
        type: 'session_create',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        targetId: 'devbox-b',
        provider: 'test-echo',
        privateEnvelope,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const ownedByB = await waitForSessionInList(phone, sessionId);
      expect(ownedByB.session.nodeId).toBe('node-cross-b');
    } finally {
      phone?.close();
      nodeA.close();
      nodeB.close();
      await rm(nodeAStateDir, { recursive: true, force: true });
      await rm(nodeBStateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("exposes the ssh: target through getExecutionTarget(), sharing this target's pooled transport (issue #69)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-execution-target';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-5',
      deviceId: 'device-node-ssh-5',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => new LocalProcessTransport(),
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const executionTarget = await node.getExecutionTarget('devbox');
    expect(executionTarget.kind).toBe('ssh');

    const result = await executionTarget.exec('echo', ['hello from ssh target']);
    expect(result.stdout).toBe('hello from ssh target\n');
    expect(result.exitCode).toBe(0);

    // Every call for the same target id returns the same instance, backed by
    // the one pooled transport session creation itself uses — never a second
    // connection.
    expect(await node.getExecutionTarget('devbox')).toBe(executionTarget);
  });

  it('rejects getExecutionTarget() for an unknown target id', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-execution-target-unknown';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-6',
      deviceId: 'device-node-ssh-6',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => new LocalProcessTransport(),
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    await expect(node.getExecutionTarget('no-such-target')).rejects.toThrow(/no target/i);
  });

  it('creates a remote git worktree for the session when worktree: true is passed (issue #75)', async () => {
    await git(remoteWorkspace, ['init', '-b', 'main']);
    await git(remoteWorkspace, ['config', 'user.email', 'test@loombox.dev']);
    await git(remoteWorkspace, ['config', 'user.name', 'loombox test']);
    await execFileAsync(
      'git',
      ['-C', remoteWorkspace, 'commit', '--allow-empty', '-m', 'initial commit'],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'loombox test',
          GIT_AUTHOR_EMAIL: 'test@loombox.dev',
          GIT_COMMITTER_NAME: 'loombox test',
          GIT_COMMITTER_EMAIL: 'test@loombox.dev',
        },
      },
    );

    const amk = generateAmk();
    const accountId = 'acct-ssh-worktree';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-worktree',
      deviceId: 'device-node-ssh-worktree',
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
      worktree: true,
    });

    expect(session.target).toBe('ssh');
    expect(session.worktreePath).not.toBe(remoteWorkspace);
    expect(session.worktreePath).toBe(
      path.join(remoteWorkspace, '.loombox', 'worktrees', session.id),
    );
    expect(session.branch).toBe(`loombox/session-${session.id}`);

    const insideWorkTree = await git(session.worktreePath, ['rev-parse', '--is-inside-work-tree']);
    expect(insideWorkTree).toBe('true');
    const currentBranch = await git(session.worktreePath, ['branch', '--show-current']);
    expect(currentBranch).toBe(session.branch);

    // The agent itself was actually spawned inside the worktree, not
    // `remoteWorkspace`: prompting it round-trips fine, proving
    // `startWithChild` got the worktree path as its `cwd`/`workspacePath`.
    await expect(node.promptSession(session.id, 'hi from worktree')).resolves.toBeUndefined();
  });

  it('defaults ssh: sessions to running directly in projectPath when worktree is omitted (unchanged from before issue #75)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-no-worktree';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-no-worktree',
      deviceId: 'device-node-ssh-no-worktree',
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
    });

    expect(session.worktreePath).toBe(remoteWorkspace);
    expect(session.branch).toBe('');
  });

  it("lists an ssh: session's project directory over fs_list_request/fs_list_response, exactly like a local target (SPEC §7.4; issue #171)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-fs-list';

    await fsMkdir(pathJoin(remoteWorkspace, 'docs'), { recursive: true });
    await fsWriteFile(pathJoin(remoteWorkspace, 'docs', 'guide.md'), '# guide');
    await fsWriteFile(pathJoin(remoteWorkspace, 'top-level.txt'), 'hi');

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-fs-1',
      deviceId: 'device-node-ssh-fs-1',
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
    });

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-ssh-fs-1',
      devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const requestEnvelope = await encryptEnvelope(
      session.id,
      new TextEncoder().encode(JSON.stringify({ path: 'docs' })),
      key,
    ).then((envelope) => ({
      resourceId: envelope.resourceId,
      iv: toBase64(envelope.iv),
      ciphertext: toBase64(envelope.ciphertext),
      alg: 'AES-256-GCM' as const,
    }));
    phone.send({
      type: 'fs_list_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      targetId: 'devbox',
      requestId: 'req-ssh-docs',
      envelope: requestEnvelope,
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'fs_list_response' && (m as { requestId?: string }).requestId === 'req-ssh-docs',
    )) as {
      type: 'fs_list_response';
      envelope: { resourceId: string; iv: string; ciphertext: string };
    };
    const payload = await phoneOpen<{
      outcome: string;
      entries?: { name: string; kind: string; size: number }[];
    }>(session.id, response.envelope, key);
    expect(payload.outcome).toBe('ok');
    expect(payload.entries).toEqual([{ name: 'guide.md', kind: 'file', size: 7 }]);
  });
});
