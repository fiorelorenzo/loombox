import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import { PROTOCOL_V1, type EncryptedEnvelope, type WireMessageV1 } from '@loombox/protocol';
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
 * Wire-level proof for issue #706's own acceptance bar: a real relay, a
 * real second `NodeDaemon` process built on the same on-disk `sessions.json`
 * a first one already wrote a `'running'` session into (the real restart
 * reproduction `node-daemon.test.ts`'s "reattach after a restart" suite
 * for #702 already established — duplicated here rather than shared, this
 * package's own established per-file convention), a real `prompt_inject`
 * over the wire, and a real second agent process
 * (`packages/providers/core`'s hermetic `echo-acp-agent.mjs`) actually
 * spawned and actually answering it. No fake stands in for `NodeDaemon`,
 * `SessionManager`, the relay, the wire protocol, or the revived agent
 * process anywhere below.
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

/**
 * Polls `phoneClient.messages` for a `session_update` addressed to
 * `sessionId` whose DECRYPTED payload satisfies `matches` — `TestPhone.
 * waitFor`'s own predicate is synchronous (it only ever inspects the
 * clear wire shape), so an assertion that needs to look inside an
 * envelope needs this instead. Decrypts each not-yet-checked message at
 * most once (`checked` never rewinds), so a long-running case with many
 * updates in flight doesn't redo work on every poll tick.
 */
async function waitForDecryptedSessionUpdate<T extends { kind: string }>(
  phoneClient: TestPhone,
  sessionId: string,
  key: CryptoKey,
  matches: (decrypted: T) => boolean,
  timeoutMs = 10000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let checked = 0;
  for (;;) {
    const updates = phoneClient.messages.filter(
      (m): m is Extract<WireMessageV1, { type: 'session_update' }> =>
        m.type === 'session_update' && m.sessionId === sessionId,
    );
    for (; checked < updates.length; checked++) {
      const decrypted = await phoneOpen<T>(sessionId, updates[checked].envelope, key);
      if (matches(decrypted)) return decrypted;
    }
    if (Date.now() > deadline) {
      throw new Error(
        'waitForDecryptedSessionUpdate: timed out waiting for a matching session_update',
      );
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
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

  /** Polls for a matching message rather than an event subscription: this harness (duplicated from `node-daemon.test.ts`'s own `TestPhone`) is a real WebSocket against a real relay process, where "the next message" is genuine platform I/O, not something a fake-timer clock could deterministically advance — the exception this repo's `ts-no-test-timers` rule itself carves out for integration tests exercising real timer behavior. */
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

function waitForConnected(node: NodeDaemon): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  node.once('connected', () => resolve());
  return promise;
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-revive-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-revive-state-'));
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

describe('NodeDaemon reviving a disconnected session on prompt_inject (issue #706)', () => {
  it(
    'restart, disconnected session, prompt: a brand-new agent process is actually spawned and actually answers, with an honest disclosure that it remembers nothing before this point',
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-revive-706';

      // "Before the restart": a real node creates a session with a real
      // (hermetic) agent process and writes it to `sessions.json`.
      const beforeRestart = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-revive-706',
        deviceId: 'device-node-revive-before',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });
      const session = await beforeRestart.createSession({
        projectPath,
        provider: 'test-echo',
        title: 'revive-me',
      });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);

      // "The restart": the whole process this session's bridge/agent lived
      // in is gone — `close()` tears down bridges/relay connections
      // exactly like a real process exit would, and deliberately never
      // touches `sessions.json`, so the record survives for the next
      // process to find.
      beforeRestart.close();

      // "After the restart": same node identity, same stateDir, a FRESH
      // `SessionManager` built from the SAME on-disk store — this reloads
      // the session and marks it 'disconnected' for real (SessionManager's
      // own constructor logic, never a test-only hook poking a status
      // field directly).
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-revive-706',
        deviceId: 'device-node-revive-after',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });
      await waitForConnected(node);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-revive-706',
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

      // Confirms the honest pre-existing state first (issue #702): the
      // reloaded session really has no live agent yet.
      await waitForDecryptedSessionUpdate<{ kind: string; status?: string }>(
        phone,
        session.id,
        key,
        (decrypted) => decrypted.kind === 'session_status' && decrypted.status === 'disconnected',
      );

      // The actual acceptance path: a typed prompt into that disconnected
      // session.
      const promptId = 'prompt-revive-1';
      const envelope = await phoneSeal(session.id, { text: 'are you still there?' }, key);
      phone.send({
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        promptId,
        envelope,
      });

      // Half 1 of the acceptance bar — "either it works or it says why,
      // never silently drops": a `'starting'` status arrives, and it
      // carries the honesty disclosure (half 2 of the acceptance bar —
      // "be honest about what a revived session can and cannot restore")
      // rather than reading exactly like an ordinary session's own
      // `'starting'` push.
      const startingPayload = await waitForDecryptedSessionUpdate<{
        kind: string;
        status?: string;
        reason?: string;
      }>(
        phone,
        session.id,
        key,
        (decrypted) =>
          decrypted.kind === 'session_status' &&
          decrypted.status === 'starting' &&
          decrypted.reason !== undefined,
      );
      expect(startingPayload.reason?.toLowerCase()).toContain('does not remember');

      // Half 1's other side proven for real: a genuinely NEW agent
      // process was spawned into the session's own worktree and actually
      // answered the prompt — the fixture always streams "Hello" then
      // " world" as real ACP `session/update` notifications, so seeing
      // either at all is proof the revival is real, not a mock.
      await waitForDecryptedSessionUpdate<{ kind: string; text?: string }>(
        phone,
        session.id,
        key,
        (decrypted) =>
          decrypted.kind === 'agent_message_chunk' && Boolean(decrypted.text?.includes('Hello')),
        10000,
      );

      // The session is genuinely alive again, not just momentarily
      // `'starting'`.
      await waitForDecryptedSessionUpdate<{ kind: string; status?: string }>(
        phone,
        session.id,
        key,
        (decrypted) => decrypted.kind === 'session_status' && decrypted.status === 'awaiting_input',
      );

      // Nothing about the successful path should have needed the error
      // reply channel — it exists for the "why not" half, not this one.
      expect(phone.count((m) => m.type === 'prompt_inject_result')).toBe(0);
    },
  );

  it(
    'restart, disconnected session, prompt, revival fails: the client is told why instead of the message silently going nowhere',
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-revive-fail-706';

      const beforeRestart = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-revive-fail-706',
        deviceId: 'device-node-revive-fail-before',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });
      const session = await beforeRestart.createSession({
        projectPath,
        provider: 'test-echo',
      });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);
      beforeRestart.close();

      // After the restart, the provider that made this session's agent
      // spawnable is simply gone (exactly like a provider CLI removed
      // from PATH between the crash and the restart) — `start` rejects
      // immediately, mirroring `node-daemon.test.ts`'s own "reports why
      // an agent spawn fails immediately" fixture.
      const failingSupervisor = new AgentSupervisor({ providers: [] });
      failingSupervisor.start = () =>
        Promise.reject(new Error('spawn ENOENT: test-echo not found on PATH'));

      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-revive-fail-706',
        deviceId: 'device-node-revive-fail-after',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: failingSupervisor,
      });
      await waitForConnected(node);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-revive-fail-706',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');

      const promptId = 'prompt-revive-fail-1';
      const envelope = await phoneSeal(session.id, { text: 'hello?' }, key);
      phone.send({
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        promptId,
        envelope,
      });

      const result = (await phone.waitFor(
        (m) => m.type === 'prompt_inject_result' && m.promptId === promptId,
        5000,
      )) as Extract<WireMessageV1, { type: 'prompt_inject_result' }>;
      expect(result.result.outcome).toBe('error');
      expect(result.result.outcome === 'error' && result.result.message).toMatch(/restart/i);

      // The session is left exactly where it was — still `'disconnected'`,
      // never mislabeled `'running'` with no agent behind it — so a later
      // retry (or `reannounceAll`'s own reconnect sweep) keeps treating it
      // honestly instead of the failed attempt permanently hiding it.
      await waitForDecryptedSessionUpdate<{ kind: string; status?: string }>(
        phone,
        session.id,
        key,
        (decrypted) => decrypted.kind === 'session_status' && decrypted.status === 'error',
      );
    },
  );
});
