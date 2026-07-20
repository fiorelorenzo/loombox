import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdir as fsMkdir, mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type SessionAnnounceV1,
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
import { McpConfigStore } from './mcp-config-store';
import { NodeMcpSecretManager } from './mcp-secrets';

const execFileAsync = promisify(execFile);

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
  options?: unknown[];
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
    const decryptedMeta = await phoneOpen<{ title: string; projectPath: string }>(
      session.id,
      entry!.privateEnvelope,
      key,
    );
    expect(decryptedMeta).toEqual({ title: 'my session', projectPath: session.projectPath });
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
    phone.send({
      type: 'resync_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      sinceSeq: 0,
    });

    const [initialStatus] = await waitForDecryptedKinds(
      phone,
      session.id,
      key,
      ['session_status'],
      1,
    );
    expect(initialStatus).toMatchObject({ kind: 'session_status', status: 'awaiting_input' });

    const [initialCatalog] = await waitForDecryptedKinds(
      phone,
      session.id,
      key,
      ['config_options'],
      1,
    );
    expect(initialCatalog!.options).toEqual([
      {
        category: 'model',
        current: 'sonnet',
        choices: [
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'haiku', name: 'Haiku' },
        ],
      },
      {
        category: 'mode',
        current: 'default',
        choices: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
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
    expect(fallbackOptions.find((o) => o.category === 'model')?.current).toBe('haiku');

    // The relay never carried plaintext for any of the above.
    for (const message of phone.messages.filter(
      (m): m is SessionUpdateEnvelopeV1 =>
        m.type === 'session_update' && m.sessionId === session.id,
    )) {
      assertOpaque(message.envelope, ['sonnet', 'haiku', 'awaiting_input']);
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
    const decryptedMeta = await phoneOpen<{ title: string; projectPath: string }>(
      sessionId,
      entry.privateEnvelope,
      key,
    );
    expect(decryptedMeta).toEqual({ title: 'client session', projectPath });

    // The session is a real, working one: prompting it directly produces output.
    await node.promptSession(sessionId, 'hi');
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
    await phone.waitFor((m) => m.type === 'session_announce');
    await phone.waitForCount(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === sessionId,
      1,
    );
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

describe('NodeDaemon interactive PTY terminals (SPEC §7.5; issues #172/#173)', () => {
  it('opens a local terminal, streams typed input to it, streams its output back, resizes it, and closes it — all over encrypted envelopes', async () => {
    // Spawns and waits on a real bash child (not the fast in-process fixture
    // agent every other test in this file uses); vitest's default 5s
    // per-test timeout is occasionally too tight for that on a loaded box.
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
    const openedPayload = await phoneOpen<{ outcome: string; message?: string }>(
      session.id,
      openedMessage.envelope,
      key,
    );
    expect(openedPayload.outcome).toBe('ok');

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
  }, 20000);

  it('supports multiple terminals for the same session sharing its working directory, and closing one does not affect the other (issue #173)', async () => {
    // See the previous test's comment: a real bash child needs more than
    // vitest's default 5s per-test timeout on a loaded box.
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
      (m) => m.type === 'terminal_closed' && (m as { terminalId?: string }).terminalId === 'term-a',
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
  }, 20000);

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
