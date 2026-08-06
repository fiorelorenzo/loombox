import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type SpendCapResultPayloadV1,
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

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * The full wire-level proof for SPEC §7.16/issue #251's spend caps: a
 * real relay, a real encrypted session, a real agent process
 * (`spend-cap-acp-agent.mjs`, scripted entirely through the prompt text —
 * see that fixture's own doc comment) driving `NodeDaemon.
 * maybeApplySpendCap`'s actual enforcement, never a mock of the matcher
 * or of `SessionManager`. Harness duplicated from `node-daemon-
 * permission-policy.test.ts` (this package's own established per-file
 * convention) rather than shared, so this file stays self-contained.
 */

function spendCapProvider(): AcpProvider {
  return {
    id: 'test-spend-cap',
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
          'spend-cap-acp-agent.mjs',
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

/**
 * A real delay, not a fake-timer advance — deliberate (see this repo's
 * "no real wall-clock timers in tests" rule): every wait in this file is
 * against a REAL relay over a REAL WebSocket and a REAL spawned agent
 * process (SPEC §16), none of which a fake clock can advance. Named and
 * centralized here rather than inlined at each call site, mirroring the
 * identical `setTimeout` polling already established in `node-daemon-
 * permission-policy.test.ts`'s own `waitFor`/`waitForTerminalOutputContains`.
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

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
      if (Date.now() > deadline)
        throw new Error('TestPhone: timed out waiting for a matching message');
      await sleep(10);
    }
  }

  /** Type-safe sibling of {@link waitFor}: narrows to one `WireMessageV1` variant by its `type` discriminant, so a call site reads `.requestId`/`.envelope` off the real field, never an inline `as` cast. */
  async waitForType<T extends WireMessageV1['type']>(
    type: T,
    predicate: (message: Extract<WireMessageV1, { type: T }>) => boolean = () => true,
    timeoutMs = 10000,
  ): Promise<Extract<WireMessageV1, { type: T }>> {
    const isMatch = (m: WireMessageV1): m is Extract<WireMessageV1, { type: T }> => m.type === type;
    const found = await this.waitFor((m) => isMatch(m) && predicate(m), timeoutMs);
    if (!isMatch(found)) throw new Error(`TestPhone: matched message was not of type ${type}`);
    return found;
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
let sessionKey: CryptoKey;
let currentSessionId: string;
let promptCounter = 0;
let requestCounter = 0;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-spend-cap-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-spend-cap-state-'));
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

/** Creates a node + session + subscribed phone over the real wire — the shared setup every test in this file starts from. */
async function createSpendCapSession(): Promise<void> {
  const amk = generateAmk();
  const accountId = 'acct-spend-cap';

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-spend-cap',
    deviceId: 'device-node-spend-cap',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [spendCapProvider()] }),
  });

  const session = await node.createSession({ projectPath, provider: 'test-spend-cap' });
  currentSessionId = session.id;
  sessionKey = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-spend-cap',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');
}

/** Sends a follow-up prompt over the real encrypted wire, exactly like the composer would. */
async function promptOverWire(text: string): Promise<void> {
  promptCounter += 1;
  const envelope = await phoneSeal(currentSessionId, { text }, sessionKey);
  phone!.send({
    type: 'prompt_inject',
    protocolVersion: PROTOCOL_V1,
    sessionId: currentSessionId,
    promptId: `prompt-${promptCounter}`,
    envelope,
  });
}

/** One decrypted `session_update` payload — every kind this file reads (`session_status`, `turn_ended`, `agent_message_chunk`, `usage_update`) shares this loose shape rather than a full discriminated union, since no test here needs to narrow further than `kind`/`status`/`reason`/`costUsd`. */
interface SessionEventPayload {
  kind: string;
  status?: string;
  reason?: string;
  costUsd?: number;
}

/** Every decrypted `session_update` payload seen so far for `currentSessionId`, in arrival order. */
async function decryptedSessionEvents(): Promise<SessionEventPayload[]> {
  const candidates = phone!.messages.filter(
    (m): m is Extract<WireMessageV1, { type: 'session_update' }> =>
      m.type === 'session_update' && m.sessionId === currentSessionId,
  );
  return Promise.all(
    candidates.map((m) => phoneOpen<SessionEventPayload>(currentSessionId, m.envelope, sessionKey)),
  );
}

async function waitForSessionStatus(
  status: string,
  timeoutMs = 10000,
): Promise<SessionEventPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await decryptedSessionEvents();
    const found = events.find((e) => e.kind === 'session_status' && e.status === status);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForSessionStatus: timed out waiting for status ${JSON.stringify(status)}`,
      );
    }
    await sleep(20);
  }
}

