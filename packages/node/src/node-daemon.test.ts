import { execFile } from 'node:child_process';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
  type webcrypto,
} from 'node:crypto';
import { mkdir as fsMkdir, mkdtemp, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path, { join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type PermissionRequest,
  type SessionAnnounceV1,
  type SessionArchiveResponse,
  type SessionListV1,
  type SessionUpdateEnvelopeV1,
  type SessionWithPrivateEnvelope,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor, TerminalSupervisor, defaultPtySpawn } from '@loombox/supervisor';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';
import { SessionManager } from './session-manager';
import { McpConfigStore } from './mcp-config-store';
import { NodeMcpSecretManager } from './mcp-secrets';
import { NodeProjectEnvManager } from './project-env-secrets';
import { FakeTransport, type FakeExecHandler } from './ssh/fake-transport';
import type { SupervisorArtifactSource } from './ssh/supervisor-artifact';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

type CryptoKey = webcrypto.CryptoKey;

// Reuses the same hermetic fixture agent packages/providers/core,
// packages/providers/claude and packages/supervisor already exercise their
// tests against (not a real `claude` binary): relative path into the
// sibling package's test/fixtures, since it is deliberately not published
// via that package's `exports`.
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

// Issue #660: the realistic-timing sibling of ECHO_FIXTURE — many chunks
// (thinking, then answer) over real delay, not two chunks synchronously.
// Used specifically by the growth-while-open test below; every other test
// in this file keeps using ECHO_FIXTURE/echoProvider() for unrelated
// session-lifecycle coverage.
const STREAMING_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'streaming-acp-agent.mjs',
);

