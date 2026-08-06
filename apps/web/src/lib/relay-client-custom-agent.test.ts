import 'fake-indexeddb/auto';
import type { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';
import { PROTOCOL_V1, type EncryptedEnvelope, type WireMessageV1 } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { RelayClient } from './relay-client';

/**
 * D1-3's client-side wiring (`docs/superpowers/specs/
 * 2026-08-05-zed-parity-decisions.md` §4; issue #748): `RelayClient.
 * createSession` carrying a `customAgent` record, and `RelayClient.
 * probeCustomAgent` (the client half of the probe pair). Split out from the
 * main `relay-client.test.ts` (mirrors that file's own
 * `relay-client-provision-target.test.ts` split), against a REAL in-process
 * relay (`startRelay()`) exactly like every other `RelayClient` test — the
 * relay already routes `session_create`/`custom_agent_probe_request`/
 * `custom_agent_probe_response` unchanged (unlike `provision_target_request`,
 * which needs that file's own interceptor stub), so this drives the real
 * wire schema against a `FakeNode` peer, not a mock.
 */

type CryptoKey = webcrypto.CryptoKey;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function deriveNodeSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

/** The directory-picker/probe-pair derivation (issues #474/#748) — `['target', accountId, targetId]`, mirroring `deriveNodeSessionKey` but never the same key, even for the same account. */
async function deriveNodeTargetKey(
  amk: Uint8Array,
  accountId: string,
  targetId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['target', accountId, targetId]);
  return importAesGcmKey(node.key);
}

async function nodeSeal(
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

async function nodeOpen<T>(sessionId: string, wire: EncryptedEnvelope, key: CryptoKey): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** A minimal encrypted-node-like peer over the global WebSocket, speaking the v1 handshake's `role: 'node'` side — kept local rather than shared, same convention `relay-client.test.ts`'s own `FakeNode` copy already follows. */
class FakeNode {
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
          role: 'node',
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
      if (!settled) reject(new Error(`FakeNode: cannot reach ${url}`));
    });
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 3000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('FakeNode: timed out waiting for a message');
      // Real delay, deliberately: this polls a live WebSocket fed by the
      // real relay under test, with no synchronous "a message arrived"
      // signal to await instead (`ts-no-test-timers`'s own stated exception
      // for integration tests against the real clock — mirrors every other
      // `FakeNode`/`TestPhone` copy across this codebase).
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

/** Waits until `predicate(get(store))` is true — event-driven off the store's own push, mirrors `relay-client.test.ts`'s own `waitForStore` (see that file's doc comment for why this isn't a fixed poll deadline). */
async function waitForStore<T>(
  store: { subscribe: (run: (value: T) => void) => () => void },
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const initial = get(store);
  if (predicate(initial)) return initial;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error('waitForStore: timed out'));
  }, timeoutMs);
  const unsubscribe = store.subscribe((value) => {
    if (predicate(value)) {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    }
  });
  return promise;
}

let relay: StartedRelay;
let node: FakeNode | undefined;
let client: RelayClient | undefined;

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  client?.close();
  node?.close();
  client = undefined;
  node = undefined;
  await relay.close();
});

describe('RelayClient: createSession carrying a custom agent (D1-3, issue #748)', () => {
  it('seals customAgent into the SAME private envelope as title/projectPath, and leaves it out entirely for an ordinary catalogue session', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-create';

    node = new FakeNode(relay.url, {
      deviceId: 'node-custom-create-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_custom_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-custom-create-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const sessionId = await client.createSession({
      targetId: 'local',
      provider: 'custom',
      projectPath: '/home/dev/project',
      title: 'my custom agent session',
      customAgent: {
        name: 'My internal agent',
        command: 'omp',
        args: ['acp'],
        env: { FOO: 'bar' },
      },
    });

    const createMessage = (await node.waitFor((m) => m.type === 'session_create')) as {
      sessionId: string;
      provider: string;
      privateEnvelope: EncryptedEnvelope;
    };
    expect(createMessage.sessionId).toBe(sessionId);
    expect(createMessage.provider).toBe('custom');

    const sessionKey = await deriveNodeSessionKey(amk, accountId, createMessage.sessionId);
    const decryptedMeta = await nodeOpen<{
      title: string;
      projectPath: string;
      customAgent?: { name: string; command: string; args: string[]; env?: Record<string, string> };
    }>(createMessage.sessionId, createMessage.privateEnvelope, sessionKey);
    expect(decryptedMeta.customAgent).toEqual({
      name: 'My internal agent',
      command: 'omp',
      args: ['acp'],
      env: { FOO: 'bar' },
    });

    // A second, ordinary session from the same client carries no
    // `customAgent` key at all — never an explicit `undefined` (the field's
    // whole versioning contract, `CreateSessionOptions.customAgent`'s own
    // doc comment).
    const plainSessionId = await client.createSession({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/project',
      title: 'ordinary session',
    });
    const plainCreateMessage = (await node.waitFor(
      (m) => m.type === 'session_create' && m.sessionId === plainSessionId,
    )) as { sessionId: string; privateEnvelope: EncryptedEnvelope };
    const plainKey = await deriveNodeSessionKey(amk, accountId, plainCreateMessage.sessionId);
    const plainMeta = await nodeOpen<Record<string, unknown>>(
      plainCreateMessage.sessionId,
      plainCreateMessage.privateEnvelope,
      plainKey,
    );
    expect('customAgent' in plainMeta).toBe(false);
  });
});

