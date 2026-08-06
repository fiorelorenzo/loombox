import { execFile, spawnSync } from 'node:child_process';
import { randomUUID, type webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
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
import {
  openRemoteSessionsSandbox,
  type RemoteSessionsSandbox,
} from './ssh/remote-sessions-test-sandbox';

const execFileAsync = promisify(execFile);

// The same hermetic fixture agent `node-daemon.test.ts`/`node-daemon-ssh.test.ts`
// exercise for their own unrelated coverage — reused here only for the ssh:
// path's proof that an allowlisted custom agent actually launches over the
// deploy-and-launch remote machinery. NOT what proves the acceptance bullet
// below: that is `omp`, a real ACP-speaking binary confirmed on this box's
// PATH (see the `local:` describe block).
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

type CryptoKey = webcrypto.CryptoKey;

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
    iv: new Uint8Array(Buffer.from(wire.iv, 'base64')),
    ciphertext: new Uint8Array(Buffer.from(wire.ciphertext, 'base64')),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** A minimal encrypted-PWA-like client over the global WebSocket, speaking the v1 handshake — kept local rather than shared, same convention `node-daemon.test.ts`/`node-daemon-ssh.test.ts` already follow for their own copies. */
class TestPhone {
  readonly messages: WireMessageV1[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, opts: { deviceId: string; devicePublicKey: string; authToken: string }) {
    this.socket = new WebSocket(url);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ready = promise;
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
      // Real delay, deliberately: this polls a live WebSocket fed by a real
      // relay + node over the network, which has no synchronous "a message
      // arrived" signal this test can await instead — fake timers can't
      // stand in for genuine async I/O here (`ts-no-test-timers`'s own
      // stated exception for integration tests against the real clock).
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

function waitForConnected(node: NodeDaemon): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  node.once('connected', resolve);
  return promise;
}

interface DecryptedSessionEvent {
  seq: number;
  kind: string;
  status?: string;
  reason?: string;
  options?: unknown[];
  text?: string;
}

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
    // Same real-clock polling as `TestPhone.waitFor` above, for the same
    // reason: `session_update` envelopes arrive asynchronously off a real
    // relay connection, with no other signal to await.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForSessionInList(
  phone: TestPhone,
  sessionId: string,
  timeoutMs = 5000,
): Promise<SessionWithPrivateEnvelope> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    // Same real-clock polling as `TestPhone.waitFor` above — `session_list`
    // has no push/ack this test can await instead, so it re-polls the
    // request/response round trip against the real relay.
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
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-custom-agent-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-custom-agent-state-test-'));
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

/**
 * D1-3 / issue #748: the node-side allowlist is the real security boundary
 * (`custom-agent.ts`'s own doc comment) — everything `custom-agent.test.ts`
 * already covers is the pure-function gate in isolation. These tests instead
 * drive it through the real wire entry point, `NodeDaemon.handleSessionCreate`
 * (a client's actual `session_create`, decrypted, routed, and launched, over
 * a real relay), which is what the issue's acceptance bullets are actually
 * about: does a real allowlisted binary come up, and is a disallowed one
 * refused with a reason the client can show, with no field on the wire able
 * to talk the node out of that refusal.
 */
/**
 * The real-binary acceptance test needs `omp` on PATH. It is there on the
 * devbox this was written on, and it is NOT there on a GitHub-hosted CI
 * runner, where the test spent 60s timing out and turned `main` red (issue
 * #748's own merge). Skipping when the binary is absent keeps the test
 * meaningful where it can run and honest where it cannot: every other test
 * in this file drives the same code path with a fixture agent, so the
 * allowlist gate itself is never left unverified.
 */
const ompOnPath = (() => {
  const result = spawnSync('sh', ['-c', 'command -v omp'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
})();

describe('NodeDaemon custom ACP agents, local: (issue #748)', () => {
  it.skipIf(!ompOnPath)(
    'a custom ACP binary on the local allowlist runs a full session, verified against the real `omp acp` binary (issue #748 acceptance)',
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-custom-agent-real-binary';
      // `--profile` isolates this run's auth/session/cache state from every
      // other `omp` process this box may have running concurrently (this
      // harness's own agents are themselves `omp acp` processes) — without
      // it, a fresh `omp acp` invocation can block for a long time on
      // profile-level contention with those, which is a resource-contention
      // artifact of running inside `omp`, not anything this test is
      // actually asserting. Confirmed directly against the real binary
      // before writing this test: `omp acp` alone (default profile) hung
      // past a minute on `session/new` in this environment; `omp acp
      // --profile=<isolated>` answered in under a second.
      const profileId = `loombox-custom-agent-test-${randomUUID()}`;

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-custom-real',
        deviceId: 'device-node-custom-real',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        customAgentAllowlist: ['omp'],
        supervisor: new AgentSupervisor({ providers: [] }),
      });
      await waitForConnected(node);

      const sessionId = 'sess-custom-real-1';
      const key = await derivePhoneSessionKey(amk, accountId, sessionId);
      const privateEnvelope = await phoneSeal(
        sessionId,
        {
          title: 'real omp custom agent',
          projectPath,
          customAgent: {
            name: 'Test Oh My Pi',
            command: 'omp',
            args: ['acp', `--profile=${profileId}`],
          },
        },
        key,
      );

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-custom-real',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({
        type: 'session_create',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        targetId: 'local',
        // D1-3's convention (`sessions.ts`'s `customAgent` doc comment):
        // `'custom'` names this a custom-agent session for a human reading
        // the wire; the node itself gates on the presence of `customAgent`
        // in the envelope, never on this string (proven by the
        // "cannot be bypassed" test below).
        provider: 'custom',
        privateEnvelope,
      });

      const entry = await waitForSessionInList(phone, sessionId, 10000);
      expect(entry.session.provider).toBe('custom');

      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
      await phone.waitFor((m) => m.type === 'session_announce');

      // Proof this is a FULL session, not just a spawned process: the
      // node only ever reaches `forwardInitialSessionState` (the source of
      // both events below) once `AgentSession.spawn()` completed the real
      // ACP `initialize` handshake AND `session/new` against the real
      // binary — never on a bare process start. `'awaiting_input'` is the
      // real agent's own reported attention state; `config_options`
      // carries the catalog `session/new`'s own wire result seeded
      // (verified above, live, to include `omp`'s real `mode`/`model`
      // categories — never faked/assumed here).
      const [status] = await waitForDecryptedKinds(
        phone,
        sessionId,
        key,
        ['session_status'],
        1,
        20000,
      );
      expect(status?.status).toBe('awaiting_input');

      const [configEvent] = await waitForDecryptedKinds(
        phone,
        sessionId,
        key,
        ['config_options'],
        1,
        5000,
      );
      expect(Array.isArray(configEvent?.options)).toBe(true);
      expect((configEvent?.options as Array<{ category?: string }>).length).toBeGreaterThan(0);
      expect(
        (configEvent?.options as Array<{ category?: string }>).some((o) => o.category === 'mode'),
      ).toBe(true);

      // Never refused, never errored: the allowlisted binary ran clean.
      expect(phone.messages.some((m) => m.type === 'session_update' && 'sessionId' in m)).toBe(
        true,
      );
    },
    30000,
  );

  it('a custom agent whose command is NOT on the local allowlist is refused with a reason naming the allowlist, through the real handleSessionCreate wire path (not just the pure-function gate)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-refused';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-custom-refused',
      deviceId: 'device-node-custom-refused',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      customAgentAllowlist: ['omp'],
      supervisor: new AgentSupervisor({ providers: [] }),
    });
    await waitForConnected(node);

    const sessionId = 'sess-custom-refused-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      {
        title: 'disallowed custom agent',
        projectPath,
        customAgent: { name: 'sneaky', command: '/bin/sh', args: ['-c', 'echo pwned'] },
      },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-custom-refused',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'custom',
      privateEnvelope,
    });

    await waitForSessionInList(phone, sessionId);

    // Never `session_resume`d — resyncs the full ring instead, exactly
    // like `node-daemon.test.ts`'s own "reports why an agent spawn fails
    // immediately" test, so this doesn't race the refusal against a live
    // subscribe.
    phone.send({ type: 'resync_request', protocolVersion: PROTOCOL_V1, sessionId, sinceSeq: 0 });
    const events = await waitForDecryptedKinds(phone, sessionId, key, ['session_status'], 2);
    expect(events[0]?.status).toBe('starting');
    expect(events[1]?.status).toBe('error');
    // The issue's own acceptance bullet, verbatim: a visible refusal
    // naming the allowlist as the reason, not a generic "error".
    expect(events[1]?.reason).toContain('/bin/sh');
    expect(events[1]?.reason).toContain('allowlist');
    expect(events[1]?.reason).toContain('LOOMBOX_CUSTOM_AGENT_ALLOWLIST');
    // And it never actually ran: no /bin/sh output ever reached the
    // transcript (there is none to reach — no bridge, no wireAgentSession,
    // ever existed for this session).
    expect(events.some((e) => e.kind !== 'session_status')).toBe(false);
  }, 15000);

  it('the refusal cannot be bypassed by naming a real, allowed provider id alongside the disallowed customAgent — the node gates on customAgent PRESENCE, never on the provider string', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-bypass-attempt';

    const supervisor = new AgentSupervisor({
      providers: [
        {
          id: 'test-echo',
          spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
          enrich: (update: unknown) => update,
        } as AcpProvider,
      ],
    });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-custom-bypass',
      deviceId: 'device-node-custom-bypass',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      customAgentAllowlist: ['omp'],
      supervisor,
    });
    await waitForConnected(node);

    const sessionId = 'sess-custom-bypass-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      {
        title: 'bypass attempt',
        projectPath,
        customAgent: { name: 'sneaky', command: '/bin/sh', args: [] },
      },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-custom-bypass',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    // `provider` names a real, already-registered, perfectly legitimate
    // provider id — the one field a naive gate might trust. The node
    // must still refuse: `resolveLaunchProviderId`/`launchReservedSshSession`
    // both check `customAgent`'s mere presence before ever consulting
    // `provider` at all (`node-daemon.ts`: "if (!customAgent) return
    // provider;").
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-echo',
      privateEnvelope,
    });

    await waitForSessionInList(phone, sessionId);
    phone.send({ type: 'resync_request', protocolVersion: PROTOCOL_V1, sessionId, sinceSeq: 0 });
    const events = await waitForDecryptedKinds(phone, sessionId, key, ['session_status'], 2);
    expect(events[0]?.status).toBe('starting');
    expect(events[1]?.status).toBe('error');
    expect(events[1]?.reason).toContain('allowlist');
    // Never fell back to actually running the named 'test-echo' provider.
    expect(events.some((e) => e.kind === 'agent_message_chunk')).toBe(false);
  }, 15000);
});

