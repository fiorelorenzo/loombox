import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type SessionListV1,
  type SnippetListResult,
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

/**
 * Real wire-level proof for SPEC §7.18's "reusable prompt/snippet library"
 * clause (issue #261, epic #29): a real relay, a real encrypted session, a
 * real `snippet_list_set`/`_get` round trip. Harness copied from
 * `node-daemon-agent-profile.test.ts` (this package's own established
 * per-file convention for a sessionId-routed catalog) rather than shared,
 * so this file stays self-contained; the fixture agent is the plain
 * `echo-acp-agent.mjs` used across this package's own lighter tests, since
 * nothing here exercises agent behavior — only the catalog's own wire
 * round trip. `snippet-store.test.ts` is where "survives a node restart"
 * (this issue's own acceptance bullet) is proven directly against a real
 * `SnippetStore`, the same split `session-template-store.test.ts`/
 * `node-daemon-session-template.test.ts` already establish.
 */

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
    timeoutMs = 10000,
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
  return new Promise((resolve) => node.once('connected', resolve));
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-snippet-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-snippet-state-'));
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

describe('NodeDaemon snippet catalog (SPEC §7.18; issue #261) — real relay, routed by sessionId', () => {
  it('snippet_list_set/_get round trip over the real wire, envelope-sealed', async () => {
    const amk = generateAmk();
    const accountId = 'acct-snippet-crud';
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-snippet-crud',
      deviceId: 'device-node-snippet-crud',
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
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-snippet-crud',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const snippet = {
      id: 'snip_standup',
      name: 'Daily standup',
      text: 'What did you ship yesterday?',
    };
    const setEnvelope = await phoneSeal(session.id, { snippets: [snippet] }, key);
    phone.send({
      type: 'snippet_list_set',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-set-1',
      envelope: setEnvelope,
    });
    const setResult = (await phone.waitFor(
      (m) => m.type === 'snippet_list_result' && (m as SnippetListResult).requestId === 'req-set-1',
    )) as SnippetListResult;
    const setPayload = await phoneOpen<{ snippets: unknown[] }>(
      session.id,
      setResult.envelope,
      key,
    );
    expect(setPayload.snippets).toEqual([snippet]);

    phone.send({
      type: 'snippet_list_get',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-get-1',
    });
    const getResult = (await phone.waitFor(
      (m) => m.type === 'snippet_list_result' && (m as SnippetListResult).requestId === 'req-get-1',
    )) as SnippetListResult;
    const getPayload = await phoneOpen<{ snippets: unknown[] }>(
      session.id,
      getResult.envelope,
      key,
    );
    expect(getPayload.snippets).toEqual([snippet]);
  });

  it('ignores snippet_list_get for a sessionId this node does not own, instead of throwing', async () => {
    const amk = generateAmk();
    const accountId = 'acct-snippet-unknown';
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-snippet-unknown',
      deviceId: 'device-node-snippet-unknown',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-snippet-unknown',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'snippet_list_get',
      protocolVersion: PROTOCOL_V1,
      sessionId: 'sess_does_not_exist',
      requestId: 'req-unknown-1',
    });

    // The relay/node round trip should still be responsive — a reply to a
    // request sent right after proves the bogus one above was silently
    // dropped rather than crashing the connection.
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const list = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    expect(list.type).toBe('session_list');
    expect(phone.messages.some((m) => m.type === 'snippet_list_result')).toBe(false);
  });
});