function streamingProvider(): AcpProvider {
  return {
    id: 'test-streaming',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [STREAMING_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

// The same config-option fixture packages/providers/core's own #179/#180
// tests exercise: advertises a two-category catalog at `initialize` and
// pushes an unprompted `config_option_update` on the prompt text
// "trigger-fallback" (see that fixture's own doc comment).
const CONFIG_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'config-acp-agent.mjs',
);

function configProvider(): AcpProvider {
  return {
    id: 'test-config',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [CONFIG_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

// Echoes back the `mcpServers` it actually received on `session/new`
// (`packages/providers/core`'s own mcp-servers.test.ts fixture, issue #190)
// when prompted with "echo-mcp-servers" — reused here to prove issues
// #187/#189's node-side resolution (McpConfigStore + NodeMcpSecretManager)
// actually reaches the ACP session, not just that the stores themselves
// work in isolation.
const MCP_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'mcp-acp-agent.mjs',
);

function mcpProvider(): AcpProvider {
  return {
    id: 'test-mcp',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [MCP_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

// Echoes back one of its own real `process.env` entries when prompted with
// "echo-env:<NAME>" (issue #258) — reused here to prove
// `NodeProjectEnvManager`'s node-side resolution actually reaches the real
// spawned child process's environment, not just that the store itself
// resolves correctly in isolation.
const ENV_ECHO_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'env-echo-acp-agent.mjs',
);

function envEchoProvider(): AcpProvider {
  return {
    id: 'test-env-echo',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ENV_ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

// Simulates a real agent's own MCP client rejecting `session/new` when a
// declared server named "bad-binary"/"bad-handshake" is present (issue
// #750, D2-2) — the exact `AcpClient: Internal error (code -32603): <name>:
// <detail>` shape verified against a real `omp acp` binary, so
// `attributeMcpFailure`'s classification/exclusion loop is exercised
// deterministically. See the fixture's own doc comment for the full
// contract.
const MCP_FAILING_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'mcp-failing-acp-agent.mjs',
);

function failingMcpProvider(): AcpProvider {
  return {
    id: 'test-mcp-failing',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [MCP_FAILING_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

// packages/supervisor's own crash fixture (issue #170's session_outcome
// coverage needs a real 'exited' attention transition, not just the
// 'awaiting_input' every other test here already gets from session
// creation) — reused by relative path across the package boundary exactly
// like ECHO_FIXTURE/CONFIG_FIXTURE/MCP_FIXTURE above reach into
// packages/providers/core/test/fixtures.
const CRASH_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'supervisor',
  'test',
  'fixtures',
  'crashing-acp-agent.mjs',
);

function crashProvider(): AcpProvider {
  return {
    id: 'test-crash',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [CRASH_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

// Issue #516's real repro, minified: a process that spawns successfully but
// never speaks the ACP handshake at all (no stdout, ever), standing in for
// "npm exec sat for nine minutes without completing the handshake" without
// this test suite actually waiting nine minutes. Self-exits after 3s so a
// test overriding `sessionStartTimeoutMs` far below that never leaves an
// orphaned child process behind once the assertion under test has run.
function hangProvider(): AcpProvider {
  return {
    id: 'test-hang',
    spawnConfig: () => ({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 3000)'],
    }),
    enrich: (update) => update,
  };
}

// packages/providers/core's own `session/request_permission` fixture (issue
// #178, also reused by packages/supervisor's own persistence tests) — issue
// #373's coverage needs a real live 'permission_required' attention
// transition, not just the crash-driven 'exited' one CRASH_FIXTURE gives
// above. Prompted with "request-permission", it sends one
// `session/request_permission` and awaits the response before finishing the
// turn — deliberately never answered by these tests (no `permission_response`
// wire handling is in scope for #373), so `node.promptSession(...)` is
// always fired without awaiting it (see the tests below).
const PERMISSION_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'permission-acp-agent.mjs',
);

function permissionProvider(): AcpProvider {
  return {
    id: 'test-permission',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [PERMISSION_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

// `@loombox/node`'s own `ssh/host-candidates.test.ts` fixture `~/.ssh/config`
// files (issue #475's ssh_discovery_request handler exercises the same real
// `discoverSshTargets()`, not a fake), reached by relative path one level up
// from this file's own `src/`.
const SSH_CONFIG_FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'ssh-config',
);

// -----------------------------------------------------------------------
// Test-only crypto helpers standing in for a phone/PWA client. These are
// deliberately NOT calls into this package's own `session-keys.ts`/
// `crypto-envelope.ts` — they reimplement the same *documented* v1
// derivation contract (session-keys.ts's doc comment: path
// `['session', accountId, sessionId]`) directly against `@loombox/crypto`'s
// primitives, so a passing test proves two independent parties interoperate,
// not just that this package agrees with itself.
// -----------------------------------------------------------------------

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

/** The directory picker's own derivation (issue #474) — `['target', accountId, targetId]`, mirroring `derivePhoneSessionKey` above but never the same key, even for the same account (see `NodeDaemon`'s `deriveTargetKey` doc comment). */
async function derivePhoneTargetKey(
  amk: Uint8Array,
  accountId: string,
  targetId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['target', accountId, targetId]);
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

/** Asserts a wire envelope's ciphertext bytes contain none of `plainSubstrings` verbatim — the relay-sees-only-ciphertext assertion. */
function assertOpaque(wire: EncryptedEnvelope, plainSubstrings: string[]): void {
  const raw = Buffer.from(wire.ciphertext, 'base64').toString('latin1');
  for (const needle of plainSubstrings) {
    expect(raw.includes(needle)).toBe(false);
  }
}

/** A minimal encrypted-PWA-like client over the global WebSocket, speaking the v1 handshake. */
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

  /** Waits until a message matching `predicate` has arrived (checking history first), or times out. */
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

  /** Waits until at least `count` messages match `predicate`. */
  async waitForCount(
    predicate: (message: WireMessageV1) => boolean,
    count: number,
    timeoutMs = 10000,
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

/** Waits until `node` has completed the relay handshake at least once. */
function waitForConnected(node: NodeDaemon): Promise<void> {
  return new Promise((resolve) => node.once('connected', resolve));
}

/** One `session_update` envelope, decrypted, tagged with its wire `seq`. */
interface DecryptedSessionEvent {
  seq: number;
  kind: string;
  text?: string;
  turnId?: string;
  stopReason?: string;
  status?: string;
  reason?: string;
  options?: unknown[];
  commands?: unknown[];
  /** `mcp_server_status`'s own payload field (issue #750, D2-2). */
  servers?: { name: string; ok: boolean; category?: string; reason?: string }[];
}

/**
 * Decrypts every `session_update` envelope seen so far for `sessionId` and
 * returns only the ones whose inner `kind` is in `kinds`, seq-sorted. Polls
 * until at least `count` match, or times out. Now that `@loombox/node` also
 * forwards `session_status`/`config_options`/`turn_started`/`turn_ended`
 * lifecycle events over the exact same `session_update` envelope a
 * transcript chunk rides (SPEC §7.13/§7.24/§8; issues #126/#128/#149), a raw
 * `type === 'session_update'` count is no longer the same thing as an
 * `agent_message_chunk` count — this is the robust replacement used
 * throughout this file wherever a test cares about one specific kind.
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

/** Polls `session_list_request` until `sessionId` shows up (client-initiated `session_create` has no direct ack). */
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
let projectPath: string;
// Every createNode() below passes this as `stateDir`, so its default-
// constructed `McpConfigStore`/`NodeMcpSecretManager` (issues #187/#189)
// never touch the real ~/.loombox/node — same discipline
// agent-supervisor.test.ts already applies to AgentSupervisor's own state
// dir.
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;
let phoneB: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();

  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-state-test-'));
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
  phoneB?.close();
  node = undefined;
  phone = undefined;
  phoneB = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon (protocol v1, E2E encrypted)', () => {
  it('announces a session with clear routing metadata and an encrypted title/path envelope, and pumps agent updates as ciphertext a resumed client can decrypt', async () => {
    const amk = generateAmk();
    const accountId = 'acct-announce-and-pump';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-1',
      deviceId: 'device-node-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({
      projectPath,
      provider: 'test-echo',
      title: 'my session',
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    // A. the phone observes the running session without having started it,
    // via the account-scoped snapshot — and the snapshot's clear metadata
    // carries no title/projectPath (SPEC §8's metadata boundary).
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const listMsg = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    const entry = listMsg.sessions.find((s) => s.session.id === session.id);
    expect(entry).toBeDefined();
    expect(entry?.session).not.toHaveProperty('title');
    expect(entry?.session).not.toHaveProperty('projectPath');
    expect(entry?.session.nodeId).toBe('node-1');
    expect(entry?.session.targetId).toBe('local');
    expect(entry?.session.accountId).toBe(accountId);
    expect(entry?.session.provider).toBe('test-echo');

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const decryptedMeta = await phoneOpen<{ title: string; projectPath: string; branch?: string }>(
      session.id,
      entry!.privateEnvelope,
      key,
    );
    expect(decryptedMeta).toEqual({
      title: 'my session',
      projectPath: session.projectPath,
      branch: `loombox/session-${session.id}`,
    });
    // The relay only ever carried this ciphertext: the title/path are not recoverable from it.
    assertOpaque(entry!.privateEnvelope, ['my session', session.projectPath]);

    // Subscribe (session_resume) so this client starts receiving live fan-out.
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    const announce = (await phone.waitFor(
      (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
    )) as SessionAnnounceV1;
    expect(announce.session).not.toHaveProperty('title');

    // B. output the phone did not initiate (an operator-side prompt via the
    // node's direct API) streams to it live, as ciphertext it can decrypt.
    await node.promptSession(session.id, 'hi there');

    // The turn's session_update envelopes now carry more than transcript
    // chunks: a turn_started, the two agent_message_chunk updates, and a
    // turn_ended settle the turn deterministically (SPEC §7.24; issue #128) —
    // waiting for turn_ended proves every earlier envelope in this turn's
    // sendQueue has already been sent, since they share one ordered chain.
    const [turnEnded] = await waitForDecryptedKinds(phone, session.id, key, ['turn_ended'], 1);
    expect(turnEnded).toMatchObject({ stopReason: 'end_turn' });
    expect(turnEnded!.turnId).toBeTruthy();

    const [turnStarted] = await waitForDecryptedKinds(phone, session.id, key, ['turn_started'], 1);
    expect(turnStarted!.turnId).toBe(turnEnded!.turnId);
    expect(turnStarted!.seq).toBeLessThan(turnEnded!.seq);

    const chunks = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 2);

    // The relay never carried plaintext: the raw frame has only an opaque
    // envelope, no 'kind'/'text' fields sitting next to it.
    const allUpdates = phone.messages.filter(
      (m): m is SessionUpdateEnvelopeV1 =>
        m.type === 'session_update' && m.sessionId === session.id,
    );
    for (const message of allUpdates) {
      expect(message).not.toHaveProperty('text');
      expect(message).not.toHaveProperty('kind');
      assertOpaque(message.envelope, ['Hello', 'world']);
    }

    expect(chunks.map((update) => update.text).join('')).toBe('Hello world');
  });

  it('streams a growing transcript across the full real relay/node pipeline while the turn is still open, not only once turn_ended arrives (issue #660)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-streaming-pipeline';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-streaming',
      deviceId: 'device-node-streaming',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [streamingProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-streaming' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-streaming',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const t0 = Date.now();
    const thoughtCounts = new Set<number>();
    const messageCounts = new Set<number>();
    const samplesByTime: number[] = [];

    void node.promptSession(session.id, 'go');

    // Samples the raw wire stream — before it's even decrypted into a
    // specific kind count — while the turn is still open, matching this
    // file's own `waitForDecryptedKinds` polling convention (real relay +
    // real spawned process, no fake timer can stand in for that). Every
    // other test in this file only ever inspects state after `turn_ended`;
    // this samples repeatedly *during* the turn instead.
    let turnEnded = false;
    while (!turnEnded) {
      const decryptedSoFar = await Promise.all(
        phone.messages
          .filter(
            (m): m is SessionUpdateEnvelopeV1 =>
              m.type === 'session_update' && m.sessionId === session.id,
          )
          .map((m) => phoneOpen<{ kind: string; text?: string }>(session.id, m.envelope, key)),
      );
      thoughtCounts.add(decryptedSoFar.filter((d) => d.kind === 'agent_thought_chunk').length);
      messageCounts.add(decryptedSoFar.filter((d) => d.kind === 'agent_message_chunk').length);
      samplesByTime.push(Date.now() - t0);
      turnEnded = decryptedSoFar.some((d) => d.kind === 'turn_ended');
      if (!turnEnded) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // A batch-until-turn-end regression collapses each of these to `{0}`
    // (nothing decrypted until the very last poll, which then sees
    // everything at once) — a genuinely streaming pipeline is sampled
    // mid-growth multiple times before the loop's own final, complete pass.
    expect(thoughtCounts.size).toBeGreaterThan(2);
    expect(messageCounts.size).toBeGreaterThan(2);
    expect(samplesByTime.at(-1)! - samplesByTime[0]!).toBeGreaterThan(50);

    const chunks = await waitForDecryptedKinds(
      phone,
      session.id,
      key,
      ['agent_thought_chunk', 'agent_message_chunk'],
      18,
    );
    // Each wire-level chunk carries only its own delta text (the reducer's
    // accumulation into one coalesced item happens client-side, e.g.
    // `providers/core`'s `reduceMessageChunk` — see that module's own doc
    // comment) — join them in arrival order, exactly like every other
    // `agent_message_chunk` assertion in this file already does.
    const thoughtText = chunks
      .filter((c) => c.kind === 'agent_thought_chunk')
      .map((c) => c.text)
      .join('');
    const messageText = chunks
      .filter((c) => c.kind === 'agent_message_chunk')
      .map((c) => c.text)
      .join('');
    expect(thoughtText).toBe('Thinking step by step about this request.');
    expect(messageText).toBe(
      'The answer unfolds gradually across several words to prove real streaming.',
    );
  });

  it('forwards the session-status snapshot, the config-option catalog, and an agent-initiated unprompted fallback as encrypted session_update events (SPEC §7.13/§7.24, §8; issues #126/#149)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-config-wire';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-config',
      deviceId: 'device-node-config',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [configProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-config' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-config',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');
    // The initial session_status/config_options snapshot is forwarded at
    // session-creation time (`wireAgentSession`), before this phone
    // subscribed — backfill it via the existing resync mechanism, exactly
    // like a client that opens a session it didn't just create would.
    // Two session_status events are now buffered from creation (issue
    // #516): the early 'starting' sent before the agent existed, then the
    // real snapshot once it came up — this test cares about the latter.
    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      sinceSeq: 0,
    });

    const statusEvents = await waitForDecryptedKinds(phone, session.id, key, ['session_status'], 2);
    expect(statusEvents[0]).toMatchObject({ kind: 'session_status', status: 'starting' });
    expect(statusEvents[1]).toMatchObject({ kind: 'session_status', status: 'awaiting_input' });

    const [initialCatalog] = await waitForDecryptedKinds(
      phone,
      session.id,
      key,
      ['config_options'],
      1,
    );
    // Three categories, in the order the agent sent them, mapped from the real
    // ACP wire shape (`{id, name, category, type, currentValue, options}`) onto
    // this codebase's `{category, current, choices}` — issue #705. The fixture
    // used to hand back the internal shape directly, which is why it agreed
    // with the bug: `thought_level` never appeared at all, and the ids were
    // invented short names rather than the real provider-qualified ones.
    //
    // `id` and `type` ride along because writing an option back needs them
    // (issue #707): the agent's `configId` is the entry's own `id`, which is
    // NOT its category — sending the category is rejected outright. So they
    // reach the client too rather than being dropped at the mapping.
    expect(initialCatalog!.options).toEqual([
      {
        id: 'mode',
        type: 'select',
        category: 'mode',
        current: 'default',
        choices: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      {
        id: 'model',
        type: 'select',
        category: 'model',
        current: 'anthropic/claude-sonnet-5',
        choices: [
          { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
          { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ],
      },
      {
        // The clearest case of the id-vs-category split: this entry's own
        // `id` is 'thinking' while its `category` is 'thought_level'. The
        // mapping keys on category, and #707 sources `configId` from `id`.
        id: 'thinking',
        type: 'select',
        category: 'thought_level',
        current: 'auto',
        choices: [
          { id: 'off', name: 'Off' },
          { id: 'auto', name: 'Auto' },
        ],
      },
      {
        // A category this client has never heard of. The mapping is required
        // to pass it through untouched rather than drop it (`AcpConfigOption`
        // is typed for exactly this), and asserting it HERE, at the node's
        // own wire boundary, is what proves the guarantee survives the whole
        // way to a client rather than only inside `mapConfigOptions`.
        id: 'reasoning_style_v3',
        type: 'select',
        category: 'reasoning_style_v3',
        current: 'balanced',
        choices: [
          { id: 'balanced', name: 'Balanced' },
          { id: 'aggressive', name: 'Aggressive' },
        ],
      },
    ]);

    // The agent changes its own config mid-turn, unprompted — this must land
    // as the distinct 'config_option_update' wire kind, not 'config_options'
    // (issue #149's "two missing acceptance bullets": the unprompted push).
    await node.promptSession(session.id, 'trigger-fallback');
    const [fallback] = await waitForDecryptedKinds(
      phone,
      session.id,
      key,
      ['config_option_update'],
      1,
    );
    const fallbackOptions = fallback!.options as { category: string; current: string }[];
    expect(fallbackOptions.find((o) => o.category === 'model')?.current).toBe(
      'anthropic/claude-haiku-4-5',
    );

    // The relay never carried plaintext for any of the above.
    for (const message of phone.messages.filter(
      (m): m is SessionUpdateEnvelopeV1 =>
        m.type === 'session_update' && m.sessionId === session.id,
    )) {
      assertOpaque(message.envelope, ['sonnet', 'haiku', 'awaiting_input']);
    }
  });

  it('forwards the agent-declared available-command catalog as an encrypted available_commands_update session_update, preserving an unrecognized field on a command (issue #741)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-commands-wire';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-commands',
      deviceId: 'device-node-commands',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [configProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-config' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-commands',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    // The config fixture never sends available_commands_update on its own
    // (unlike config_options, seeded at session/new) — nothing arrives
    // until this prompt (issue #741's "declares none is empty, not an
    // error": no event at all here means the client-side store simply
    // stays at its own default `[]`, asserted directly against
    // AvailableCommandsStore/AgentSession in providers-core/supervisor's
    // own unit tests rather than re-proven at this wire layer).
    await node.promptSession(session.id, 'trigger-commands');

    const [update] = await waitForDecryptedKinds(
      phone,
      session.id,
      key,
      ['available_commands_update'],
      1,
    );
    expect(update!.commands).toEqual([
      { name: 'model', description: 'Show current model selection' },
      {
        name: 'security',
        description: 'Run a security scan',
        input: { hint: '<plan|scan|status>' },
        // Unrecognized/future field, round-tripped through the wire
        // unchanged rather than dropped (issue #741).
        icon: 'shield',
      },
    ]);

    // The relay never carried plaintext for any of the above.
    for (const message of phone.messages.filter(
      (m): m is SessionUpdateEnvelopeV1 =>
        m.type === 'session_update' && m.sessionId === session.id,
    )) {
      assertOpaque(message.envelope, ['security', 'shield']);
    }
  });

  it("delivers a phone's encrypted prompt_inject to the owning session, producing a new turn of ciphertext updates", async () => {
    const amk = generateAmk();
    const accountId = 'acct-prompt-inject';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-2',
      deviceId: 'device-node-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(session.id, { text: 'go do the thing' }, key);
    assertOpaque(envelope, ['go do the thing']);
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-1',
      envelope,
    });

    const chunks = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 2);
    expect(chunks.map((update) => update.text).join('')).toBe('Hello world');
  });

  it('creates a session from a client session_create, routed via the target the node announced, and the resulting session is fully usable', async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-create';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-3',
      deviceId: 'device-node-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node); // ensures target_announce landed before session_create routing needs it

    const sessionId = 'sess-from-client-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'client session', projectPath },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-echo',
      privateEnvelope,
    });

    const entry = await waitForSessionInList(phone, sessionId);
    expect(entry.session.nodeId).toBe('node-3');
    expect(entry.session.provider).toBe('test-echo');
    const decryptedMeta = await phoneOpen<{ title: string; projectPath: string; branch?: string }>(
      sessionId,
      entry.privateEnvelope,
      key,
    );
    expect(decryptedMeta).toEqual({
      title: 'client session',
      projectPath,
      branch: `loombox/session-${sessionId}`,
    });

    // The session is a real, working one: prompting it directly produces output.
    await node.promptSession(sessionId, 'hi');
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
    await phone.waitFor((m) => m.type === 'session_announce');
    await phone.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === sessionId,
      1,
    );
  });

  it('announces the session and a "starting" session_status before the agent is ready (issue #516)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-starting';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-starting',
      deviceId: 'device-node-starting',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const sessionId = 'sess-starting-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(sessionId, { title: 'starting', projectPath }, key);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-starting',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-echo',
      privateEnvelope,
    });

    // On the board (relay's session_list, sourced from session_announce)
    // immediately, well before this assertion cares what the agent is doing.
    await waitForSessionInList(phone, sessionId);

    // `session_update` only fans out live to a client already subscribed
    // (`session_resume`) — this phone never resumed, so it asks the relay's
    // resync ring for everything buffered since seq 0 instead, exactly like
    // a client catching up after being offline the whole time.
    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      sinceSeq: 0,
    });
    const events = await waitForDecryptedKinds(phone, sessionId, key, ['session_status'], 2);
    expect(events[0]?.status).toBe('starting');
    expect(events[1]?.status).not.toBe('starting');
  }, 15000);

  it('bounds an agent spawn that never resolves: the session reaches "error" within the timeout, and stays present and archivable (issue #516)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-start-timeout';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-timeout',
      deviceId: 'device-node-timeout',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [hangProvider()] }),
      // Real repro was 9 minutes; this test only needs the race to resolve
      // well inside its own timeout budget, not to reproduce the real delay.
      sessionStartTimeoutMs: 200,
    });
    await waitForConnected(node);

    const sessionId = 'sess-timeout-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'hangs forever', projectPath },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-timeout',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-hang',
      privateEnvelope,
    });

    // The session exists on the board immediately, before the agent (which
    // never comes up) would ever have been "ready".
    await waitForSessionInList(phone, sessionId);

    // See the "starting" test's comment: this phone never `session_resume`d,
    // so it resyncs the full ring instead of relying on live fanout. The
    // 'error' status lands only once `sessionStartTimeoutMs` actually
    // elapses, an async event with no signal this test can await directly,
    // so this re-sends the resync request until both events are buffered —
    // the same "poll the real observable state" pattern `waitForSessionInList`
    // above already uses for the same reason.
    let events: Awaited<ReturnType<typeof waitForDecryptedKinds>> = [];
    const deadline = Date.now() + 5000;
    for (;;) {
      phone.send({
        type: 'resync_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        sinceSeq: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const seen = await waitForDecryptedKinds(
        phone,
        sessionId,
        key,
        ['session_status'],
        0,
        0,
      ).catch(() => []);
      // Each poll re-sends resync_request, which replays the whole ring
      // again — dedupe by `seq` (the relay's own authoritative ordering)
      // rather than trusting `phone.messages`' raw length.
      const bySeq = new Map(seen.map((event) => [event.seq, event]));
      events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      if (events.some((event) => event.status === 'error')) break;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for session ${sessionId} to reach "error"`);
      }
    }
    expect(events[0]?.status).toBe('starting');
    expect(events[1]?.status).toBe('error');
    // Issue #730: the reason a `console.warn` used to be the only trace of
    // now rides the wire too — a client can show WHY, not just that.
    expect(events[1]?.reason).toMatch(/did not complete within/);

    // Still present and archivable — not a silent disappearance, and no
    // worktree left untracked (issue #515's failure mode, avoided here).
    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req_archive_timeout',
      sessionId,
      removeWorktree: true,
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'session_archive_response',
    )) as SessionArchiveResponse;
    expect(response.result).toEqual({ outcome: 'ok' });
  }, 15000);

  it('reports why an agent spawn fails immediately, not just a console warning (issue #730)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-start-immediate-failure';

    // A real supervisor with only `start` swapped (same shape as "says so
    // when an agent spawn fails after it had already timed out" below) —
    // rejects right away, no timeout involved, so this exercises
    // `launchLocalSession`'s ordinary catch path, not `startAgentWithTimeout`'s
    // race.
    const supervisor = new AgentSupervisor({ providers: [] });
    supervisor.start = () =>
      Promise.reject(new Error('spawn ENOENT: claude-code not found on PATH'));

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-immediate-failure',
      deviceId: 'device-node-immediate-failure',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor,
    });
    await waitForConnected(node);

    const sessionId = 'sess-immediate-failure-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'spawn fails immediately', projectPath },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-immediate-failure',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-immediate-failure',
      privateEnvelope,
    });

    // On the board immediately, exactly like the "starting"/"timeout"
    // tests above — before the spawn attempt (which fails synchronously
    // on the next tick) has even been reported.
    await waitForSessionInList(phone, sessionId);

    // This phone never `session_resume`d, so it resyncs the full ring
    // instead of relying on live fanout (see the "starting" test's own
    // comment for why).
    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      sinceSeq: 0,
    });
    const events = await waitForDecryptedKinds(phone, sessionId, key, ['session_status'], 2);
    expect(events[0]?.status).toBe('starting');
    expect(events[1]?.status).toBe('error');
    // Issue #730's acceptance: the client gets a reason it can read, not
    // just a `console.warn` on the node.
    expect(events[1]?.reason).toBe('spawn ENOENT: claude-code not found on PATH');
  }, 15000);

  it('says so when an agent spawn fails after it had already timed out, instead of dropping it on the floor (issue #516)', async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      const amk = generateAmk();
      const accountId = 'acct-session-start-late-failure';

      // `Promise.race` subscribes to both sides, so a spawn that rejects
      // after the timeout won is handled and then discarded - no crash, but
      // no trace either. Silence is exactly how #511 and #516 stayed hidden,
      // so the one thing this must not do is nothing.
      //
      // The spawn is a hand-held promise rather than a delayed one: the test
      // fires the late rejection itself, after the timeout has demonstrably
      // already won, so the ordering this depends on is enforced rather than
      // hoped for.
      const spawn = Promise.withResolvers<never>();
      // A real supervisor with only `start` swapped: `NodeDaemon`'s
      // constructor wires itself into `setAttachmentChannel`, so a bare
      // object literal is not a substitute for one.
      const supervisor = new AgentSupervisor({ providers: [] });
      supervisor.start = () => spawn.promise;

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-late-failure',
        deviceId: 'device-node-late-failure',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor,
        sessionStartTimeoutMs: 30,
      });
      await waitForConnected(node);

      await expect(
        node.createSession({ projectPath, provider: 'test-late-failure' }),
      ).rejects.toThrow(/did not complete within/);

      spawn.reject(new Error('agent died long after we gave up'));

      // The rejection is delivered on the microtask queue; one macrotask is
      // strictly past it. No duration to tune, so nothing here gets slower
      // or racier on a loaded machine.
      const flushed = Promise.withResolvers<void>();
      setImmediate(() => flushed.resolve());
      await flushed.promise;

      expect(
        warnings.some(
          (line) =>
            line.includes('already timed out') && line.includes('agent died long after we gave up'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 15000);

  it("threads the private envelope's worktree: false into an in-place session (issue #507)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-create-worktree-false';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-worktree-false',
      deviceId: 'device-node-worktree-false',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const sessionId = 'sess-worktree-false';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'in place from client', projectPath, worktree: false },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-worktree-false',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-echo',
      privateEnvelope,
    });

    await waitForSessionInList(phone, sessionId);

    // In place: no new worktree was added under projectPath...
    const worktreeList = await git(projectPath, ['worktree', 'list', '--porcelain']);
    expect(worktreeList.split('\n\n').filter((entry) => entry.trim())).toHaveLength(1);

    // ...and it reserved projectPath for same-folder safety (SPEC §7.2)
    // exactly like a direct `worktree: false` session would: a second
    // in-place session on the same folder is refused.
    await expect(
      node.createSession({ projectPath, provider: 'test-echo', worktree: false }),
    ).rejects.toThrow(/already running/i);
  });

  it('resolves and threads the actual current branch for an in-place session, live off disk (issue #738, B3-3)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-create-inplace-branch';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-inplace-branch',
      deviceId: 'device-node-inplace-branch',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    // The project folder is on a real, non-default branch — never a
    // client-supplied value, this only ever reaches the wire because the
    // node itself probed `projectPath`'s own `HEAD`.
    await git(projectPath, ['checkout', '-b', 'feature/wire-the-branch']);

    const sessionId = 'sess-inplace-branch';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'in place, real branch', projectPath, worktree: false },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-inplace-branch',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-echo',
      privateEnvelope,
    });

    const entry = await waitForSessionInList(phone, sessionId);
    const decryptedMeta = await phoneOpen<{ title: string; projectPath: string; branch?: string }>(
      sessionId,
      entry.privateEnvelope,
      key,
    );
    expect(decryptedMeta.branch).toBe('feature/wire-the-branch');
  });

  it("threads the private envelope's worktree: true into an isolated worktree session (issue #507)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-create-worktree-true';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-worktree-true',
      deviceId: 'device-node-worktree-true',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const sessionId = 'sess-worktree-true';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'isolated from client', projectPath, worktree: true },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-worktree-true',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-echo',
      privateEnvelope,
    });

    await waitForSessionInList(phone, sessionId);

    const worktreePath = pathJoin(projectPath, '.loombox', 'worktrees', sessionId);
    const insideWorkTree = await git(worktreePath, ['rev-parse', '--is-inside-work-tree']);
    expect(insideWorkTree).toBe('true');
    const branch = await git(worktreePath, ['branch', '--show-current']);
    expect(branch).toBe(`loombox/session-${sessionId}`);
  });

  it('resyncs a client after it drops: the relay replays buffered ciphertext for the seq range it missed', async () => {
    const amk = generateAmk();
    const accountId = 'acct-resync';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-4',
      deviceId: 'device-node-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    await node.promptSession(session.id, 'first turn');
    // turn_ended is deterministically the LAST envelope this node sends for
    // a turn (SPEC §7.24; issue #128): waiting for it proves every earlier
    // envelope of "first turn" (turn_started, status transitions, both
    // chunks) has already been queued/sent, so its seq is a safe resync
    // watermark for "everything up to and including first turn".
    const [firstTurnEnded] = await waitForDecryptedKinds(phone, session.id, key, ['turn_ended'], 1);
    const lastSeenSeq = firstTurnEnded!.seq;

    // The phone drops (network loss) without unsubscribing.
    phone.close();

    // The node keeps working while the phone is gone; the relay still
    // buffers these encrypted updates in its per-session resync ring even
    // though nobody is currently subscribed to receive them live.
    await node.promptSession(session.id, 'second turn, while the phone was offline');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The phone reconnects and resyncs from where it left off.
    phoneB = new TestPhone(relay.url, {
      deviceId: 'device-phone-4', // same device identity reconnecting
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phoneB.ready;
    phoneB.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phoneB.waitFor((m) => m.type === 'session_announce');
    phoneB.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      sinceSeq: lastSeenSeq,
    });

    // Wait for the second turn's own turn_ended to arrive via the replay,
    // proving that full turn (not just its chunks) was resynced.
    await waitForDecryptedKinds(phoneB, session.id, key, ['turn_ended'], 1);

    const replayed = phoneB.messages.filter(
      (m): m is SessionUpdateEnvelopeV1 =>
        m.type === 'session_update' && m.sessionId === session.id,
    );
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((m) => m.seq > lastSeenSeq)).toBe(true);

    const replayedChunks = await waitForDecryptedKinds(
      phoneB,
      session.id,
      key,
      ['agent_message_chunk'],
      2,
    );
    expect(replayedChunks.map((update) => update.text).join('')).toBe('Hello world');
    for (const message of replayed) {
      assertOpaque(message.envelope, ['Hello', 'world']);
    }
  });

  it('reconnects after the relay connection drops and re-announces its targets and sessions, without a process restart', async () => {
    const amk = generateAmk();
    const accountId = 'acct-reconnect';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-5',
      deviceId: 'device-node-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      reconnect: { initialBackoffMs: 20, maxBackoffMs: 200 },
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');
    expect(phone.count((m) => m.type === 'session_announce')).toBe(1);

    // The relay's session/target STORE survives a node disconnect (it is a
    // ciphertext store, not connection-scoped state) — only the *routing*
    // entry mapping this node's id to a live connection is cleared when its
    // socket drops. So the real, observable effect of "reconnect
    // re-announces" in v1 is that ROUTING to this node works again after a
    // drop, not an unsolicited push to an already-subscribed client (the
    // relay never fans a node's `session_announce`/`target_announce` out to
    // clients at all — a client only ever receives one via its own
    // `session_resume`/`session_list_request`). Prove routing is restored by
    // driving a fresh client-initiated `prompt_inject` through the relay
    // after the drop and confirming it still reaches the agent.
    const connectedAgain = new Promise<void>((resolve) => node!.once('connected', resolve));
    node.simulateRelayDrop();
    await connectedAgain;

    const envelope = await phoneSeal(session.id, { text: 'after reconnect' }, key);
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-after-reconnect',
      envelope,
    });

    const [chunk] = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 1);
    expect(chunk!.kind).toBe('agent_message_chunk');
  });

  it('exposes the default local target through getExecutionTarget() (issue #69)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-local-execution-target';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-6',
      deviceId: 'device-node-6',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const executionTarget = await node.getExecutionTarget('local');
    expect(executionTarget.kind).toBe('local');

    const result = await executionTarget.exec(process.execPath, [
      '-e',
      "process.stdout.write('hello from local target')",
    ]);
    expect(result.stdout).toBe('hello from local target');
    expect(result.exitCode).toBe(0);

    await expect(node.getExecutionTarget('does-not-exist')).rejects.toThrow(/no target/i);
  });
});

/**
 * Issue #718: the node used to drop `config_option` in `handleInbound`'s
 * `default:` case, so the optimistic client-side update (before this issue,
 * `RelayClient.setConfigOption`) was the only thing that ever happened —
 * the agent never heard about it. These drive the real wire message
 * through `NodeDaemon.handleInbound` -> `AgentSession.setConfigOption` ->
 * `AcpClient.setConfigOption` (issue #707's real request/response shape)
 * against `CONFIG_FIXTURE`, the same fixture #705/#707's own tests use —
 * nothing here stands in for `NodeDaemon`, the wire protocol, or the ACP
 * client; only the agent process itself is a fixture. See this file's
 * `describe('NodeDaemon (protocol v1, E2E encrypted)')` config-options test
 * above for the same fixture's initial-catalog/unprompted-fallback
 * coverage — this describe block is what actually calls `setConfigOption`,
 * a real ACP round trip.
 */
describe('NodeDaemon config_option (SPEC §7.24; issue #718)', () => {
  it(
    "sets the model and the thinking effort through a real config_option round trip — the exact wire message the old default: case silently dropped, replying config_option_result: ok and reflecting each new value in the agent's own config_options push (the 'read it back' proof)",
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-config-option-live';

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-config-option',
        deviceId: 'device-node-config-option',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [configProvider()] }),
      });

      const session = await node.createSession({ projectPath, provider: 'test-config' });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-config-option',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');
      // The initial config_options snapshot is forwarded at session-
      // creation time (`wireAgentSession`), before this phone subscribed —
      // backfill it via resync, exactly like the config-wire test above
      // this describe block does, so the pushes below are unambiguously
      // the RESULT of this test's own sets, not the initial snapshot.
      phone.send({
        type: 'resync_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        sinceSeq: 0,
      });
      await waitForDecryptedKinds(phone, session.id, key, ['config_options'], 1);

      phone.send({
        type: 'config_option',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        category: 'model',
        optionId: 'anthropic/claude-haiku-4-5',
      });
      const modelResult = (await phone.waitFor(
        (m) => m.type === 'config_option_result' && m.category === 'model',
      )) as Extract<WireMessageV1, { type: 'config_option_result' }>;
      expect(modelResult).toMatchObject({ sessionId: session.id, category: 'model' });
      expect(modelResult.result).toEqual({ outcome: 'ok' });

      const afterModel = await waitForDecryptedKinds(phone, session.id, key, ['config_options'], 2);
      const modelOption = (afterModel[1]!.options as { category: string; current: string }[]).find(
        (option) => option.category === 'model',
      );
      expect(modelOption?.current).toBe('anthropic/claude-haiku-4-5');

      phone.send({
        type: 'config_option',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        category: 'thought_level',
        optionId: 'off',
      });
      const thinkingResult = (await phone.waitFor(
        (m) => m.type === 'config_option_result' && m.category === 'thought_level',
      )) as Extract<WireMessageV1, { type: 'config_option_result' }>;
      expect(thinkingResult.result).toEqual({ outcome: 'ok' });

      const afterThinking = await waitForDecryptedKinds(
        phone,
        session.id,
        key,
        ['config_options'],
        3,
      );
      const thinkingOption = (
        afterThinking[2]!.options as { category: string; current: string }[]
      ).find((option) => option.category === 'thought_level');
      expect(thinkingOption?.current).toBe('off');
    },
  );

  it(
    "a rejected config_option (an unsupported value the real ACP wire shape refuses) replies config_option_result: error carrying the agent's own rejection reason, and pushes no new catalog",
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-config-option-rejected';

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-config-option-reject',
        deviceId: 'device-node-config-option-reject',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [configProvider()] }),
      });

      const session = await node.createSession({ projectPath, provider: 'test-config' });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-config-option-reject',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');
      phone.send({
        type: 'resync_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        sinceSeq: 0,
      });
      await waitForDecryptedKinds(phone, session.id, key, ['config_options'], 1);
      const sessionUpdatesBefore = phone.count(
        (m) => m.type === 'session_update' && m.sessionId === session.id,
      );

      phone.send({
        type: 'config_option',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        category: 'model',
        optionId: 'not-a-real-model',
      });
      const result = (await phone.waitFor((m) => m.type === 'config_option_result')) as Extract<
        WireMessageV1,
        { type: 'config_option_result' }
      >;
      expect(result.category).toBe('model');
      expect(result.result.outcome).toBe('error');
      if (result.result.outcome === 'error') {
        expect(result.result.message).toMatch(/Unsupported value: not-a-real-model/);
      }

      // The rejection produced no new catalog (or any other session_update)
      // push — waiting past the point a bug would have produced one is the
      // only proof available here, since a correct implementation makes
      // nothing happen (mirrors this file's own `waitForDecryptedKinds`-
      // adjacent "prove absence" checks).
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 200);
      await promise;
      expect(phone.count((m) => m.type === 'session_update' && m.sessionId === session.id)).toBe(
        sessionUpdatesBefore,
      );
    },
  );

  it("a config_option for a session reloaded 'disconnected' after a restart (issue #702's now-real state) replies config_option_result: error instead of being silently dropped", async () => {
    const amk = generateAmk();
    const accountId = 'acct-config-option-disconnected';

    const beforeRestart = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-config-option-disc',
      deviceId: 'device-node-config-disc-before',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [configProvider()] }),
    });
    const session = await beforeRestart.createSession({ projectPath, provider: 'test-config' });
    // "The restart": tears every bridge down, never touching the on-disk
    // session record — mirrors the #702 reattach describe block's own
    // `beforeRestart.close()` exactly.
    beforeRestart.close();

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-config-option-disc',
      deviceId: 'device-node-config-disc-after',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [configProvider()] }),
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-config-disc',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    phone.send({
      type: 'config_option',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      category: 'model',
      optionId: 'anthropic/claude-haiku-4-5',
    });
    const result = (await phone.waitFor((m) => m.type === 'config_option_result', 2000)) as Extract<
      WireMessageV1,
      { type: 'config_option_result' }
    >;
    expect(result.category).toBe('model');
    expect(result.result.outcome).toBe('error');
    if (result.result.outcome === 'error') {
      expect(result.result.message).toMatch(/no live agent|disconnected/i);
    }
  });
});

describe('NodeDaemon fs-list (read-only file-tree panel, SPEC §7.4; issue #171)', () => {
  it("lists a local session's project root, and a nested directory, over the encrypted fs_list_request/fs_list_response pair", async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-list-local';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fs-1',
      deviceId: 'device-node-fs-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    // Populate the session's own worktree (not projectPath — the isolated
    // worktree issue #75 already gives every local session by default) with
    // a nested tree the fs-list request should reveal lazily.
    await fsWriteFile(pathJoin(session.worktreePath, 'README.md'), '# hi');
    await fsMkdir(pathJoin(session.worktreePath, 'src'));
    await fsWriteFile(pathJoin(session.worktreePath, 'src', 'index.ts'), 'export {};');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fs-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const rootRequestEnvelope = await phoneSeal(session.id, { path: '' }, key);
    assertOpaque(rootRequestEnvelope, ['README.md', 'src', session.worktreePath]);
    phone.send({
      type: 'fs_list_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      targetId: 'local',
      requestId: 'req-root',
      envelope: rootRequestEnvelope,
    });

    const rootResponse = (await phone.waitFor(
      (m) =>
        m.type === 'fs_list_response' && (m as { requestId?: string }).requestId === 'req-root',
    )) as {
      type: 'fs_list_response';
      sessionId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    assertOpaque(rootResponse.envelope, ['README.md', 'index.ts', session.worktreePath]);
    const rootPayload = await phoneOpen<{
      outcome: string;
      path: string;
      entries?: { name: string; kind: string; size: number }[];
    }>(session.id, rootResponse.envelope, key);
    expect(rootPayload.outcome).toBe('ok');
    const rootNames = rootPayload.entries?.map((e) => e.name).sort();
    expect(rootNames).toContain('README.md');
    expect(rootNames).toContain('src');
    const readme = rootPayload.entries?.find((e) => e.name === 'README.md');
    expect(readme).toMatchObject({ kind: 'file', size: 4 });
    const src = rootPayload.entries?.find((e) => e.name === 'src');
    expect(src?.kind).toBe('dir');

    // Lazy-expand: a second request for the nested directory only.
    const nestedRequestEnvelope = await phoneSeal(session.id, { path: 'src' }, key);
    phone.send({
      type: 'fs_list_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      targetId: 'local',
      requestId: 'req-src',
      envelope: nestedRequestEnvelope,
    });
    const nestedResponse = (await phone.waitFor(
      (m) => m.type === 'fs_list_response' && (m as { requestId?: string }).requestId === 'req-src',
    )) as { type: 'fs_list_response'; envelope: EncryptedEnvelope };
    const nestedPayload = await phoneOpen<{
      outcome: string;
      entries?: { name: string; kind: string; size: number }[];
    }>(session.id, nestedResponse.envelope, key);
    expect(nestedPayload.outcome).toBe('ok');
    expect(nestedPayload.entries).toEqual([{ name: 'index.ts', kind: 'file', size: 10 }]);
  });

  it('refuses a path that escapes the session project root, replying with an error outcome instead of leaking data or hanging', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-list-traversal';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fs-2',
      deviceId: 'device-node-fs-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fs-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    for (const evilPath of ['../../../etc', '/etc/passwd']) {
      const envelope = await phoneSeal(session.id, { path: evilPath }, key);
      const requestId = `req-evil-${evilPath}`;
      phone.send({
        type: 'fs_list_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        targetId: 'local',
        requestId,
        envelope,
      });
      const response = (await phone.waitFor(
        (m) =>
          m.type === 'fs_list_response' && (m as { requestId?: string }).requestId === requestId,
      )) as { type: 'fs_list_response'; envelope: EncryptedEnvelope };
      const payload = await phoneOpen<{ outcome: string; message?: string }>(
        session.id,
        response.envelope,
        key,
      );
      expect(payload.outcome).toBe('error');
    }
  });
});

describe('NodeDaemon fs-read (read-only file viewer, issue #737)', () => {
  it("reads a local session's file content over the encrypted fs_read_request/fs_read_response pair", async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-read-local';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fs-read-1',
      deviceId: 'device-node-fs-read-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    await fsMkdir(pathJoin(session.worktreePath, 'src'));
    await fsWriteFile(pathJoin(session.worktreePath, 'src', 'index.ts'), 'export {};\n');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fs-read-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const requestEnvelope = await phoneSeal(session.id, { path: 'src/index.ts' }, key);
    assertOpaque(requestEnvelope, ['export {};', session.worktreePath]);
    phone.send({
      type: 'fs_read_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      targetId: 'local',
      requestId: 'req-read',
      envelope: requestEnvelope,
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'fs_read_response' && (m as { requestId?: string }).requestId === 'req-read',
    )) as { type: 'fs_read_response'; envelope: EncryptedEnvelope };
    assertOpaque(response.envelope, ['export {};', session.worktreePath]);
    const payload = await phoneOpen<{
      outcome: string;
      path?: string;
      content?: string;
      truncated?: boolean;
    }>(session.id, response.envelope, key);
    expect(payload).toEqual({
      outcome: 'ok',
      path: 'src/index.ts',
      content: 'export {};\n',
      truncated: false,
    });
  });

  it('refuses a path that escapes the session project root, replying with an error outcome instead of leaking data or hanging', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-read-traversal';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fs-read-2',
      deviceId: 'device-node-fs-read-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fs-read-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    for (const evilPath of ['../../../etc/passwd', '/etc/passwd']) {
      const envelope = await phoneSeal(session.id, { path: evilPath }, key);
      const requestId = `req-evil-${evilPath}`;
      phone.send({
        type: 'fs_read_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        targetId: 'local',
        requestId,
        envelope,
      });
      const response = (await phone.waitFor(
        (m) =>
          m.type === 'fs_read_response' && (m as { requestId?: string }).requestId === requestId,
      )) as { type: 'fs_read_response'; envelope: EncryptedEnvelope };
      const payload = await phoneOpen<{ outcome: string; message?: string }>(
        session.id,
        response.envelope,
        key,
      );
      expect(payload.outcome).toBe('error');
    }
  });

  it('replies with an error outcome for a binary file instead of forwarding raw bytes as garbled text', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-read-binary';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fs-read-3',
      deviceId: 'device-node-fs-read-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    await fsWriteFile(pathJoin(session.worktreePath, 'logo.png'), Buffer.from([0x89, 0, 0x4e]));

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fs-read-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(session.id, { path: 'logo.png' }, key);
    phone.send({
      type: 'fs_read_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      targetId: 'local',
      requestId: 'req-binary',
      envelope,
    });
    const response = (await phone.waitFor(
      (m) =>
        m.type === 'fs_read_response' && (m as { requestId?: string }).requestId === 'req-binary',
    )) as { type: 'fs_read_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<{ outcome: string; message?: string }>(
      session.id,
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('error');
    expect(payload.message).toMatch(/binary/i);
  });

  it("truncates a file past the viewer's byte cap and reports truncated: true rather than silently cutting it off", async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-read-truncate';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fs-read-4',
      deviceId: 'device-node-fs-read-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const huge = 'x'.repeat(1_000_010);
    await fsWriteFile(pathJoin(session.worktreePath, 'huge.txt'), huge);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fs-read-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const envelope = await phoneSeal(session.id, { path: 'huge.txt' }, key);
    phone.send({
      type: 'fs_read_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      targetId: 'local',
      requestId: 'req-huge',
      envelope,
    });
    const response = (await phone.waitFor(
      (m) =>
        m.type === 'fs_read_response' && (m as { requestId?: string }).requestId === 'req-huge',
    )) as { type: 'fs_read_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<{ outcome: string; content?: string; truncated?: boolean }>(
      session.id,
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('ok');
    expect(payload.truncated).toBe(true);
    expect(payload.content).toHaveLength(1_000_000);
  });
});

describe('NodeDaemon target-fs (directory picker, SPEC §7.25; issue #474)', () => {
  it("lists a local target's directory over the encrypted target_fs_list_request/target_fs_list_response pair, dirs first, sealed under a per-target key (not the session key)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-target-fs-local';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-target-fs-1',
      deviceId: 'device-node-target-fs-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const key = await derivePhoneTargetKey(amk, accountId, 'local');

    // A directory this test controls (not a session worktree — the whole
    // point of the picker is browsing BEFORE any session exists), nested
    // under `projectPath` (which `beforeEach` already `git init`s) so this
    // one has exactly the two entries below, mixing a file and a directory
    // to prove the dirs-first sort.
    const browseDir = pathJoin(projectPath, 'browse-me');
    await fsMkdir(browseDir);
    await fsWriteFile(pathJoin(browseDir, 'README.md'), '# hi');
    await fsMkdir(pathJoin(browseDir, 'src'));
    await fsWriteFile(pathJoin(browseDir, 'src', 'index.ts'), 'export {};');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-target-fs-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    // Sealed/opened under `targetId` ('local') as the resource id — SPEC
    // §8's AAD binding — exactly what `NodeDaemon`'s `decryptTargetFsListRequest`/
    // `sendTargetFsListResponse` use, not the path being browsed.
    const requestEnvelope = await phoneSeal('local', { path: browseDir }, key);
    assertOpaque(requestEnvelope, ['README.md', 'src']);
    phone.send({
      type: 'target_fs_list_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-target-fs-1',
      targetId: 'local',
      requestId: 'req-dir-root',
      envelope: requestEnvelope,
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'target_fs_list_response' &&
        (m as { requestId?: string }).requestId === 'req-dir-root',
    )) as { type: 'target_fs_list_response'; targetId: string; envelope: EncryptedEnvelope };
    assertOpaque(response.envelope, ['README.md', 'src']);

    const payload = await phoneOpen<{
      outcome: string;
      path: string;
      entries?: { name: string; kind: string; size: number }[];
    }>('local', response.envelope, key);
    expect(payload.outcome).toBe('ok');
    expect(payload.path).toBe(browseDir);
    // Dirs first (SPEC §7.25's acceptance), then alphabetical — a
    // directory's own reported `size` is filesystem-dependent, so only
    // name/kind (and the ORDER) are asserted for it; the file's size is
    // real content and asserted exactly.
    expect(payload.entries?.map((entry) => ({ name: entry.name, kind: entry.kind }))).toEqual([
      { name: 'src', kind: 'dir' },
      { name: 'README.md', kind: 'file' },
    ]);
    expect(payload.entries?.find((entry) => entry.name === 'README.md')?.size).toBe(4);
  });

  it("resolves an empty path to the local target's own home directory", async () => {
    const amk = generateAmk();
    const accountId = 'acct-target-fs-home';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-target-fs-2',
      deviceId: 'device-node-target-fs-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const key = await derivePhoneTargetKey(amk, accountId, 'local');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-target-fs-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const requestEnvelope = await phoneSeal('local', { path: '' }, key);
    phone.send({
      type: 'target_fs_list_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-target-fs-2',
      targetId: 'local',
      requestId: 'req-dir-home',
      envelope: requestEnvelope,
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'target_fs_list_response' &&
        (m as { requestId?: string }).requestId === 'req-dir-home',
    )) as { type: 'target_fs_list_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<{ outcome: string; path: string }>(
      'local',
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('ok');
    expect(payload.path).toBe(homedir());
  });

  it('ignores a target_fs_list_request for a target this node does not own, instead of throwing', async () => {
    const amk = generateAmk();
    const accountId = 'acct-target-fs-unknown';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-target-fs-3',
      deviceId: 'device-node-target-fs-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const key = await derivePhoneTargetKey(amk, accountId, 'does-not-exist');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-target-fs-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const requestEnvelope = await phoneSeal('does-not-exist', { path: '' }, key);
    phone.send({
      type: 'target_fs_list_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-target-fs-3',
      targetId: 'does-not-exist',
      requestId: 'req-dir-unknown',
      envelope: requestEnvelope,
    });

    // Give the node a beat to (not) reply, then prove it's still alive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(phone.count((m) => m.type === 'target_fs_list_response')).toBe(0);
  });

  it('a missing directory replies with an error outcome instead of leaking data or hanging', async () => {
    const amk = generateAmk();
    const accountId = 'acct-target-fs-error';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-target-fs-4',
      deviceId: 'device-node-target-fs-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const key = await derivePhoneTargetKey(amk, accountId, 'local');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-target-fs-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const missingPath = pathJoin(projectPath, 'does-not-exist');
    const requestEnvelope = await phoneSeal('local', { path: missingPath }, key);
    phone.send({
      type: 'target_fs_list_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-target-fs-4',
      targetId: 'local',
      requestId: 'req-dir-missing',
      envelope: requestEnvelope,
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'target_fs_list_response' &&
        (m as { requestId?: string }).requestId === 'req-dir-missing',
    )) as { type: 'target_fs_list_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<{ outcome: string; message?: string }>(
      'local',
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('error');
  });

  it('reports gitRepo: true when the listed path is inside a git work tree (SPEC §7.1; issue #507)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-target-fs-gitrepo-true';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-target-fs-gitrepo-true',
      deviceId: 'device-node-target-fs-gitrepo-true',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const key = await derivePhoneTargetKey(amk, accountId, 'local');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-target-fs-gitrepo-true',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const requestEnvelope = await phoneSeal('local', { path: projectPath }, key);
    phone.send({
      type: 'target_fs_list_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-target-fs-gitrepo-true',
      targetId: 'local',
      requestId: 'req-gitrepo-true',
      envelope: requestEnvelope,
    });

    const response = await phone.waitFor(
      (m) => m.type === 'target_fs_list_response' && m.requestId === 'req-gitrepo-true',
    );
    if (response.type !== 'target_fs_list_response') {
      throw new Error('expected a target_fs_list_response');
    }
    const payload = await phoneOpen<{ outcome: string; gitRepo?: boolean }>(
      'local',
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('ok');
    expect(payload.gitRepo).toBe(true);
  });

  it('reports gitRepo: false when the listed path is not inside a git work tree (SPEC §6/§7.1; issue #507)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-target-fs-gitrepo-false';
    const nonGitDir = await mkdtemp(path.join(tmpdir(), 'loombox-target-fs-nongit-'));

    try {
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-target-fs-gitrepo-false',
        deviceId: 'device-node-target-fs-gitrepo-false',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });
      await waitForConnected(node);

      const key = await derivePhoneTargetKey(amk, accountId, 'local');

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-target-fs-gitrepo-false',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;

      const requestEnvelope = await phoneSeal('local', { path: nonGitDir }, key);
      phone.send({
        type: 'target_fs_list_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node-target-fs-gitrepo-false',
        targetId: 'local',
        requestId: 'req-gitrepo-false',
        envelope: requestEnvelope,
      });

      const response = await phone.waitFor(
        (m) => m.type === 'target_fs_list_response' && m.requestId === 'req-gitrepo-false',
      );
      if (response.type !== 'target_fs_list_response') {
        throw new Error('expected a target_fs_list_response');
      }
      const payload = await phoneOpen<{ outcome: string; gitRepo?: boolean }>(
        'local',
        response.envelope,
        key,
      );
      expect(payload.outcome).toBe('ok');
      expect(payload.gitRepo).toBe(false);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe('NodeDaemon ssh-discovery (redesign v2 §3.2 add-target candidate picker; issue #475)', () => {
  it('responds to ssh_discovery_request with a real discoverSshTargets() run against a fixture ~/.ssh/config, in the clear (no envelope)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-discovery-1';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-discovery-1',
      deviceId: 'device-node-ssh-discovery-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      sshDiscoveryOptions: {
        configPath: path.join(SSH_CONFIG_FIXTURES_DIR, 'multiple-hosts'),
        homeDir: '/home/tester',
        env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
        listIdentities: async () => ({
          stdout: '256 SHA256:abc dev@devbox (ED25519)',
          exitCode: 0,
        }),
      },
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-ssh-discovery-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'ssh_discovery_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-ssh-discovery-1',
      requestId: 'req-ssh-discovery-1',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'ssh_discovery_response' &&
        (m as { requestId?: string }).requestId === 'req-ssh-discovery-1',
    )) as Extract<WireMessageV1, { type: 'ssh_discovery_response' }>;

    expect(response.nodeId).toBe('node-ssh-discovery-1');
    expect(response.result.outcome).toBe('ok');
    if (response.result.outcome !== 'ok') throw new Error('unreachable');
    expect(response.result.candidates.map((c) => c.alias)).toEqual([
      'prodbox',
      'staging',
      'mac',
      'macbook',
    ]);
    expect(response.result.requiresManualEntry).toBe(false);
    expect(response.result.agent).toEqual({
      available: true,
      socketPath: '/tmp/ssh-agent.sock',
      identities: [
        { bits: 256, fingerprint: 'SHA256:abc', comment: 'dev@devbox', type: 'ED25519' },
      ],
    });
    // Plain fields only — never an envelope, unlike target_fs_list_response.
    expect(response).not.toHaveProperty('envelope');
  });

  it('reports requiresManualEntry: true when this node has no ~/.ssh/config to discover from', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-discovery-2';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-discovery-2',
      deviceId: 'device-node-ssh-discovery-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      sshDiscoveryOptions: {
        configPath: path.join(SSH_CONFIG_FIXTURES_DIR, 'does-not-exist'),
        homeDir: '/home/tester',
        env: {},
      },
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-ssh-discovery-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'ssh_discovery_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-ssh-discovery-2',
      requestId: 'req-ssh-discovery-2',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'ssh_discovery_response' &&
        (m as { requestId?: string }).requestId === 'req-ssh-discovery-2',
    )) as Extract<WireMessageV1, { type: 'ssh_discovery_response' }>;

    expect(response.result).toEqual({
      outcome: 'ok',
      candidates: [],
      agent: { available: false, identities: [] },
      requiresManualEntry: true,
    });
  });

  it('replies with an error outcome instead of hanging when discoverSshTargetsImpl unexpectedly throws', async () => {
    const amk = generateAmk();
    const accountId = 'acct-ssh-discovery-3';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-ssh-discovery-3',
      deviceId: 'device-node-ssh-discovery-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      discoverSshTargetsImpl: async () => {
        throw new Error('boom: disk read failed');
      },
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-ssh-discovery-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'ssh_discovery_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-ssh-discovery-3',
      requestId: 'req-ssh-discovery-3',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'ssh_discovery_response' &&
        (m as { requestId?: string }).requestId === 'req-ssh-discovery-3',
    )) as Extract<WireMessageV1, { type: 'ssh_discovery_response' }>;

    expect(response.result).toEqual({ outcome: 'error', message: 'boom: disk read failed' });
  });
});

function generateEd25519Pair(): { privateKey: KeyObject; publicKeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

function signBytes(bytes: Uint8Array, privateKey: KeyObject): Uint8Array {
  return new Uint8Array(cryptoSign(null, Buffer.from(bytes), privateKey));
}

function signedArtifactSource(privateKey: KeyObject): SupervisorArtifactSource {
  const bytes = new TextEncoder().encode('supervisor-runtime');
  return {
    fetch: async (_osArch, version) => ({
      version,
      bytes,
      signature: signBytes(bytes, privateKey),
    }),
  };
}

/**
 * A scripted `ssh:` remote backing both connection-management actions below
 * (issue #476): the systemd-unit commands `decommissionSshTarget` issues
 * (mirrors `decommission.test.ts`'s own fixture) and the version-marker
 * commands `TargetUpdateMonitor`/`supervisor-provisioning.ts` issue (mirrors
 * `target-update-monitor.test.ts`'s own fixture) — one shared script since a
 * single `FakeTransport` instance backs every test's ssh: target here.
 * `state.stagedVersion` is mutated in place so an update test's own
 * before/after handshake sees its own write reflected.
 */
function fakeConnectionManagementExec(state: { stagedVersion?: string }): FakeExecHandler {
  return (command) => {
    if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
    if (command.includes('command -v systemctl')) {
      return { stdout: 'present\n', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('printf %s "$HOME/.config/systemd/user"')) {
      return { stdout: '/home/dev/.config/systemd/user', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('printf %s "$HOME/.loombox/supervisor"')) {
      return { stdout: '/home/dev/.loombox/supervisor', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('cat ') && command.includes('VERSION')) {
      return {
        stdout: state.stagedVersion ?? '',
        stderr: '',
        exitCode: state.stagedVersion ? 0 : 1,
      };
    }
    if (command.startsWith('printf') && command.includes('VERSION')) {
      const match = /printf '%s' '([^']*)'/.exec(command);
      state.stagedVersion = match?.[1];
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('cat ')) {
      // The systemd unit file check (decommission's `unitWasInstalled` probe).
      return { stdout: '[Unit]\nDescription=x\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

describe('NodeDaemon connection management (redesign v2 §3.3 Reconnect/Update/Remove/Edit; issue #476)', () => {
  it('decommissions an ssh: target on decommission_target_request, forgets it, and re-announces the smaller target list', async () => {
    const amk = generateAmk();
    const accountId = 'acct-conn-mgmt-decommission';
    const targetId = 'ssh:devbox-1';
    const transport = new FakeTransport({ onExec: fakeConnectionManagementExec({}) });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-conn-mgmt-1',
      deviceId: 'device-node-conn-mgmt-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      targets: [{ id: targetId, kind: 'ssh', label: 'Dev box', providers: [] }],
      sshTargets: [{ id: targetId, label: 'Dev box', host: '100.87.202.117', user: 'dev' }],
      sshTransportFactory: () => transport,
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-conn-mgmt-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'decommission_target_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-conn-mgmt-1',
      targetId,
      requestId: 'req-decommission-1',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'decommission_target_response' &&
        (m as { requestId?: string }).requestId === 'req-decommission-1',
    )) as Extract<WireMessageV1, { type: 'decommission_target_response' }>;

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      unitWasInstalled: true,
      unitStopped: true,
      unitDisabled: true,
      deviceKeyRevoked: true,
      filesRemoved: false,
    });
    // Plain fields only — never an envelope.
    expect(response).not.toHaveProperty('envelope');

    // The target genuinely no longer appears as usable (decommission.ts's
    // own doc comment): forgetSshTarget's re-announce reaches the relay's
    // store, so a fresh target_list_request no longer lists it.
    phone.send({
      type: 'target_list_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-list-after-decommission',
    });
    const list = (await phone.waitFor(
      (m) =>
        m.type === 'target_list' &&
        (m as { requestId?: string }).requestId === 'req-list-after-decommission',
    )) as Extract<WireMessageV1, { type: 'target_list' }>;
    expect(list.targets.some((t) => t.targetId === targetId)).toBe(false);
  });

  it('replies ok: false for an unknown targetId instead of throwing', async () => {
    const amk = generateAmk();
    const accountId = 'acct-conn-mgmt-unknown';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-conn-mgmt-2',
      deviceId: 'device-node-conn-mgmt-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-conn-mgmt-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'decommission_target_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-conn-mgmt-2',
      targetId: 'ssh:does-not-exist',
      requestId: 'req-decommission-2',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'decommission_target_response' &&
        (m as { requestId?: string }).requestId === 'req-decommission-2',
    )) as Extract<WireMessageV1, { type: 'decommission_target_response' }>;

    expect(response.ok).toBe(false);
    expect(response.result).toBeUndefined();
    expect(response.message).toContain('ssh:does-not-exist');
  });

  it('refuses to decommission the local target', async () => {
    const amk = generateAmk();
    const accountId = 'acct-conn-mgmt-local';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-conn-mgmt-3',
      deviceId: 'device-node-conn-mgmt-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-conn-mgmt-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'decommission_target_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-conn-mgmt-3',
      targetId: 'local',
      requestId: 'req-decommission-3',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'decommission_target_response' &&
        (m as { requestId?: string }).requestId === 'req-decommission-3',
    )) as Extract<WireMessageV1, { type: 'decommission_target_response' }>;

    expect(response.ok).toBe(false);
    expect(response.message).toContain('local target');
  });

  it('updates an outdated ssh: target on target_update_request via a real TargetUpdateMonitor + signed artifact', async () => {
    const amk = generateAmk();
    const accountId = 'acct-conn-mgmt-update';
    const targetId = 'ssh:devbox-2';
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const execState = { stagedVersion: '1.0.0' };
    const transport = new FakeTransport({ onExec: fakeConnectionManagementExec(execState) });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-conn-mgmt-4',
      deviceId: 'device-node-conn-mgmt-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      targets: [{ id: targetId, kind: 'ssh', label: 'Dev box 2', providers: [] }],
      sshTargets: [{ id: targetId, label: 'Dev box 2', host: '100.87.202.117', user: 'dev' }],
      sshTransportFactory: () => transport,
      targetUpdate: {
        pinnedVersion: '2.0.0',
        artifactSource: signedArtifactSource(privateKey),
        publicKey: publicKeyRaw,
      },
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-conn-mgmt-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'target_update_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-conn-mgmt-4',
      targetId,
      requestId: 'req-update-1',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'target_update_response' &&
        (m as { requestId?: string }).requestId === 'req-update-1',
    )) as Extract<WireMessageV1, { type: 'target_update_response' }>;

    expect(response.ok).toBe(true);
    expect(response.status).toBe('current');
    expect(response.remoteVersion).toBe('2.0.0');
    expect(response.installedVersion).toBe('2.0.0');
    expect(response).not.toHaveProperty('envelope');
  });

  it('replies ok: false when no target-update artifact source is configured on this node', async () => {
    const amk = generateAmk();
    const accountId = 'acct-conn-mgmt-not-configured';
    const targetId = 'ssh:devbox-3';
    const transport = new FakeTransport({ onExec: fakeConnectionManagementExec({}) });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-conn-mgmt-5',
      deviceId: 'device-node-conn-mgmt-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      targets: [{ id: targetId, kind: 'ssh', label: 'Dev box 3', providers: [] }],
      sshTargets: [{ id: targetId, label: 'Dev box 3', host: '100.87.202.117', user: 'dev' }],
      sshTransportFactory: () => transport,
      // No `targetUpdate` configured.
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-conn-mgmt-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'target_update_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-conn-mgmt-5',
      targetId,
      requestId: 'req-update-2',
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'target_update_response' &&
        (m as { requestId?: string }).requestId === 'req-update-2',
    )) as Extract<WireMessageV1, { type: 'target_update_response' }>;

    expect(response.ok).toBe(false);
    expect(response.message).toBe('target updates are not configured on this node');
  });
});

/** Decrypts every `terminal_output` seen so far for `sessionId`/`terminalId`, concatenates their `data` in arrival order, and polls until the result contains `substring` or times out — the terminal-stream counterpart to `waitForDecryptedKinds`. */
async function waitForTerminalOutputContains(
  phone: TestPhone,
  sessionId: string,
  terminalId: string,
  key: CryptoKey,
  substring: string,
  timeoutMs = 10000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidates = phone.messages.filter(
      (m): m is Extract<WireMessageV1, { type: 'terminal_output' }> =>
        m.type === 'terminal_output' && m.sessionId === sessionId && m.terminalId === terminalId,
    );
    const chunks = await Promise.all(
      candidates.map((m) => phoneOpen<{ data: string }>(sessionId, m.envelope, key)),
    );
    const text = chunks
      .map((c) => fromBase64(c.data))
      .reduce((acc, bytes) => acc + Buffer.from(bytes).toString('utf8'), '');
    if (text.includes(substring)) return text;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForTerminalOutputContains: timed out waiting for "${substring}" (saw: ${JSON.stringify(text)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A `TerminalSupervisor` whose real local PTYs run `bash --noprofile --norc`
 * instead of a full interactive login shell (issue #503). `node-daemon.ts`
 * itself never sets `args` when it spawns a `local` target's terminal — on
 * purpose, a real terminal is supposed to hand a user their actual shell,
 * aliases and all — so a plain `bash` here sources the *developer's own*
 * `~/.bashrc`. On this devbox that file activates `mise` and regenerates a
 * shell-completion cache by re-invoking `omp`'s own multi-threaded runtime
 * whenever that binary is newer than the cached script (see `~/.bashrc`'s
 * own comment on that block, and the 2026-07-28 incident it documents:
 * orphaned instances of that same regeneration burning CPU for 44h). That
 * cost is invisible most of the time — the cache is usually warm — but it
 * is entirely outside this test's control and unrelated to the PTY/terminal
 * behavior these tests actually cover, so two terminals opened close
 * together can each pay it concurrently. Measured directly (`node-pty`,
 * cold cache, 16 concurrent regenerations): 8.4s wall / 53 CPU-s, on a
 * trend that crosses `waitForTerminalOutputContains`'s 10s budget under
 * only slightly more contention than that — exactly the "shared box, other
 * agents running" condition this test always runs under here, and exactly
 * why the second of two terminals is the one that times out. CI never
 * observes this: its ephemeral `$HOME` has no such `~/.bashrc` and no `omp`
 * on `PATH`, so `command -v omp` fails and the whole block is skipped.
 * `--noprofile --norc` (the same flags `terminal-supervisor.test.ts`'s own
 * unit tests already use) keeps bash interactive — same `pwd`/echo/prompt
 * behavior these tests assert on — while skipping every dotfile, so
 * startup is a `defaultPtySpawn` fork/exec away instead of a shell config's
 * unrelated side effects.
 */
function hermeticTerminalSupervisor(): TerminalSupervisor {
  return new TerminalSupervisor({
    spawnPty: (options) =>
      defaultPtySpawn({ ...options, args: [...(options.args ?? []), '--noprofile', '--norc'] }),
  });
}

describe('NodeDaemon interactive PTY terminals (SPEC §7.5; issues #172/#173)', () => {
  it(
    'opens a local terminal, streams typed input to it, streams its output back, resizes it, and closes it — all over encrypted envelopes',
    { retry: 0, timeout: 20000 },
    async () => {
      // Spawns and waits on a real bash child (not the fast in-process
      // fixture agent every other test in this file uses); the 20s test
      // timeout gives that (session/worktree setup + a real fork/exec)
      // headroom on a loaded box. `hermeticTerminalSupervisor()` (see its
      // own doc comment, issue #503) keeps the shell itself out of that
      // budget, so a failure here is a real PTY/terminal regression, not a
      // flake — hence `retry: 0` overriding this package's default
      // `retry: 2` (vitest.config.ts, issue #497).
      const amk = generateAmk();
      const accountId = 'acct-terminal-local';

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-term-1',
        deviceId: 'device-node-term-1',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
        terminalSupervisor: hermeticTerminalSupervisor(),
      });

      const session = await node.createSession({ projectPath, provider: 'test-echo' });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-term-1',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');

      const terminalId = 'term-1';
      const openEnvelope = await phoneSeal(session.id, { cols: 80, rows: 24 }, key);
      assertOpaque(openEnvelope, ['80', '24']);
      phone.send({
        type: 'terminal_open',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        targetId: 'local',
        terminalId,
        requestId: 'req-open-1',
        envelope: openEnvelope,
      });

      const openedMessage = (await phone.waitFor(
        (m) =>
          m.type === 'terminal_opened' && (m as { requestId?: string }).requestId === 'req-open-1',
      )) as Extract<WireMessageV1, { type: 'terminal_opened' }>;
      const openedPayload = await phoneOpen<{
        outcome: string;
        message?: string;
        cwd?: string;
        shell?: string;
      }>(session.id, openedMessage.envelope, key);
      expect(openedPayload.outcome).toBe('ok');
      // Issue #669: the terminal dock's chrome shows these as real values,
      // not placeholders — `cwd` is the session's actual worktree/project
      // root, `shell` is what `local` actually spawned.
      expect(openedPayload.cwd).toBe(session.worktreePath);
      expect(openedPayload.shell).toBe(process.env.SHELL ?? '/bin/bash');

      const inputEnvelope = await phoneSeal(
        session.id,
        { data: Buffer.from('echo hello-e2e\n', 'utf8').toString('base64') },
        key,
      );
      assertOpaque(inputEnvelope, ['hello-e2e']);
      phone.send({
        type: 'terminal_input',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        terminalId,
        envelope: inputEnvelope,
      });

      await waitForTerminalOutputContains(phone, session.id, terminalId, key, 'hello-e2e');
      // The relay must never see the typed command or the shell's output in
      // the clear — every terminal_output envelope observed so far is opaque.
      for (const m of phone.messages) {
        if (
          m.type === 'terminal_output' &&
          m.sessionId === session.id &&
          m.terminalId === terminalId
        ) {
          assertOpaque(m.envelope, ['hello-e2e']);
        }
      }

      const resizeEnvelope = await phoneSeal(session.id, { cols: 120, rows: 40 }, key);
      phone.send({
        type: 'terminal_resize',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        terminalId,
        envelope: resizeEnvelope,
      });

      phone.send({
        type: 'terminal_close',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        terminalId,
      });

      const closedMessage = (await phone.waitFor(
        (m) =>
          m.type === 'terminal_closed' && (m as { terminalId?: string }).terminalId === terminalId,
      )) as Extract<WireMessageV1, { type: 'terminal_closed' }>;
      const closedPayload = await phoneOpen<{ reason: string }>(
        session.id,
        closedMessage.envelope,
        key,
      );
      expect(closedPayload.reason).toBe('closed_by_client');
    },
  );

  it(
    'supports multiple terminals for the same session sharing its working directory, and closing one does not affect the other (issue #173)',
    { retry: 0, timeout: 20000 },
    async () => {
      // See the previous test's comment: a real bash child needs the 20s
      // budget, and `hermeticTerminalSupervisor()` + `retry: 0` for the
      // same issue #503 reason — this is the test that actually surfaced
      // it (a stale, developer-machine-local `omp` completions cache made
      // the *second* terminal's real `~/.bashrc`-sourcing shell start too
      // slowly to answer `pwd` inside `waitForTerminalOutputContains`'s
      // 10s budget, on this box only — CI's runner has no such shell).
      const amk = generateAmk();
      const accountId = 'acct-terminal-multi';

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-term-2',
        deviceId: 'device-node-term-2',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
        terminalSupervisor: hermeticTerminalSupervisor(),
      });

      const session = await node.createSession({ projectPath, provider: 'test-echo' });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-term-2',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');

      async function openTerminal(terminalId: string, requestId: string): Promise<void> {
        const envelope = await phoneSeal(session.id, { cols: 80, rows: 24 }, key);
        phone!.send({
          type: 'terminal_open',
          protocolVersion: PROTOCOL_V1,
          sessionId: session.id,
          targetId: 'local',
          terminalId,
          requestId,
          envelope,
        });
        const opened = (await phone!.waitFor(
          (m) =>
            m.type === 'terminal_opened' && (m as { requestId?: string }).requestId === requestId,
        )) as Extract<WireMessageV1, { type: 'terminal_opened' }>;
        const payload = await phoneOpen<{ outcome: string }>(session.id, opened.envelope, key);
        expect(payload.outcome).toBe('ok');
      }

      async function typeInto(terminalId: string, text: string): Promise<void> {
        const envelope = await phoneSeal(
          session.id,
          { data: Buffer.from(text, 'utf8').toString('base64') },
          key,
        );
        phone!.send({
          type: 'terminal_input',
          protocolVersion: PROTOCOL_V1,
          sessionId: session.id,
          terminalId,
          envelope,
        });
      }

      await openTerminal('term-a', 'req-open-a');
      await openTerminal('term-b', 'req-open-b');

      await typeInto('term-a', 'pwd\n');
      await typeInto('term-b', 'pwd\n');

      await waitForTerminalOutputContains(phone, session.id, 'term-a', key, session.worktreePath);
      await waitForTerminalOutputContains(phone, session.id, 'term-b', key, session.worktreePath);

      phone.send({
        type: 'terminal_close',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        terminalId: 'term-a',
      });
      await phone.waitFor(
        (m) =>
          m.type === 'terminal_closed' && (m as { terminalId?: string }).terminalId === 'term-a',
      );

      // term-b must still be alive and independently usable after term-a closed.
      await typeInto('term-b', 'echo still-alive\n');
      await waitForTerminalOutputContains(phone, session.id, 'term-b', key, 'still-alive');
      expect(
        phone.count(
          (m) =>
            m.type === 'terminal_closed' && (m as { terminalId?: string }).terminalId === 'term-b',
        ),
      ).toBe(0);
    },
  );

  it('a terminal_open for a session this node does not own is silently ignored, not a crash', async () => {
    const amk = generateAmk();
    const accountId = 'acct-terminal-unknown-session';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-term-3',
      deviceId: 'device-node-term-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-term-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const bogusSessionId = 'session-that-does-not-exist';
    const envelope = await phoneSeal(
      bogusSessionId,
      { cols: 80, rows: 24 },
      await derivePhoneSessionKey(amk, accountId, bogusSessionId),
    );
    phone.send({
      type: 'terminal_open',
      protocolVersion: PROTOCOL_V1,
      sessionId: bogusSessionId,
      targetId: 'local',
      terminalId: 'term-bogus',
      requestId: 'req-bogus',
      envelope,
    });

    // No terminal_opened ever arrives — this node has no bridge for that
    // session, so it drops the message per SPEC.md §12, rather than crashing
    // or replying about a session it doesn't own.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(phone.count((m) => m.type === 'terminal_opened')).toBe(0);
  });
});

/**
 * Issue #702: Files and Terminal used to stop working PERMANENTLY the
 * moment a node restarted, because `handleFsListRequest`/`handleTerminalOpen`
 * guarded on `this.bridges.get(sessionId)` — populated only by
 * `finishSessionCreation`, never rebuilt for a session reloaded from disk —
 * and silently dropped the request when it came back empty. This suite
 * proves the fix end to end: a REAL second `NodeDaemon` process
 * (`createNode`, no injected `sessionManager`) built on the SAME
 * `stateDir` a first one already wrote a session into, exactly
 * `main.ts`'s real construction path and exactly what actually reloads
 * `sessions.json` and marks the session `'disconnected'`
 * (`SessionManager`'s own constructor — see `session-manager.ts`'s
 * `SessionLifecycleState` doc comment) — never a test-only hook that
 * pokes a status field directly, which would only prove this test agrees
 * with itself, not that a real restart reaches the same state. No fake
 * stands in for `NodeDaemon`, `SessionManager`, the relay, or the wire
 * protocol anywhere below; only the ACP agent process itself is a fixture
 * (`echoProvider`, `packages/providers/core`'s own hermetic test agent —
 * standard across this whole file), which is never even running by the
 * time these requests are sent.
 */
describe('NodeDaemon reattach after a restart (issue #702)', () => {
  it(
    'answers fs_list_request and terminal_open for real, and pushes session_status: disconnected, for a session reloaded with no live bridge after a restart — instead of dropping the request with no reply',
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-reattach-702';

      // "Before the restart": a real node creates a session and writes it
      // to `sessions.json` under `nodeStateDir` (no injected
      // `sessionManager` — the default `new SessionManager({ store: new
      // SessionStore({ stateDir }) })` every real node uses).
      const beforeRestart = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-reattach-702',
        deviceId: 'device-node-reattach-before',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });
      const session = await beforeRestart.createSession({ projectPath, provider: 'test-echo' });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);
      await fsWriteFile(pathJoin(session.worktreePath, 'README.md'), '# hi');

      // "The restart": the whole process this session's bridge/agent/PTYs
      // lived in is gone. `close()` is the honest stand-in for that — it
      // tears down every bridge/terminal/relay connection this instance
      // held, exactly like a real process exit would, and (deliberately)
      // never touches `sessions.json`, so the record `beforeRestart`
      // already wrote survives on disk for the next process to find.
      beforeRestart.close();

      // "After the restart": same node identity, same stateDir, a FRESH
      // `SessionManager` built from the SAME on-disk store — this is what
      // reloads the session and marks it 'disconnected'.
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-reattach-702',
        deviceId: 'device-node-reattach-after',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
        terminalSupervisor: hermeticTerminalSupervisor(),
      });
      await waitForConnected(node);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-reattach-702',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      // The relay's own persisted record answers this — `beforeRestart`'s
      // original `announce()` is still there; the fix deliberately does
      // NOT re-announce a bridge-less session (see `reannounceAll`'s doc
      // comment), only its status.
      await phone.waitFor((m) => m.type === 'session_announce');
      phone.send({
        type: 'resync_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        sinceSeq: 0,
      });

      // Part 2: the one honest piece of state `SessionManager` already had
      // (issue #515's `'disconnected'`) actually reaches the wire now,
      // instead of dying in `NodeDaemon` — a real client can tell this
      // session apart from a live one.
      const disconnectedDeadline = Date.now() + 5000;
      let sawDisconnected = false;
      while (!sawDisconnected && Date.now() < disconnectedDeadline) {
        for (const m of phone.messages) {
          if (m.type !== 'session_update' || m.sessionId !== session.id) continue;
          const decrypted = await phoneOpen<{ kind: string; status?: string }>(
            session.id,
            m.envelope,
            key,
          );
          if (decrypted.kind === 'session_status' && decrypted.status === 'disconnected') {
            sawDisconnected = true;
            break;
          }
        }
        if (!sawDisconnected) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(sawDisconnected).toBe(true);

      // Part 1+3: fs_list_request gets a REAL answer — listing the
      // session's actual worktree, not an `outcome: 'error'` placeholder —
      // because listing a directory never needed the dead agent bridge in
      // the first place (`resolveSessionRouting`). A short 2s timeout,
      // not the default 10s: this must be fast, not merely eventually
      // correct — the whole bug was a client waiting out its own 10s
      // deadline for a reply that would never come.
      const fsEnvelope = await phoneSeal(session.id, { path: '' }, key);
      phone.send({
        type: 'fs_list_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        targetId: 'local',
        requestId: 'req-reattach-fs',
        envelope: fsEnvelope,
      });
      const fsResponse = (await phone.waitFor(
        (m) =>
          m.type === 'fs_list_response' &&
          (m as { requestId?: string }).requestId === 'req-reattach-fs',
        2000,
      )) as { type: 'fs_list_response'; envelope: EncryptedEnvelope };
      const fsPayload = await phoneOpen<{
        outcome: string;
        entries?: { name: string; kind: string }[];
      }>(session.id, fsResponse.envelope, key);
      expect(fsPayload.outcome).toBe('ok');
      expect(fsPayload.entries?.map((entry) => entry.name)).toContain('README.md');

      // terminal_open answers for real too — same reasoning, same fix.
      const openEnvelope = await phoneSeal(session.id, { cols: 80, rows: 24 }, key);
      phone.send({
        type: 'terminal_open',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        targetId: 'local',
        terminalId: 'term-reattach',
        requestId: 'req-reattach-term',
        envelope: openEnvelope,
      });
      const openedMessage = (await phone.waitFor(
        (m) =>
          m.type === 'terminal_opened' &&
          (m as { requestId?: string }).requestId === 'req-reattach-term',
        2000,
      )) as Extract<WireMessageV1, { type: 'terminal_opened' }>;
      const openedPayload = await phoneOpen<{
        outcome: string;
        message?: string;
        cwd?: string;
      }>(session.id, openedMessage.envelope, key);
      expect(openedPayload.outcome).toBe('ok');
      expect(openedPayload.cwd).toBe(session.worktreePath);

      // Close this test's own terminal explicitly before `afterEach` tears
      // the node down, so `hermeticTerminalSupervisor`'s real PTY doesn't
      // outlive the assertions above it.
      phone.send({
        type: 'terminal_close',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        terminalId: 'term-reattach',
      });
    },
  );
});