async function waitForTurnEnded(timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await decryptedSessionEvents();
    if (events.some((e) => e.kind === 'turn_ended')) return;
    if (Date.now() > deadline) throw new Error('waitForTurnEnded: timed out');
    await sleep(20);
  }
}

async function countAgentMessageChunks(): Promise<number> {
  const events = await decryptedSessionEvents();
  return events.filter((e) => e.kind === 'agent_message_chunk').length;
}

async function setCapOverWire(
  scope: 'project' | 'session',
  capUsd: number | null,
): Promise<SpendCapResultPayloadV1> {
  requestCounter += 1;
  const requestId = `req-cap-set-${requestCounter}`;
  const envelope = await phoneSeal(currentSessionId, { scope, capUsd }, sessionKey);
  phone!.send({
    type: 'spend_cap_set',
    protocolVersion: PROTOCOL_V1,
    sessionId: currentSessionId,
    requestId,
    envelope,
  });
  const result = await phone!.waitForType('spend_cap_result', (m) => m.requestId === requestId);
  return phoneOpen<SpendCapResultPayloadV1>(currentSessionId, result.envelope, sessionKey);
}

async function getCapOverWire(): Promise<SpendCapResultPayloadV1> {
  requestCounter += 1;
  const requestId = `req-cap-get-${requestCounter}`;
  phone!.send({
    type: 'spend_cap_get',
    protocolVersion: PROTOCOL_V1,
    sessionId: currentSessionId,
    requestId,
  });
  const result = await phone!.waitForType('spend_cap_result', (m) => m.requestId === requestId);
  return phoneOpen<SpendCapResultPayloadV1>(currentSessionId, result.envelope, sessionKey);
}

function resumeOverWire(): void {
  phone!.send({
    type: 'session_spend_cap_resume',
    protocolVersion: PROTOCOL_V1,
    sessionId: currentSessionId,
  });
}

describe('auto-pause on a crossed spend cap (SPEC §7.16; issue #251)', () => {
  it(
    'a session that crosses its cap pauses and says so',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);

      await promptOverWire('usage:6');

      const paused = await waitForSessionStatus('paused');
      expect(paused.reason).toContain('$6.00');
      expect(paused.reason).toContain('$5.00');
    },
  );

  it(
    'the project cap applies to a session with no session cap of its own',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);
      // No session-scoped cap set at all — only the project cap exists.

      await promptOverWire('usage:6');

      await waitForSessionStatus('paused');
    },
  );

  it(
    'the session cap wins when both project and session caps are set',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);
      await setCapOverWire('session', 20);

      // Over the PROJECT cap (5) but well under the SESSION cap (20) —
      // must NOT pause, proving the more-specific session cap governs.
      await promptOverWire('usage:6');
      await waitForTurnEnded();
      const eventsAfterFirst = await decryptedSessionEvents();
      expect(
        eventsAfterFirst.some((e) => e.kind === 'session_status' && e.status === 'paused'),
      ).toBe(false);

      // Now over the SESSION cap too — must pause, naming the session's
      // own $20.00 limit, not the project's $5.00.
      await promptOverWire('usage:22');
      const paused = await waitForSessionStatus('paused');
      expect(paused.reason).toContain('$20.00');
      expect(paused.reason).not.toContain('$5.00');
    },
  );

  it(
    'no usage_update ever arrived: the cap cannot trigger, no matter how low',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 0.01);

      await promptOverWire('no-usage');
      await waitForTurnEnded();

      const events = await decryptedSessionEvents();
      expect(events.some((e) => e.kind === 'session_status' && e.status === 'paused')).toBe(false);
    },
  );

  it(
    'a usage_update reporting tokens but no cost never trips the cap',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 0.01);

      await promptOverWire('tokens-only');
      await waitForTurnEnded();

      const events = await decryptedSessionEvents();
      expect(events.some((e) => e.kind === 'session_status' && e.status === 'paused')).toBe(false);
    },
  );

  it(
    'a cap crossed mid-turn does not pause until the turn actually settles',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);

      // Two usage_update notifications inside ONE turn, both over the cap
      // — the fixture sends them before its final RPC response, so the
      // agent is still 'working' when each lands.
      await promptOverWire('usage:6,9');

      const paused = await waitForSessionStatus('paused');
      const events = await decryptedSessionEvents();
      const secondUsageIndex = events.findIndex(
        (e) => e.kind === 'usage_update' && e.costUsd === 9,
      );
      const awaitingInputIndex = events.findIndex(
        (e) => e.kind === 'session_status' && e.status === 'awaiting_input',
      );
      const pausedIndex = events.findIndex(
        (e) => e.kind === 'session_status' && e.status === 'paused',
      );
      expect(secondUsageIndex).toBeGreaterThanOrEqual(0);
      expect(awaitingInputIndex).toBeGreaterThan(secondUsageIndex);
      // The pause landed only once the agent's own attention genuinely
      // left 'working' (the `awaiting_input` transition above) — never
      // synchronously with either usage_update while the turn was still
      // open, which is the actual "let it finish" guarantee, not merely
      // an ordering coincidence against `turn_ended`.
      expect(pausedIndex).toBeGreaterThan(awaitingInputIndex);
      expect(paused.reason).toContain('$9.00');
    },
  );

  it(
    'a paused session refuses a follow-up prompt (no reply channel, per issue #706 — logged and dropped)',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);
      await promptOverWire('usage:6');
      await waitForSessionStatus('paused');

      const chunksBefore = await countAgentMessageChunks();
      await promptOverWire('usage:1');
      await sleep(300);
      const chunksAfter = await countAgentMessageChunks();

      // Nothing new arrived from the agent — the prompt was never delivered.
      expect(chunksAfter).toBe(chunksBefore);
    },
  );
});

