import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type SessionListV1,
  type SessionTemplateListResult,
  type SessionTemplateV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
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
 * Real wire-level proof for issue #259, epic #29: a real relay, a real
 * `NodeDaemon`, and a hand-rolled phone client speaking the documented v1
 * `['target', accountId, targetId]` derivation directly — same
 * "interoperate, don't just agree with yourself" discipline
 * `node-daemon-agent-profile.test.ts`/`node-daemon.test.ts`'s own
 * `target_fs_list_request` coverage already follows. No session, no
 * project, no supervisor: `session_template_list_get`/`_set` route by
 * `nodeId`+`targetId` directly (see `@loombox/protocol`'s
 * `session-template.ts` doc comment for why), so none of that machinery
 * is needed to exercise them, exactly like the `target_fs_list_request`
 * suite in `node-daemon.test.ts`.
 */

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Mirrors `NodeDaemon`'s own `deriveTargetKey` — `['target', accountId, targetId]`, the same derivation `target_fs_list_request`/`custom_agent_probe_request` already use, and what `session_template_list_get`/`_set`/`_result` are sealed under too (see this file's doc comment). */
async function derivePhoneTargetKey(
  amk: Uint8Array,
  accountId: string,
  targetId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['target', accountId, targetId]);
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

async function phoneOpen<T>(
  resourceId: string,
  wire: EncryptedEnvelope,
  key: CryptoKey,
): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(resourceId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** A minimal encrypted-PWA-like client over the global WebSocket, speaking the v1 handshake — kept local rather than shared, same convention every other `node-daemon-*.test.ts` file follows for its own copy. */
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
      if (Date.now() > deadline) {
        throw new Error('TestPhone: timed out waiting for a matching message');
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

function waitForConnected(node: NodeDaemon): Promise<void> {
  return new Promise((resolve) => node.once('connected', resolve));
}

function assertOpaque(wire: EncryptedEnvelope, plainSubstrings: string[]): void {
  const raw = Buffer.from(wire.ciphertext, 'base64').toString('latin1');
  for (const needle of plainSubstrings) {
    expect(raw.includes(needle)).toBe(false);
  }
}

let relay: StartedRelay;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tpl-state-test-'));
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

const dailyCheckin: SessionTemplateV1 = {
  id: 'tpl_daily',
  name: 'Daily check-in',
  targetId: 'local',
  provider: 'claude',
  worktree: true,
  title: 'Daily check-in',
};

describe('NodeDaemon session templates (issue #259, epic #29) — real relay, routed by nodeId+targetId, no session required', () => {
  it('session_template_list_get replies with an empty catalog for a node with nothing saved yet, sealed under the per-target key (not a session key)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tpl-empty';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-tpl-1',
      deviceId: 'device-node-tpl-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-tpl-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'session_template_list_get',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-1',
      targetId: 'local',
      requestId: 'req-tpl-empty',
    });

    const response = (await phone.waitFor(
      (m) => m.type === 'session_template_list_result',
    )) as SessionTemplateListResult;
    const key = await derivePhoneTargetKey(amk, accountId, 'local');
    const payload = await phoneOpen<{ templates: SessionTemplateV1[] }>(
      'local',
      response.envelope,
      key,
    );
    expect(payload.templates).toEqual([]);
  });

  it('saves a catalog over session_template_list_set and reads it back over session_template_list_get, opaque to a bystander with only the ciphertext', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tpl-roundtrip';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-tpl-2',
      deviceId: 'device-node-tpl-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });
    await waitForConnected(node);

    const key = await derivePhoneTargetKey(amk, accountId, 'local');
    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-tpl-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const setEnvelope = await phoneSeal('local', { templates: [dailyCheckin] }, key);
    assertOpaque(setEnvelope, ['Daily check-in', 'claude']);
    phone.send({
      type: 'session_template_list_set',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-2',
      targetId: 'local',
      requestId: 'req-tpl-set',
      envelope: setEnvelope,
    });

    const setResult = (await phone.waitFor(
      (m) => m.type === 'session_template_list_result' && m.requestId === 'req-tpl-set',
    )) as SessionTemplateListResult;
    assertOpaque(setResult.envelope, ['Daily check-in', 'claude']);
    const setPayload = await phoneOpen<{ templates: SessionTemplateV1[] }>(
      'local',
      setResult.envelope,
      key,
    );
    expect(setPayload.templates).toEqual([dailyCheckin]);

    phone.send({
      type: 'session_template_list_get',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-2',
      targetId: 'local',
      requestId: 'req-tpl-get',
    });
    const getResult = (await phone.waitFor(
      (m) => m.type === 'session_template_list_result' && m.requestId === 'req-tpl-get',
    )) as SessionTemplateListResult;
    const getPayload = await phoneOpen<{ templates: SessionTemplateV1[] }>(
      'local',
      getResult.envelope,
      key,
    );
    expect(getPayload.templates).toEqual([dailyCheckin]);
  });

  it('fully replaces the catalog on a second set — never merges', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tpl-replace';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-tpl-3',
      deviceId: 'device-node-tpl-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });
    await waitForConnected(node);

    const key = await derivePhoneTargetKey(amk, accountId, 'local');
    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-tpl-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'session_template_list_set',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-3',
      targetId: 'local',
      requestId: 'req-tpl-first',
      envelope: await phoneSeal('local', { templates: [dailyCheckin] }, key),
    });
    await phone.waitFor(
      (m) => m.type === 'session_template_list_result' && m.requestId === 'req-tpl-first',
    );

    const codexReview: SessionTemplateV1 = {
      id: 'tpl_codex',
      name: 'Codex review',
      targetId: 'local',
      provider: 'codex',
    };
    phone.send({
      type: 'session_template_list_set',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-3',
      targetId: 'local',
      requestId: 'req-tpl-second',
      envelope: await phoneSeal('local', { templates: [codexReview] }, key),
    });
    const secondResult = (await phone.waitFor(
      (m) => m.type === 'session_template_list_result' && m.requestId === 'req-tpl-second',
    )) as SessionTemplateListResult;
    const payload = await phoneOpen<{ templates: SessionTemplateV1[] }>(
      'local',
      secondResult.envelope,
      key,
    );
    expect(payload.templates).toEqual([codexReview]);
  });

  it('ignores a session_template_list_get for a target this node does not own, instead of throwing', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tpl-unknown-target';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-tpl-4',
      deviceId: 'device-node-tpl-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-tpl-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'session_template_list_get',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-4',
      targetId: 'does-not-exist',
      requestId: 'req-tpl-unknown',
    });

    // the relay/node round trip should still be responsive
    phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
    const list = (await phone.waitFor((m) => m.type === 'session_list')) as SessionListV1;
    expect(list.type).toBe('session_list');
  });

  it('survives a node restart: a fresh NodeDaemon pointed at the same stateDir reads back the catalog a prior instance saved', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tpl-restart';
    const key = await derivePhoneTargetKey(amk, accountId, 'local');

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-tpl-5',
      deviceId: 'device-node-tpl-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-tpl-5a',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({
      type: 'session_template_list_set',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-5',
      targetId: 'local',
      requestId: 'req-tpl-restart-save',
      envelope: await phoneSeal('local', { templates: [dailyCheckin] }, key),
    });
    await phone.waitFor(
      (m) => m.type === 'session_template_list_result' && m.requestId === 'req-tpl-restart-save',
    );

    // Simulate a restart: close this node and its phone, then bring up a
    // brand-new NodeDaemon instance against the exact same `stateDir`.
    node.close();
    phone.close();

    const restartedNode = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-tpl-5',
      deviceId: 'device-node-tpl-5-restarted',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });
    node = restartedNode;
    await waitForConnected(restartedNode);

    const phoneB = new TestPhone(relay.url, {
      deviceId: 'device-phone-tpl-5b',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    phone = phoneB;
    await phoneB.ready;
    phoneB.send({
      type: 'session_template_list_get',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-tpl-5',
      targetId: 'local',
      requestId: 'req-tpl-restart-read',
    });
    const result = (await phoneB.waitFor(
      (m) => m.type === 'session_template_list_result',
    )) as SessionTemplateListResult;
    const payload = await phoneOpen<{ templates: SessionTemplateV1[] }>(
      'local',
      result.envelope,
      key,
    );
    expect(payload.templates).toEqual([dailyCheckin]);
  });
});