describe('NodeDaemon MCP server resolution at session start (issues #187/#189)', () => {
  it("resolves a project's effective MCP server set (with a granted secret) and hands it to the ACP session", async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-resolve';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    const mcpSecretManager = new NodeMcpSecretManager({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    mcpConfigStore.saveGlobal({
      name: 'github',
      transport: 'stdio',
      command: '/usr/bin/mcp-github',
      args: [],
      env: [{ name: 'GITHUB_TOKEN', secret: 'github-token' }],
    });
    await mcpSecretManager.setSecretValue(projectPath, 'github-token', 'ghp_test_value');
    mcpSecretManager.grant(projectPath, 'github', 'github-token');

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp',
      deviceId: 'device-node-mcp',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [mcpProvider()] }),
      mcpConfigStore,
      mcpSecretManager,
    });

    const session = await node.createSession({ projectPath, provider: 'test-mcp' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-mcp',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor(
      (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
    );

    await node.promptSession(session.id, 'echo-mcp-servers');

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const [chunk] = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 1);
    const echoedMcpServers = JSON.parse(chunk!.text!);

    expect(echoedMcpServers).toEqual([
      {
        name: 'github',
        command: '/usr/bin/mcp-github',
        args: [],
        env: [{ name: 'GITHUB_TOKEN', value: 'ghp_test_value' }],
      },
    ]);
  });

  it('rejects session creation up front, before any worktree/agent is created, when a configured MCP server has an ungranted secret', async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-ungranted';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    mcpConfigStore.saveGlobal({
      name: 'github',
      transport: 'stdio',
      command: '/usr/bin/mcp-github',
      args: [],
      env: [{ name: 'GITHUB_TOKEN', secret: 'github-token' }],
    });
    // Deliberately never granted/set: this project has neither a grant nor a
    // stored value for "github-token".

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp-reject',
      deviceId: 'device-node-mcp-reject',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [mcpProvider()] }),
      mcpConfigStore,
    });

    await expect(node.createSession({ projectPath, provider: 'test-mcp' })).rejects.toThrow(
      /github.*GITHUB_TOKEN/i,
    );
  });

  it('a project with no configured MCP servers opens a session with an empty mcpServers list, unchanged from before this issue', async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-none';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp-none',
      deviceId: 'device-node-mcp-none',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [mcpProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-mcp' });
    await node.promptSession(session.id, 'echo-mcp-servers');

    // No wire assertion needed beyond "this didn't throw" — resolveMcpServers()
    // short-circuits to [] without touching the secret manager at all when
    // the project's effective server set is empty (see node-daemon.ts's doc
    // comment on that method).
    expect(session.id).toBeTruthy();
  });
});