describe('RelayClient: probeCustomAgent (D1-3, issue #748)', () => {
  it('resolves with a decrypted probe result from the owning node, sealed under a per-target key (not the session key)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-probe-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-custom-probe-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_probe_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-custom-probe-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const probePromise = client.probeCustomAgent({
      nodeId: 'node_probe_1',
      targetId: 'local',
      command: 'omp',
    });

    const request = (await node.waitFor((m) => m.type === 'custom_agent_probe_request')) as {
      type: 'custom_agent_probe_request';
      nodeId: string;
      targetId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(request.nodeId).toBe('node_probe_1');
    expect(request.targetId).toBe('local');
    expect(Object.keys(request).sort()).toEqual(
      ['envelope', 'nodeId', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
    );

    const key = await deriveNodeTargetKey(amk, accountId, 'local');
    const requestPayload = await nodeOpen<{ command: string }>('local', request.envelope, key);
    expect(requestPayload).toEqual({ command: 'omp' });

    const responseEnvelope = await nodeSeal(
      'local',
      { result: { outcome: 'ok', available: true, allowed: true } },
      key,
    );
    node.send({
      type: 'custom_agent_probe_response',
      protocolVersion: PROTOCOL_V1,
      targetId: 'local',
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    await expect(probePromise).resolves.toEqual({ outcome: 'ok', available: true, allowed: true });
  });

  it('surfaces installed-but-not-allowlisted and allowlisted-but-not-installed as distinct facts, not one undifferentiated no', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-probe-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-custom-probe-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_probe_2',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-custom-probe-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const probePromise = client.probeCustomAgent({
      nodeId: 'node_probe_2',
      targetId: 'local',
      command: '/bin/sh',
    });
    const request = (await node.waitFor((m) => m.type === 'custom_agent_probe_request')) as {
      requestId: string;
    };
    const key = await deriveNodeTargetKey(amk, accountId, 'local');
    const responseEnvelope = await nodeSeal(
      'local',
      { result: { outcome: 'ok', available: true, allowed: false } },
      key,
    );
    node.send({
      type: 'custom_agent_probe_response',
      protocolVersion: PROTOCOL_V1,
      targetId: 'local',
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    await expect(probePromise).resolves.toEqual({ outcome: 'ok', available: true, allowed: false });
  });

  it('resolves with an error outcome payload rather than rejecting, when the node reports one', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-probe-3';

    node = new FakeNode(relay.url, {
      deviceId: 'node-custom-probe-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_probe_3',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-custom-probe-3',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const probePromise = client.probeCustomAgent({
      nodeId: 'node_probe_3',
      targetId: 'local',
      command: 'omp',
    });
    const request = (await node.waitFor((m) => m.type === 'custom_agent_probe_request')) as {
      requestId: string;
    };
    const key = await deriveNodeTargetKey(amk, accountId, 'local');
    const errorEnvelope = await nodeSeal(
      'local',
      { result: { outcome: 'error', message: 'PATH probe failed' } },
      key,
    );
    node.send({
      type: 'custom_agent_probe_response',
      protocolVersion: PROTOCOL_V1,
      targetId: 'local',
      requestId: request.requestId,
      envelope: errorEnvelope,
    });

    await expect(probePromise).resolves.toEqual({ outcome: 'error', message: 'PATH probe failed' });
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-custom-agent-probe-no-conn',
      deviceId: 'client-custom-probe-no-conn',
    });
    // Deliberately never connected.
    await expect(
      client.probeCustomAgent({ nodeId: 'node_x', targetId: 'local', command: 'omp' }),
    ).rejects.toThrow(/no open connection/);
  });

  it('times out rather than hanging forever when no response ever arrives', async () => {
    const amk = generateAmk();
    const accountId = 'acct-custom-agent-probe-timeout';

    node = new FakeNode(relay.url, {
      deviceId: 'node-custom-probe-timeout',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_probe_timeout',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-custom-probe-timeout',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    await expect(
      client.probeCustomAgent(
        { nodeId: 'node_probe_timeout', targetId: 'local', command: 'omp' },
        200,
      ),
    ).rejects.toThrow(/timed out/);
  });
});