describe('resuming a spend-cap pause (SPEC §7.16; issue #251)', () => {
  it(
    'session_spend_cap_resume resumes explicitly, and the cap does not immediately re-fire for the same spend',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);
      await promptOverWire('usage:6');
      await waitForSessionStatus('paused');

      resumeOverWire();
      await waitForSessionStatus('awaiting_input');

      // Same absolute cumulative cost as before (6) — must NOT re-pause.
      await promptOverWire('usage:6');
      await waitForTurnEnded();
      const eventsAfterResume = await decryptedSessionEvents();
      const pausedCount = eventsAfterResume.filter(
        (e) => e.kind === 'session_status' && e.status === 'paused',
      ).length;
      expect(pausedCount).toBe(1); // only the original pause — no re-fire

      // NEW spend past the resumed watermark — the cap re-arms.
      await promptOverWire('usage:8');
      await waitForSessionStatus('paused');
    },
  );

  it(
    'raising the cap via spend_cap_set auto-resumes when the new cap covers current spend',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);
      await promptOverWire('usage:6');
      await waitForSessionStatus('paused');

      await setCapOverWire('project', 10); // 6 <= 10 now

      await waitForSessionStatus('awaiting_input');
    },
  );

  it(
    'raising the cap to something still below current spend does not auto-resume',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 5);
      await promptOverWire('usage:10');
      await waitForSessionStatus('paused');

      await setCapOverWire('project', 7); // still < 10

      // Give it a moment, then confirm no resume happened: a follow-up
      // prompt is still refused (the behavioral proof a status flag alone
      // wouldn't catch — same assertion the drop test above uses).
      await sleep(300);
      const chunksBefore = await countAgentMessageChunks();
      await promptOverWire('usage:1');
      await sleep(300);
      const chunksAfter = await countAgentMessageChunks();
      expect(chunksAfter).toBe(chunksBefore);
    },
  );
});

describe('spend_cap_get/set wire round trip (issue #251)', () => {
  it(
    'get returns null for both scopes on a project/session with nothing saved',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      const result = await getCapOverWire();
      expect(result).toEqual({ projectCapUsd: null, sessionCapUsd: null });
    },
  );

  it(
    'set saves the session scope and replies with both current values; a follow-up get reads the same back',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      const saved = await setCapOverWire('session', 15);
      expect(saved).toEqual({ projectCapUsd: null, sessionCapUsd: 15 });

      const read = await getCapOverWire();
      expect(read).toEqual({ projectCapUsd: null, sessionCapUsd: 15 });
    },
  );

  it(
    'set saves the project scope independently of the session scope',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('session', 15);
      const saved = await setCapOverWire('project', 40);
      expect(saved).toEqual({ projectCapUsd: 40, sessionCapUsd: 15 });
    },
  );

  it(
    'set with capUsd: null clears a previously-saved cap',
    { retry: 0, timeout: 20000 },
    async () => {
      await createSpendCapSession();
      await setCapOverWire('project', 40);
      const cleared = await setCapOverWire('project', null);
      expect(cleared).toEqual({ projectCapUsd: null, sessionCapUsd: null });
    },
  );
});