describe('NodeDaemon MCP server placement/lifecycle on the execution target (issue #750, D2-2)', () => {
  it("merges the client-declared MCP server list with this node's own McpConfigStore, deduplicated by name — the node's own record wins a collision", async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-merge';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    mcpConfigStore.saveGlobal({
      name: 'shared',
      transport: 'stdio',
      command: '/node/shared',
      args: [],
      env: [],
    });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp-merge',
      deviceId: 'device-node-mcp-merge',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [mcpProvider()] }),
      mcpConfigStore,
    });

    const session = await node.createSession({
      projectPath,
      provider: 'test-mcp',
      mcpServerConfigs: [
        { name: 'shared', transport: 'stdio', command: '/client/shared', args: [], env: [] },
        { name: 'client-only', transport: 'stdio', command: '/client/only', args: [], env: [] },
      ],
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-mcp-merge',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor(
      (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
    );

    await node.promptSession(session.id, 'echo-mcp-servers');

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const [chunk] = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 1);
    const echoed = JSON.parse(chunk!.text!) as { name: string; command: string }[];

    expect(echoed.map((s) => s.name).sort()).toEqual(['client-only', 'shared']);
    // The node's own record wins outright — never the client-declared one
    // of the same name.
    expect(echoed.find((s) => s.name === 'shared')?.command).toBe('/node/shared');
  });

  it('excludes a server with a missing binary, reports it by name and category, and the session still starts with the remaining servers', async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-missing-binary';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    mcpConfigStore.saveGlobal({
      name: 'bad-binary',
      transport: 'stdio',
      command: 'this-binary-does-not-exist',
      args: [],
      env: [],
    });
    mcpConfigStore.saveGlobal({
      name: 'good',
      transport: 'stdio',
      command: '/bin/good',
      args: [],
      env: [],
    });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp-missing-binary',
      deviceId: 'device-node-mcp-missing-binary',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [failingMcpProvider()] }),
      mcpConfigStore,
    });

    const session = await node.createSession({ projectPath, provider: 'test-mcp-failing' });
    await node.promptSession(session.id, 'echo-mcp-servers');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-mcp-missing-binary',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      sinceSeq: 0,
    });

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    // `mcp_server_status` is already buffered by the time this phone
    // subscribes, but `agent_message_chunk` only lands once the prompt
    // turn's transcript update actually finishes flushing through
    // `bridge.sendQueue` — a single resync snapshot can race ahead of
    // that, so this re-polls (same pattern the "bounds an agent spawn
    // that never resolves" test above uses) rather than trusting one
    // resync reply.
    let events: DecryptedSessionEvent[] = [];
    const deadline = Date.now() + 10000;
    for (;;) {
      phone.send({
        type: 'resync_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        sinceSeq: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const seen = await waitForDecryptedKinds(
        phone,
        session.id,
        key,
        ['mcp_server_status', 'agent_message_chunk'],
        0,
        0,
      ).catch(() => []);
      const bySeq = new Map(seen.map((event) => [event.seq, event]));
      events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      if (
        events.some((event) => event.kind === 'mcp_server_status') &&
        events.some((event) => event.kind === 'agent_message_chunk')
      ) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          'timed out waiting for both mcp_server_status and agent_message_chunk to resync',
        );
      }
    }
    const statusEvent = events.find((e) => e.kind === 'mcp_server_status');
    expect(statusEvent?.servers).toEqual([
      {
        name: 'bad-binary',
        ok: false,
        category: 'missing_binary',
        reason: expect.stringContaining('Executable not found') as unknown as string,
      },
    ]);

    const chunk = events.find((e) => e.kind === 'agent_message_chunk');
    const echoed = JSON.parse(chunk!.text!) as { name: string }[];
    expect(echoed.map((s) => s.name)).toEqual(['good']);
  }, 15000);

  it('excludes a server with a failed MCP handshake, reported with a distinct category from a missing binary', async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-bad-handshake';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    mcpConfigStore.saveGlobal({
      name: 'bad-handshake',
      transport: 'stdio',
      command: 'cat',
      args: [],
      env: [],
    });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp-bad-handshake',
      deviceId: 'device-node-mcp-bad-handshake',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [failingMcpProvider()] }),
      mcpConfigStore,
    });

    const session = await node.createSession({ projectPath, provider: 'test-mcp-failing' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-mcp-bad-handshake',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      sinceSeq: 0,
    });

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const events = await waitForDecryptedKinds(phone, session.id, key, ['mcp_server_status'], 1);
    expect(events[0]?.servers).toEqual([
      {
        name: 'bad-handshake',
        ok: false,
        category: 'handshake_failed',
        reason: expect.any(String) as unknown as string,
      },
    ]);
  });

  it("auto-disables an MCP server in this node's own McpConfigStore after three consecutive failures to start", async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-auto-disable';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    mcpConfigStore.saveGlobal({
      name: 'bad-binary',
      transport: 'stdio',
      command: 'this-binary-does-not-exist',
      args: [],
      env: [],
    });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp-auto-disable',
      deviceId: 'device-node-mcp-auto-disable',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [failingMcpProvider()] }),
      mcpConfigStore,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await node.createSession({ projectPath, provider: 'test-mcp-failing' });
      // Still enabled — only three consecutive failures auto-disable it.
      expect(mcpConfigStore.listGlobal().find((r) => r.config.name === 'bad-binary')?.enabled).toBe(
        true,
      );
    }
    await node.createSession({ projectPath, provider: 'test-mcp-failing' });
    expect(mcpConfigStore.listGlobal().find((r) => r.config.name === 'bad-binary')?.enabled).toBe(
      false,
    );
  });

  it("makes a revoked/ungranted secret grant's failure visible on the wire — session_announce, session_status: 'error' and mcp_server_status all name the server, not just a console warning (issue #750, D2-2)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-secret-visible';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    mcpConfigStore.saveGlobal({
      name: 'github',
      transport: 'stdio',
      command: '/usr/bin/mcp-github',
      args: [],
      env: [{ name: 'GITHUB_TOKEN', secret: 'github-token' }],
    });
    // Deliberately never granted/set.

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-mcp-secret-visible',
      deviceId: 'device-node-mcp-secret-visible',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [mcpProvider()] }),
      mcpConfigStore,
    });
    await waitForConnected(node);

    const sessionId = 'sess-mcp-secret-visible-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      { title: 'secret missing', projectPath },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-mcp-secret-visible',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-mcp',
      privateEnvelope,
    });

    // On the board — announced even though this session never gets a
    // worktree/lease/agent, purely so the failure below is visible at all
    // (see `reportMcpPreflightFailure`'s own doc comment).
    await waitForSessionInList(phone, sessionId);

    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      sinceSeq: 0,
    });
    const events = await waitForDecryptedKinds(
      phone,
      sessionId,
      key,
      ['session_status', 'mcp_server_status'],
      2,
    );

    const statusEvent = events.find((e) => e.kind === 'session_status');
    expect(statusEvent?.status).toBe('error');
    expect(statusEvent?.reason).toMatch(/github.*GITHUB_TOKEN/i);

    const mcpEvent = events.find((e) => e.kind === 'mcp_server_status');
    expect(mcpEvent?.servers).toEqual([
      {
        name: 'github',
        ok: false,
        category: 'secret_missing',
        reason: expect.stringContaining('GITHUB_TOKEN') as unknown as string,
      },
    ]);
  });

  it('never lets a resolved secret value cross the relay, in any message frame this node sends (issue #750, D2-2)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-mcp-secret-opaque';
    const secretValue = 'ghp_this_exact_value_must_never_leave_the_node';

    const mcpConfigStore = new McpConfigStore({ stateDir: nodeStateDir });
    const mcpSecretManager = new NodeMcpSecretManager({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    mcpConfigStore.saveGlobal({
      name: 'github',
      transport: 'stdio',
      command: '/usr/bin/mcp-github',
      args: [],
      env: [{ name: 'GITHUB_TOKEN', secret: 'github-token' }],
    });
    await mcpSecretManager.setSecretValue(projectPath, 'github-token', secretValue);
    mcpSecretManager.grant(projectPath, 'github', 'github-token');

    const sentFrames: string[] = [];
    const originalSend = WebSocket.prototype.send;
    const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data: string | ArrayBufferLike | ArrayBufferView | Blob,
    ) {
      sentFrames.push(String(data));
      return originalSend.call(this, data);
    });

    try {
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-mcp-secret-opaque',
        deviceId: 'device-node-mcp-secret-opaque',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [mcpProvider()] }),
        mcpConfigStore,
        mcpSecretManager,
      });

      const session = await node.createSession({ projectPath, provider: 'test-mcp' });

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-mcp-secret-opaque',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor(
        (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
      );
      // The fixture agent echoes the resolved mcpServers (secret value
      // included) straight back over its own ACP session — this is the
      // one place the value legitimately exists past the node, and it is
      // exactly what this assertion must still catch if it ever left the
      // node in the clear.
      await node.promptSession(session.id, 'echo-mcp-servers');
      const key = await derivePhoneSessionKey(amk, accountId, session.id);
      await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 1);
    } finally {
      sendSpy.mockRestore();
    }

    expect(sentFrames.some((frame) => frame.includes(secretValue))).toBe(false);
  });
});