describe('NodeDaemon custom ACP agents, ssh: (issue #748)', () => {
  const SSH_TARGET = { id: 'devbox', kind: 'ssh' as const, label: 'Dev box', providers: [] };
  const SSH_TARGET_CONFIG = { id: 'devbox', label: 'Dev box', host: 'devbox.invalid', user: 'dev' };

  let remoteWorkspace: string;
  let remoteSessions: RemoteSessionsSandbox | undefined;

  beforeEach(async () => {
    remoteWorkspace = await mkdtemp(path.join(tmpdir(), 'loombox-custom-agent-ssh-'));
    remoteSessions = openRemoteSessionsSandbox();
  });

  afterEach(async () => {
    await remoteSessions?.close();
    remoteSessions = undefined;
    await rm(remoteWorkspace, { recursive: true, force: true });
  });

  it('an allowlisted custom agent runs a full session over the ssh: deploy-and-launch remote machinery — the same gate as local:, previously untested for this path', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-ssh-allowed';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-custom-ssh-allowed',
      deviceId: 'device-node-custom-ssh-allowed',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => remoteSessions!.createTransport(),
      remoteChildPollIntervalMs: 30,
      // `process.execPath` (this test runner's own `node` binary) is what
      // the allowlist actually matches — `launchReservedSshSession` gates
      // on `customAgent.command` exactly like `local:` does, before it
      // ever builds the remote shell command from `spawnConfig`.
      customAgentAllowlist: [process.execPath],
      supervisor: new AgentSupervisor({ providers: [] }),
    });

    const session = await node.createSession({
      projectPath: remoteWorkspace,
      provider: 'custom',
      targetId: 'devbox',
      title: 'ssh custom agent',
      customAgent: { name: 'Remote echo', command: process.execPath, args: [ECHO_FIXTURE] },
    });
    expect(session.target).toBe('ssh');

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-custom-ssh-allowed',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    // A real, full ACP round trip through the remote runner: prompting it
    // produces the fixture's own real streamed reply, proving
    // initialize + session/new + session/prompt all completed against
    // the allowlisted binary over the ssh: path.
    await node.promptSession(session.id, 'hi there');
    const chunks = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 2);
    expect(chunks.map((update) => update.text).join('')).toBe('Hello world');
  }, 20000);

  it('a custom agent whose command is NOT on the allowlist is refused over ssh: too, with the same visible reason — never a silent drop', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-ssh-refused';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-custom-ssh-refused',
      deviceId: 'device-node-custom-ssh-refused',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      targets: [SSH_TARGET],
      sshTargets: [SSH_TARGET_CONFIG],
      sshTransportFactory: () => remoteSessions!.createTransport(),
      remoteChildPollIntervalMs: 30,
      customAgentAllowlist: [process.execPath],
      supervisor: new AgentSupervisor({ providers: [] }),
    });

    const sessionId = 'sess-custom-ssh-refused-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      {
        title: 'ssh disallowed',
        projectPath: remoteWorkspace,
        customAgent: { name: 'sneaky remote', command: '/usr/bin/env', args: ['whoami'] },
      },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-custom-ssh-refused',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'devbox',
      provider: 'custom',
      privateEnvelope,
    });

    await waitForSessionInList(phone, sessionId);
    phone.send({ type: 'resync_request', protocolVersion: PROTOCOL_V1, sessionId, sinceSeq: 0 });
    const events = await waitForDecryptedKinds(phone, sessionId, key, ['session_status'], 2);
    expect(events[0]?.status).toBe('starting');
    expect(events[1]?.status).toBe('error');
    expect(events[1]?.reason).toContain('/usr/bin/env');
    expect(events[1]?.reason).toContain('allowlist');
  }, 15000);
});