describe('NodeDaemon project env-var injection at session start (issue #258)', () => {
  it("resolves a project's declared env-var injection (with a granted secret) and it reaches the spawned agent process's real environment", async () => {
    const amk = generateAmk();
    const accountId = 'acct-project-env-resolve';

    const mcpSecretManager = new NodeMcpSecretManager({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    await mcpSecretManager.setSecretValue(projectPath, 'db-password', 'hunter2');
    const projectEnvManager = new NodeProjectEnvManager({
      stateDir: nodeStateDir,
      secrets: mcpSecretManager,
    });
    projectEnvManager.grant(projectPath, 'db-password');

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-project-env',
      deviceId: 'device-node-project-env',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [envEchoProvider()] }),
      mcpSecretManager,
      projectEnvManager,
    });

    const session = await node.createSession({
      projectPath,
      provider: 'test-env-echo',
      projectEnvDecls: [{ name: 'PROJECT_SECRET', secret: 'db-password' }],
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-project-env',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor(
      (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
    );

    // Prompts the real spawned child process, which reads its OWN
    // `process.env.PROJECT_SECRET` (real OS-level environment, not a
    // mocked spawn call) and echoes it back — the direct proof this
    // node-level test needs that the declared secret actually reached the
    // agent process's environment.
    await node.promptSession(session.id, 'echo-env:PROJECT_SECRET');

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const [chunk] = await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 1);
    expect(JSON.parse(chunk!.text!)).toBe('hunter2');
  });

  it('rejects session creation up front, before any worktree/agent is created, when a declared env var has an ungranted secret', async () => {
    const amk = generateAmk();
    const accountId = 'acct-project-env-ungranted';

    // Deliberately never granted/set: this project has neither a grant nor
    // a stored value for "db-password".
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-project-env-reject',
      deviceId: 'device-node-project-env-reject',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [envEchoProvider()] }),
    });

    await expect(
      node.createSession({
        projectPath,
        provider: 'test-env-echo',
        projectEnvDecls: [{ name: 'DB_PASSWORD', secret: 'db-password' }],
      }),
    ).rejects.toThrow(/DB_PASSWORD.*db-password/i);
  });

  it("makes a missing/ungranted secret's failure visible on the wire — session_announce and session_status: 'error' name the env var and secret, never a value", async () => {
    const amk = generateAmk();
    const accountId = 'acct-project-env-visible';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-project-env-visible',
      deviceId: 'device-node-project-env-visible',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [envEchoProvider()] }),
    });
    await waitForConnected(node);

    const sessionId = 'sess-project-env-visible-1';
    const key = await derivePhoneSessionKey(amk, accountId, sessionId);
    const privateEnvelope = await phoneSeal(
      sessionId,
      {
        title: 'secret missing',
        projectPath,
        projectEnvDecls: [{ name: 'DB_PASSWORD', secret: 'db-password' }],
      },
      key,
    );

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-project-env-visible',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: 'local',
      provider: 'test-env-echo',
      privateEnvelope,
    });

    // On the board — announced even though this session never gets a
    // worktree/lease/agent, purely so the failure below is visible at all
    // (see `reportProjectEnvPreflightFailure`'s own doc comment).
    await waitForSessionInList(phone, sessionId);

    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      sinceSeq: 0,
    });
    const [statusEvent] = await waitForDecryptedKinds(phone, sessionId, key, ['session_status'], 1);

    expect(statusEvent?.status).toBe('error');
    expect(statusEvent?.reason).toMatch(/DB_PASSWORD.*db-password/i);
  });

  it('never lets a resolved secret value cross the relay, in any message frame this node sends (issue #258)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-project-env-opaque';
    const secretValue = '$$CREDENTIAL_9K3XQ7VZPMDA:L$$';

    const mcpSecretManager = new NodeMcpSecretManager({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    await mcpSecretManager.setSecretValue(projectPath, 'db-password', secretValue);
    const projectEnvManager = new NodeProjectEnvManager({
      stateDir: nodeStateDir,
      secrets: mcpSecretManager,
    });
    projectEnvManager.grant(projectPath, 'db-password');

    const sentFrames: string[] = [];
    const originalSend = WebSocket.prototype.send;
    const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data: string | ArrayBufferLike | ArrayBufferView | Blob,
    ) {
      sentFrames.push(String(data));
      return originalSend.call(this, data);
    });

    try {
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-project-env-opaque',
        deviceId: 'device-node-project-env-opaque',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [envEchoProvider()] }),
        mcpSecretManager,
        projectEnvManager,
      });

      const session = await node.createSession({
        projectPath,
        provider: 'test-env-echo',
        projectEnvDecls: [{ name: 'PROJECT_SECRET', secret: 'db-password' }],
      });

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-project-env-opaque',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor(
        (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
      );
      // The fixture agent echoes the resolved env value (secret included)
      // straight back over its own ACP session — this is the one place
      // the value legitimately exists past the node, and it is exactly
      // what this assertion must still catch if it ever left the node in
      // the clear.
      await node.promptSession(session.id, 'echo-env:PROJECT_SECRET');
      const key = await derivePhoneSessionKey(amk, accountId, session.id);
      await waitForDecryptedKinds(phone, session.id, key, ['agent_message_chunk'], 1);
    } finally {
      sendSpy.mockRestore();
    }

    expect(sentFrames.some((frame) => frame.includes(secretValue))).toBe(false);
  });

  it('a project with no declared env vars opens a session unaffected, unchanged from before this issue', async () => {
    const amk = generateAmk();
    const accountId = 'acct-project-env-none';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-project-env-none',
      deviceId: 'device-node-project-env-none',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [envEchoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-env-echo' });
    await node.promptSession(session.id, 'echo-env:PROJECT_SECRET');

    // No wire assertion needed beyond "this didn't throw" — resolveForSession()
    // short-circuits to {} without touching secret storage at all when the
    // decl list is empty (see NodeProjectEnvManager's doc comment).
    expect(session.id).toBeTruthy();
  });

  it('refuses a declared env var on an ssh: target outright, before any deploy attempt, rather than starting an agent quietly missing it', async () => {
    const amk = generateAmk();
    const accountId = 'acct-project-env-ssh-refused';
    const targetId = 'ssh-target-1';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-project-env-ssh',
      deviceId: 'device-node-project-env-ssh',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [envEchoProvider()] }),
      targets: [{ id: targetId, kind: 'ssh', label: 'Dev box', providers: [] }],
      sshTargets: [{ id: targetId, label: 'Dev box', host: '100.87.202.117', user: 'dev' }],
    });

    await expect(
      node.createSession({
        projectPath,
        provider: 'test-env-echo',
        targetId,
        projectEnvDecls: [{ name: 'PROJECT_SECRET', secret: 'db-password' }],
      }),
    ).rejects.toThrow(/ssh:/i);
  });
});

/**
 * #170: the node's real `wireAgentSession`/`forwardInitialSessionState`
 * wiring actually sends a relay-visible `attention_hint` for the two
 * attention-inbox classes with a live source at v1 — `awaiting_input` and
 * `session_outcome` — and the relay's existing presence-aware push delivery
 * (`packages/relay/src/relay.ts`'s `maybeSendAttentionPush`, already proven
 * against a simulated `permission_request` in
 * `packages/relay/src/push-delivery.test.ts`) actually fires off it. Each
 * test here starts its OWN push-enabled relay (the shared `relay` from the
 * outer `beforeEach` has no push config, matching every other describe
 * block in this file) and closes it itself in a `finally`, since it is not
 * the shared fixture the outer `afterEach` tears down.
 */
describe('attention_hint push trigger (#170)', () => {
  interface RecordedPush {
    endpoint: string;
    sessionId: string;
    kind: string;
  }

  /** Mirrors `packages/relay/src/push-delivery.test.ts`'s own fake-sender pattern, but exercised through a real NodeDaemon rather than a simulated raw wire message — proving the actual `node-daemon.ts` wiring (not just the relay's own handling) drives the push. */
  async function startPushRelay(): Promise<{ relay: StartedRelay; calls: RecordedPush[] }> {
    const calls: RecordedPush[] = [];
    const pushRelay = await startRelay({
      push: {
        vapidKeys: { publicKey: 'test-attention-pub', privateKey: 'test-attention-priv' },
        subject: 'mailto:ops@example.com',
        sender: {
          async send(target, _vapidKeys, _subject, payload) {
            calls.push({
              endpoint: target.endpoint,
              sessionId: payload.sessionId,
              kind: payload.kind,
            });
            return { expired: false };
          },
        },
      },
    });
    return { relay: pushRelay, calls };
  }

  async function subscribeDevice(
    httpUrl: string,
    accountId: string,
    deviceId: string,
    endpoint: string,
  ): Promise<void> {
    const response = await fetch(`${httpUrl}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accountId}` },
      body: JSON.stringify({ deviceId, endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    });
    expect(response.status).toBe(204);
  }

  it('pushes the initial awaiting_input hint to a device with no live client connection, and not to one that is currently connected', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attention-awaiting';
    const { relay: pushRelay, calls } = await startPushRelay();

    try {
      const httpUrl = pushRelay.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
      await subscribeDevice(
        httpUrl,
        accountId,
        'device-connected',
        'https://push.example/connected',
      );
      await subscribeDevice(httpUrl, accountId, 'device-absent', 'https://push.example/absent');

      // device-connected has a LIVE client connection right now.
      phone = new TestPhone(pushRelay.url, {
        deviceId: 'device-connected',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;

      node = createNode({
        relayUrl: pushRelay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-attention-awaiting',
        deviceId: 'device-node-attention-awaiting',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });

      const session = await node.createSession({ projectPath, provider: 'test-echo' });

      await vi.waitFor(() => {
        expect(calls.some((call) => call.sessionId === session.id)).toBe(true);
      });

      const sessionCalls = calls.filter((call) => call.sessionId === session.id);
      expect(sessionCalls).toEqual([
        {
          endpoint: 'https://push.example/absent',
          sessionId: session.id,
          kind: 'awaiting_input',
        },
      ]);
    } finally {
      await pushRelay.close();
    }
  });

  it('pushes a session_outcome hint when the agent crashes mid-session, only to the absent device', async () => {
    const amk = generateAmk();
    const accountId = 'acct-attention-outcome';
    const { relay: pushRelay, calls } = await startPushRelay();

    try {
      const httpUrl = pushRelay.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
      await subscribeDevice(
        httpUrl,
        accountId,
        'device-connected',
        'https://push.example/connected',
      );
      await subscribeDevice(httpUrl, accountId, 'device-absent', 'https://push.example/absent');

      phone = new TestPhone(pushRelay.url, {
        deviceId: 'device-connected',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;

      node = createNode({
        relayUrl: pushRelay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-attention-outcome',
        deviceId: 'device-node-attention-outcome',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [crashProvider()] }),
      });

      const session = await node.createSession({ projectPath, provider: 'test-crash' });

      await vi.waitFor(() => {
        expect(
          calls.some((call) => call.sessionId === session.id && call.kind === 'session_outcome'),
        ).toBe(true);
      });

      const sessionCalls = calls.filter((call) => call.sessionId === session.id);
      // Every push this session ever triggered (its initial awaiting_input
      // hint, then its session_outcome hint once the agent crashed) went to
      // the absent device only — the connected device's own live client
      // connection suppressed it the whole time, the same presence check
      // #163's permission_request push already relies on.
      expect(sessionCalls.every((call) => call.endpoint === 'https://push.example/absent')).toBe(
        true,
      );
      expect(sessionCalls.map((call) => call.kind)).toContain('session_outcome');
    } finally {
      await pushRelay.close();
    }
  });
});

/**
 * #373: unlike `awaiting_input`/`session_outcome` above, a live tool-call
 * approval has its own dedicated top-level wire message — the real
 * `permission_request` (`@loombox/protocol`'s `steering.ts`) — rather than
 * the metadata-only `attention_hint` mirror those two classes ride (see
 * `attentionHintClassForStatus`'s doc comment in `node-daemon.ts`). These
 * tests prove the actual `node-daemon.ts` wiring (`sendPermissionRequest`)
 * constructs and sends that message on a live permission-required
 * transition: first that a connected client actually receives it,
 * decryptable, with the real `toolCall`/`options` content (closing the gap
 * `apps/web`'s `relay-client.ts`'s `PermissionRequestPayload` doc comment
 * flagged: "No node in this repo emits `permission_request` yet"); then
 * that the relay's already-tested presence-aware push
 * (`push-delivery.test.ts`'s `'permission_required'`-kind coverage)
 * actually fires off it end to end, mirroring #372's own crash/
 * awaiting_input push-trigger tests above.
 */
describe('permission_request (#373 approval signal)', () => {
  it('sends the real permission_request message, decryptable by a connected client, when a live tool call needs approval', async () => {
    const amk = generateAmk();
    const accountId = 'acct-permission-request';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-permission-request',
      deviceId: 'device-node-permission-request',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [permissionProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-permission' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-permission',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    // Subscribe before prompting: `permission_request` fans out live-only
    // (no resync ring, same as `blob_ref`/`fs_list_response`), so a
    // subscription registered after the agent's request would miss it.
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor(
      (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === session.id,
    );

    // Fired without awaiting: the fixture's `session/request_permission`
    // never gets a response here (no `permission_response` wire handling is
    // in scope for #373), so the underlying `session/prompt` call would
    // hang forever — this test only needs the live transition to have
    // happened, not the turn to finish.
    node.promptSession(session.id, 'request-permission').catch(() => {});

    const message = (await phone.waitFor(
      (m) => m.type === 'permission_request' && m.sessionId === session.id,
    )) as PermissionRequest;
    expect(message.requestId).toBeTruthy();

    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    const payload = await phoneOpen<{
      toolCall: { id: string; title: string };
      options: { optionId: string }[];
    }>(session.id, message.envelope, key);

    expect(payload.toolCall.id).toBe('tc1');
    expect(payload.toolCall.title).toBe('Edit file');
    expect(payload.options.map((option) => option.optionId).sort()).toEqual(['allow', 'deny']);
    // The relay only ever carried this ciphertext: the tool-call title is
    // not recoverable from it (SPEC §8's metadata boundary).
    assertOpaque(message.envelope, ['Edit file']);

    // The encrypted session_status event still rides alongside this,
    // unchanged — this message is additive, never a replacement.
    const statusEvents = await waitForDecryptedKinds(phone, session.id, key, ['session_status'], 1);
    expect(statusEvents.some((event) => event.status === 'permission_required')).toBe(true);
  });
});

/**
 * #373's other half: an absent device gets the presence-aware push the
 * relay's `case 'permission_request'` already fires on (#163), driven here
 * by real `node-daemon.ts` code rather than a simulated raw wire message —
 * mirrors `describe('attention_hint push trigger (#170)')` above exactly,
 * including its own push-enabled relay (the shared `relay` from the outer
 * `beforeEach` has no push config).
 */
describe('permission_request push trigger (#373)', () => {
  interface RecordedPush {
    endpoint: string;
    sessionId: string;
    kind: string;
  }

  async function startPushRelay(): Promise<{ relay: StartedRelay; calls: RecordedPush[] }> {
    const calls: RecordedPush[] = [];
    const pushRelay = await startRelay({
      push: {
        vapidKeys: {
          publicKey: 'test-permission-push-pub',
          privateKey: 'test-permission-push-priv',
        },
        subject: 'mailto:ops@example.com',
        sender: {
          async send(target, _vapidKeys, _subject, payload) {
            calls.push({
              endpoint: target.endpoint,
              sessionId: payload.sessionId,
              kind: payload.kind,
            });
            return { expired: false };
          },
        },
      },
    });
    return { relay: pushRelay, calls };
  }

  async function subscribeDevice(
    httpUrl: string,
    accountId: string,
    deviceId: string,
    endpoint: string,
  ): Promise<void> {
    const response = await fetch(`${httpUrl}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accountId}` },
      body: JSON.stringify({ deviceId, endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    });
    expect(response.status).toBe(204);
  }

  it('pushes a permission_required push to an absent device, and not to one that is currently connected, when a live tool call needs approval', async () => {
    const amk = generateAmk();
    const accountId = 'acct-permission-push';
    const { relay: pushRelay, calls } = await startPushRelay();

    try {
      const httpUrl = pushRelay.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
      await subscribeDevice(
        httpUrl,
        accountId,
        'device-connected',
        'https://push.example/connected',
      );
      await subscribeDevice(httpUrl, accountId, 'device-absent', 'https://push.example/absent');

      // device-connected has a LIVE client connection right now.
      phone = new TestPhone(pushRelay.url, {
        deviceId: 'device-connected',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;

      node = createNode({
        relayUrl: pushRelay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-permission-push',
        deviceId: 'device-node-permission-push',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [permissionProvider()] }),
      });

      const session = await node.createSession({ projectPath, provider: 'test-permission' });
      // See the previous describe block's test for why this is fired
      // without awaiting it.
      node.promptSession(session.id, 'request-permission').catch(() => {});

      await vi.waitFor(() => {
        expect(
          calls.some(
            (call) => call.sessionId === session.id && call.kind === 'permission_required',
          ),
        ).toBe(true);
      });

      const sessionCalls = calls.filter(
        (call) => call.sessionId === session.id && call.kind === 'permission_required',
      );
      // Every permission_required push this session triggered went to the
      // absent device only — the connected device's own live client
      // connection suppressed it, the same presence check #163's original
      // permission_request push already relied on.
      expect(sessionCalls).toEqual([
        {
          endpoint: 'https://push.example/absent',
          sessionId: session.id,
          kind: 'permission_required',
        },
      ]);
    } finally {
      await pushRelay.close();
    }
  });
});

describe('NodeDaemon session archive (SPEC §7.2, issue #512)', () => {
  it('deletes the worktree directory and its loombox/session-<id> branch when removeWorktree is true, forgets the record, and replies outcome: "ok"', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-worktree';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-archive-worktree',
      deviceId: 'device-node-archive-worktree',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    expect(session.branch).not.toBe('');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-archive-worktree',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req_archive_worktree',
      sessionId: session.id,
      removeWorktree: true,
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'session_archive_response',
    )) as SessionArchiveResponse;
    expect(response.requestId).toBe('req_archive_worktree');
    expect(response.sessionId).toBe(session.id);
    expect(response.result).toEqual({ outcome: 'ok' });

    await expect(stat(session.worktreePath)).rejects.toThrow();
    const worktreeList = await git(projectPath, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).not.toContain(session.worktreePath);
    const branches = await git(projectPath, ['branch', '--list', session.branch]);
    expect(branches).toBe('');

    // The relay's own board copy is gone too — a fresh session_list no
    // longer carries it.
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const list = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    expect(list.sessions.some((s) => s.session.id === session.id)).toBe(false);
  });

  it('leaves the worktree and branch on disk when removeWorktree is false, but still forgets the record and drops it from the board', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-keep-worktree';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-archive-keep-worktree',
      deviceId: 'device-node-archive-keep-worktree',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await node.createSession({ projectPath, provider: 'test-echo' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-archive-keep-worktree',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req_archive_keep_worktree',
      sessionId: session.id,
      removeWorktree: false,
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'session_archive_response',
    )) as SessionArchiveResponse;
    expect(response.result).toEqual({ outcome: 'ok' });

    const dirStat = await stat(session.worktreePath);
    expect(dirStat.isDirectory()).toBe(true);
    const worktreeList = await git(projectPath, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).toContain(session.worktreePath);
    const branches = await git(projectPath, ['branch', '--list', session.branch]);
    expect(branches).toContain(session.branch);

    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const list = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    expect(list.sessions.some((s) => s.session.id === session.id)).toBe(false);
  });

  it('leaves the project folder alone for an in-place session even when removeWorktree is true — there is no worktree of its own to remove', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-inplace';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-archive-inplace',
      deviceId: 'device-node-archive-inplace',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await node.createSession({
      projectPath,
      provider: 'test-echo',
      worktree: false,
    });
    expect(session.branch).toBe('');
    expect(session.worktreePath).toBe(projectPath);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-archive-inplace',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req_archive_inplace',
      sessionId: session.id,
      removeWorktree: true,
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'session_archive_response',
    )) as SessionArchiveResponse;
    expect(response.result).toEqual({ outcome: 'ok' });

    const dirStat = await stat(projectPath);
    expect(dirStat.isDirectory()).toBe(true);
    const insideWorkTree = await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
    expect(insideWorkTree).toBe('true');
  });

  it('a git failure archiving comes back as outcome: "error" with a usable message, instead of throwing', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-git-failure';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-archive-git-failure',
      deviceId: 'device-node-archive-git-failure',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await node.createSession({ projectPath, provider: 'test-echo' });

    // Sabotage the repo so the worktree/branch teardown's git commands
    // genuinely fail, instead of faking an error return.
    await rm(pathJoin(projectPath, '.git'), { recursive: true, force: true });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-archive-git-failure',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req_archive_git_failure',
      sessionId: session.id,
      removeWorktree: true,
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'session_archive_response',
    )) as SessionArchiveResponse;
    expect(response.result.outcome).toBe('error');
    if (response.result.outcome !== 'error') throw new Error('unreachable');
    expect(response.result.message.length).toBeGreaterThan(0);
  });

  it('answers ok for a session it no longer tracks, so a node restart cannot leave a permanently unarchivable row', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-forgotten';

    const sessionManager = new SessionManager();
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-archive-forgotten',
      deviceId: 'device-node-archive-forgotten',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      sessionManager,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await node.createSession({ projectPath, provider: 'test-echo' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-archive-forgotten',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    // Exactly what a node restart does to `SessionManager`'s in-memory
    // records while the relay's Postgres-backed board keeps the row. Done
    // through the manager's own API rather than a test-only hook, and
    // without touching disk, so the worktree survives just as it would.
    await sessionManager.removeSession(session.id, { removeWorktree: false });

    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req_archive_forgotten',
      sessionId: session.id,
      removeWorktree: true,
    });

    const response = (await phone.waitFor(
      (m) => m.type === 'session_archive_response',
    )) as SessionArchiveResponse;
    expect(response.result).toEqual({ outcome: 'ok' });

    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const list = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    expect(list.sessions.some((s) => s.session.id === session.id)).toBe(false);
  });
});

describe('NodeDaemon per-target concurrency caps (SPEC §7.16, issue #252)', () => {
  /**
   * Subscribes `testPhone` to `sessionId`'s live session_status stream,
   * exactly once: `resync_request` backfills anything already sent before
   * this call (e.g. an early 'queued'/'starting' status), and
   * `session_resume` subscribes this connection for everything sent AFTER
   * this point. Every assertion below relies on calling this exactly once
   * per session — `resync_request` replays a session's *entire* history
   * from `sinceSeq`, so calling it twice duplicates every earlier status
   * in `testPhone.messages`, and `waitForDecryptedKinds` doesn't dedupe.
   */
  function subscribeSession(testPhone: TestPhone, sessionId: string): void {
    testPhone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      sinceSeq: 0,
    });
    testPhone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
  }

  it('queues a session started over the cap instead of launching it, while a session under the cap starts immediately', async () => {
    const amk = generateAmk();
    const accountId = 'acct-concurrency-queue';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-concurrency-queue',
      deviceId: 'device-node-concurrency-queue',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      localMaxConcurrentSessions: 1,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session1 = await node.createSession({ projectPath, provider: 'test-echo' });
    const session2 = await node.createSession({ projectPath, provider: 'test-echo' });
    expect(session2.id).not.toBe(session1.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-concurrency-queue',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const key1 = await derivePhoneSessionKey(amk, accountId, session1.id);
    subscribeSession(phone, session1.id);
    const session1Statuses = await waitForDecryptedKinds(
      phone,
      session1.id,
      key1,
      ['session_status'],
      2,
    );
    expect(session1Statuses.map((e) => e.status)).toEqual(['starting', 'awaiting_input']);

    // Over the cap: queued, not launched — its own status vocabulary says
    // so, distinct from 'starting' (issue #252's "tell a queued session
    // from a starting one").
    const key2 = await derivePhoneSessionKey(amk, accountId, session2.id);
    subscribeSession(phone, session2.id);
    const session2Statuses = await waitForDecryptedKinds(
      phone,
      session2.id,
      key2,
      ['session_status'],
      1,
    );
    expect(session2Statuses.map((e) => e.status)).toEqual(['queued']);

    // Genuinely not running yet: no bridge exists for it, so there is
    // nothing this node could possibly prompt.
    await expect(node.promptSession(session2.id, 'hi')).rejects.toThrow(/no session/i);
  });

  it('drains two queued sessions in FIFO order as the running session is stopped, one release at a time', async () => {
    const amk = generateAmk();
    const accountId = 'acct-concurrency-fifo';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-concurrency-fifo',
      deviceId: 'device-node-concurrency-fifo',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      localMaxConcurrentSessions: 1,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session1 = await node.createSession({ projectPath, provider: 'test-echo' });
    const session2 = await node.createSession({ projectPath, provider: 'test-echo' });
    const session3 = await node.createSession({ projectPath, provider: 'test-echo' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-concurrency-fifo',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const key1 = await derivePhoneSessionKey(amk, accountId, session1.id);
    const key2 = await derivePhoneSessionKey(amk, accountId, session2.id);
    const key3 = await derivePhoneSessionKey(amk, accountId, session3.id);
    subscribeSession(phone, session1.id);
    subscribeSession(phone, session2.id);
    subscribeSession(phone, session3.id);

    // Both genuinely queued, in creation order, before anything releases.
    expect(
      (await waitForDecryptedKinds(phone, session2.id, key2, ['session_status'], 1)).map(
        (e) => e.status,
      ),
    ).toEqual(['queued']);
    expect(
      (await waitForDecryptedKinds(phone, session3.id, key3, ['session_status'], 1)).map(
        (e) => e.status,
      ),
    ).toEqual(['queued']);

    // Stop session1 (SPEC §7.16's "queued sessions start... as running
    // ones finish or are stopped"): session2, the OLDER of the two
    // waiters, must be the one to dequeue — never session3. Waited for
    // via session1's OWN 'exited' status, not merely the archive
    // response (which can arrive before the underlying child process has
    // actually finished exiting) — the same synchronous exit-then-release
    // guarantee the crash test relies on (`wireAgentSession`'s 'exit'
    // listener).
    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-fifo-stop-1',
      sessionId: session1.id,
      removeWorktree: true,
    });
    const session1Statuses = await waitForDecryptedKinds(
      phone,
      session1.id,
      key1,
      ['session_status'],
      3,
    );
    expect(session1Statuses[2]!.status).toBe('exited');

    const session2Statuses = await waitForDecryptedKinds(
      phone,
      session2.id,
      key2,
      ['session_status'],
      // Waits for 'awaiting_input' too, not just 'starting': only once
      // that lands is session2's bridge actually registered
      // (`finishSessionCreation`), so stopping it below has something to
      // find — stopping too early, mid-spawn, would be a silent no-op.
      3,
    );
    expect(session2Statuses[0]!.status).toBe('queued');
    expect(session2Statuses[1]!.status).toBe('starting');
    expect(session2Statuses[2]!.status).toBe('awaiting_input');

    // session3 must still be exactly queued — nothing should have
    // touched it yet.
    expect(
      (await waitForDecryptedKinds(phone, session3.id, key3, ['session_status'], 1)).map(
        (e) => e.status,
      ),
    ).toEqual(['queued']);

    // Stop session2 too: NOW session3 gets its turn — waited for the
    // same deterministic way.
    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-fifo-stop-2',
      sessionId: session2.id,
      removeWorktree: true,
    });
    const session2FinalStatuses = await waitForDecryptedKinds(
      phone,
      session2.id,
      key2,
      ['session_status'],
      4,
    );
    expect(session2FinalStatuses[3]!.status).toBe('exited');

    const session3Statuses = await waitForDecryptedKinds(
      phone,
      session3.id,
      key3,
      ['session_status'],
      2,
    );
    expect(session3Statuses[0]!.status).toBe('queued');
    expect(session3Statuses[1]!.status).toBe('starting');
  }, 20_000);

  it('a crashed session releases its slot immediately, so the next session starts without ever queueing', async () => {
    const amk = generateAmk();
    const accountId = 'acct-concurrency-crash';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-concurrency-crash',
      deviceId: 'device-node-concurrency-crash',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      localMaxConcurrentSessions: 1,
      supervisor: new AgentSupervisor({ providers: [crashProvider(), echoProvider()] }),
    });

    const session1 = await node.createSession({ projectPath, provider: 'test-crash' });
    const key1 = await derivePhoneSessionKey(amk, accountId, session1.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-concurrency-crash',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    // Subscribed BEFORE the crash lands (~20ms after the session comes
    // up), so the live 'exited' push actually reaches this phone — a
    // one-shot `resync_request` alone cannot see an event that hasn't
    // happened yet.
    subscribeSession(phone, session1.id);

    // By the time 'exited' is observable on the wire,
    // `wireAgentSession`'s 'exit' listener has already released the slot:
    // both fire synchronously from the same underlying child-process
    // 'exit' event (`AgentSession.handleTerminal`).
    const session1Statuses = await waitForDecryptedKinds(
      phone,
      session1.id,
      key1,
      ['session_status'],
      3,
    );
    expect(session1Statuses.map((e) => e.status)).toEqual(['starting', 'awaiting_input', 'exited']);

    // The slot session1 held is free again — a fresh session must start
    // immediately, never sit queued behind a session that is actually gone
    // (SPEC §7.16: "this is the leak that would make the feature worse
    // than nothing").
    const session2 = await node.createSession({ projectPath, provider: 'test-echo' });
    const key2 = await derivePhoneSessionKey(amk, accountId, session2.id);
    subscribeSession(phone, session2.id);
    const session2Statuses = await waitForDecryptedKinds(
      phone,
      session2.id,
      key2,
      ['session_status'],
      2,
    );
    expect(session2Statuses.map((e) => e.status)).toEqual(['starting', 'awaiting_input']);
  });

  it('cancelling a queued session removes it from the queue and it never launches, even after the running session stops', async () => {
    const amk = generateAmk();
    const accountId = 'acct-concurrency-cancel';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-concurrency-cancel',
      deviceId: 'device-node-concurrency-cancel',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      localMaxConcurrentSessions: 1,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session1 = await node.createSession({ projectPath, provider: 'test-echo' });
    const session2 = await node.createSession({ projectPath, provider: 'test-echo' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-concurrency-cancel',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const key1 = await derivePhoneSessionKey(amk, accountId, session1.id);
    const key2 = await derivePhoneSessionKey(amk, accountId, session2.id);
    subscribeSession(phone, session1.id);
    subscribeSession(phone, session2.id);
    expect(
      (await waitForDecryptedKinds(phone, session2.id, key2, ['session_status'], 1)).map(
        (e) => e.status,
      ),
    ).toEqual(['queued']);

    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-cancel-queued',
      sessionId: session2.id,
      removeWorktree: true,
    });
    const cancelResponse = (await phone.waitFor(
      (m) =>
        m.type === 'session_archive_response' &&
        (m as SessionArchiveResponse).requestId === 'req-cancel-queued',
    )) as SessionArchiveResponse;
    expect(cancelResponse.result).toEqual({ outcome: 'ok' });

    // Now free session1's slot — if the cancellation above had failed to
    // withdraw session2 from the queue, THIS is exactly the moment it
    // would wrongly launch. Waited for via session1's OWN 'exited' status
    // (the same synchronous exit-then-release guarantee the crash test
    // relies on), not merely the archive response, so the check below
    // isn't racing the underlying child process actually finishing exit.
    phone.send({
      type: 'session_archive_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-cancel-stop-1',
      sessionId: session1.id,
      removeWorktree: true,
    });
    const session1Statuses = await waitForDecryptedKinds(
      phone,
      session1.id,
      key1,
      ['session_status'],
      3,
    );
    expect(session1Statuses[2]!.status).toBe('exited');

    // Still genuinely not running: no bridge was ever created for the
    // cancelled session2, so there is nothing this node could prompt.
    await expect(node.promptSession(session2.id, 'hi')).rejects.toThrow(/no session/i);

    // The slot really is free again — a fresh session starts immediately,
    // never queued behind the cancelled session2.
    const session3 = await node.createSession({ projectPath, provider: 'test-echo' });
    const key3 = await derivePhoneSessionKey(amk, accountId, session3.id);
    subscribeSession(phone, session3.id);
    const session3Statuses = await waitForDecryptedKinds(
      phone,
      session3.id,
      key3,
      ['session_status'],
      1,
    );
    expect(session3Statuses[0]!.status).toBe('starting');
  });

  it('the default local cap is sane, not a tiny magic number: several sessions start immediately with no cap configured', async () => {
    const amk = generateAmk();
    const accountId = 'acct-concurrency-default';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-concurrency-default',
      deviceId: 'device-node-concurrency-default',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      // No `localMaxConcurrentSessions` override — exercises
      // `defaultLocalMaxConcurrentSessions()` (this host's own CPU core
      // count, see target.ts), the same default `main.ts`'s real
      // `createNode()` call gets.
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session1 = await node.createSession({ projectPath, provider: 'test-echo' });
    const session2 = await node.createSession({ projectPath, provider: 'test-echo' });
    const session3 = await node.createSession({ projectPath, provider: 'test-echo' });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-concurrency-default',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    for (const session of [session1, session2, session3]) {
      const key = await derivePhoneSessionKey(amk, accountId, session.id);
      subscribeSession(phone, session.id);
      const statuses = await waitForDecryptedKinds(phone, session.id, key, ['session_status'], 1);
      // None of them ever queued — a sane default comfortably covers 3
      // concurrent sessions on any real development machine.
      expect(statuses[0]!.status).toBe('starting');
    }
  });
});

describe('NodeDaemon: session fork (design spec `2026-08-05-zed-parity-decisions.md` §3 C6-2, issue #746)', () => {
  it("forks a session from its first turn: the fork's transcript ends there, the source keeps every turn unaffected, and the fork behaves like any other session", async () => {
    const amk = generateAmk();
    const accountId = 'acct-fork-basic';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fork',
      deviceId: 'device-node-fork',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const source = await node.createSession({ projectPath, provider: 'test-echo' });
    const sourceKey = await derivePhoneSessionKey(amk, accountId, source.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fork-source',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: source.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    await node.promptSession(source.id, 'first turn');
    // The fork boundary is the AGENT's own per-turn id
    // (`AcpClient`'s `turn:${n}`, stamped onto every `AcpTranscriptUpdate`
    // it emits) — NOT the wire's separate `turn_started`/`turn_ended`
    // `turnId` (`NodeDaemon.beginTurn`'s own synthesized uuid, a different
    // id space purely for that framing pair). This is exactly the id a
    // client's own `TranscriptItem.turnId` already carries (populated by
    // `reduceTranscript` straight off the same `AcpTranscriptUpdate`s).
    const [turn1Chunk] = await waitForDecryptedKinds(
      phone,
      source.id,
      sourceKey,
      ['agent_message_chunk'],
      1,
    );
    const turn1Id = turn1Chunk!.turnId!;

    await node.promptSession(source.id, 'second turn');
    await waitForDecryptedKinds(phone, source.id, sourceKey, ['turn_ended'], 2);

    const fork = await node.forkSession(source.id, turn1Id);

    expect(fork.id).not.toBe(source.id);
    expect(fork.worktreePath).not.toBe(source.worktreePath);
    expect(fork.target).toBe('local');
    expect(fork.provider).toBe(source.provider);

    const forkKey = await derivePhoneSessionKey(amk, accountId, fork.id);
    // `session_resume` alone only subscribes for what's sent AFTER this
    // point (`relay.ts`'s own handler); the fork's seeded history was
    // already sent (and ring-buffered) the instant `forkSession()`
    // resolved, above, so `resync_request` from seq 0 backfills it —
    // the exact pairing this file's own `subscribeSession` helper uses
    // for the identical "might already have missed the start" reason.
    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: fork.id,
      sinceSeq: 0,
    });
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: fork.id });
    await phone.waitFor(
      (m) => m.type === 'session_announce' && (m as SessionAnnounceV1).session.id === fork.id,
    );

    // The fork's own transcript ends at turn 1: exactly one turn's worth of
    // chunks arrives, never a second (turn 2 was never copied).
    const forkChunks = await waitForDecryptedKinds(
      phone,
      fork.id,
      forkKey,
      ['agent_message_chunk'],
      2,
    );
    expect(forkChunks.every((chunk) => chunk.turnId === turn1Id)).toBe(true);
    expect(forkChunks.map((chunk) => chunk.text).join('')).toBe('Hello world');
    // Give a stray, wrongly-copied second turn a real chance to show up
    // before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      phone.messages.filter(
        (m): m is SessionUpdateEnvelopeV1 => m.type === 'session_update' && m.sessionId === fork.id,
      ).length,
    ).toBeLessThan(8); // status/config snapshot + turn 1's own handful of events, never turn 2's too

    // The source's own transcript is untouched: both turns are still there.
    const sourceChunks = await waitForDecryptedKinds(
      phone,
      source.id,
      sourceKey,
      ['agent_message_chunk'],
      4,
    );
    expect(sourceChunks).toHaveLength(4);

    // The fork behaves like any other session: it can be prompted
    // immediately, producing genuinely new output on top of the 2 seeded
    // chunks (never turn_started/turn_ended for the seed itself — only a
    // live prompt produces those).
    await node.promptSession(fork.id, 'diverge from here');
    const [forkTurnEnded] = await waitForDecryptedKinds(phone, fork.id, forkKey, ['turn_ended'], 1);
    expect(forkTurnEnded!.stopReason).toBe('end_turn');
    const allForkChunks = await waitForDecryptedKinds(
      phone,
      fork.id,
      forkKey,
      ['agent_message_chunk'],
      4,
    );
    expect(allForkChunks).toHaveLength(4);
  });

  it('refuses to fork an unknown source session, with a visible reason, and creates nothing', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fork-unknown-source';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fork-refuse',
      deviceId: 'device-node-fork-refuse',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    await expect(node.forkSession('does-not-exist', 'turn_1')).rejects.toThrow(/no session/i);
  });

  it('refuses to fork a turn id that never occurred in the source transcript, without creating a new session', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fork-bad-turn';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-fork-bad-turn',
      deviceId: 'device-node-fork-bad-turn',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const source = await node.createSession({ projectPath, provider: 'test-echo' });
    await node.promptSession(source.id, 'only turn');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-fork-bad-turn',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const before = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;

    await expect(node.forkSession(source.id, 'turn-that-never-happened')).rejects.toThrow(
      /not found/i,
    );

    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const after = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    expect(after.sessions.length).toBe(before.sessions.length);
  });
});
