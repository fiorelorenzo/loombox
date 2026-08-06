import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type AgentProfileListResult,
  type AgentProfileSessionResult,
  type EncryptedEnvelope,
  type PermissionPolicyViolationPayloadV1,
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

import { AgentProfileStore } from './agent-profile-store';
import { createNode, type NodeDaemon } from './node-daemon';

type CryptoKey = webcrypto.CryptoKey;

/**
 * Real wire-level proof for design spec `2026-08-05-zed-parity-decisions.md`'s
 * D3-4 profiles half (issue #752): a real relay, a real encrypted session,
 * and the real `permission-acp-agent.mjs` ACP fixture (the same one
 * `@loombox/providers-core`'s `permission-integration.test.ts` and
 * `@loombox/supervisor`'s `agent-session-profile.test.ts` already use) —
 * proving the whole chain from a saved `AgentProfile`, through
 * `session_create`'s `profileId`, to a live `session/request_permission`
 * being auto-refused and the client learning why over
 * `permission_policy_violation`, never a `permission_request`. Harness
 * duplicated from `node-daemon-permission-policy.test.ts` (this package's
 * own established per-file convention) rather than shared.
 */

const FIXTURE_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
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
    spawnConfig: () => ({ command: process.execPath, args: [FIXTURE_PATH] }),
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

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-agent-profile-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-agent-profile-state-'));
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

describe('NodeDaemon agent profiles — real relay, real ACP round trip (design spec 2026-08-05-zed-parity-decisions.md D3-4; issue #752)', () => {
  it(
    "a tool call denied by the session's active profile never reaches the client as permission_request — instead a permission_policy_violation names the profile",
    { retry: 0, timeout: 20000 },
    async () => {
      const agentProfileStore = new AgentProfileStore({ stateDir: nodeStateDir });
      agentProfileStore.saveAll([
        {
          id: 'prof_ask',
          name: 'Ask First',
          deniedToolKinds: ['edit'],
          deniedToolNamePatterns: [],
          deniedMcpServers: [],
        },
      ]);

      const amk = generateAmk();
      const accountId = 'acct-agent-profile';
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-agent-profile',
        deviceId: 'device-node-agent-profile',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [permissionProvider()] }),
        agentProfileStore,
      });

      const session = await node.createSession({
        projectPath,
        provider: 'test-permission',
        profileId: 'prof_ask',
        worktree: false,
      });
      const key = await derivePhoneSessionKey(amk, accountId, session.id);

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-agent-profile',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');

      // Fires without awaiting: the fixture's session/request_permission is
      // auto-refused node-side before it ever becomes a real permission
      // response the client would need to answer.
      void node.promptSession(session.id, 'request-permission');

      const violationMessage = (await phone.waitFor(
        (m) => m.type === 'permission_policy_violation',
      )) as Extract<WireMessageV1, { type: 'permission_policy_violation' }>;
      const violation = await phoneOpen<PermissionPolicyViolationPayloadV1>(
        session.id,
        violationMessage.envelope,
        key,
      );

      expect(violation.reason).toEqual({
        kind: 'profile',
        profileId: 'prof_ask',
        profileName: 'Ask First',
        matchedBy: 'tool-kind',
        rule: 'edit',
      });
      expect(violation.surface).toBe('tool_call');
      expect(violation.command).toBe('Edit file');

      // Never a permission_request for this refused call — the human
      // never sees it.
      expect(phone.messages.some((m) => m.type === 'permission_request')).toBe(false);
    },
  );

  it(
    'a session with no profileId behaves exactly like before this feature existed — a real permission_request reaches the client',
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-agent-profile-none';
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-agent-profile-none',
        deviceId: 'device-node-agent-profile-none',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [permissionProvider()] }),
      });

      const session = await node.createSession({
        projectPath,
        provider: 'test-permission',
        worktree: false,
      });

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-agent-profile-none',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');

      void node.promptSession(session.id, 'request-permission');

      await phone.waitFor((m) => m.type === 'permission_request');
      expect(phone.messages.some((m) => m.type === 'permission_policy_violation')).toBe(false);
    },
  );

  it('agent_profile_list_set/_get round trip over the real wire, envelope-sealed', async () => {
    const amk = generateAmk();
    const accountId = 'acct-agent-profile-crud';
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-agent-profile-crud',
      deviceId: 'device-node-agent-profile-crud',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [permissionProvider()] }),
    });

    const session = await node.createSession({
      projectPath,
      provider: 'test-permission',
      worktree: false,
    });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-agent-profile-crud',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const profile = {
      id: 'prof_min',
      name: 'Minimal',
      deniedToolKinds: ['execute', 'edit'],
      deniedToolNamePatterns: ['mcp__github__*'],
      deniedMcpServers: ['github'],
    };
    const setEnvelope = await phoneSeal(session.id, { profiles: [profile] }, key);
    phone.send({
      type: 'agent_profile_list_set',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-set-1',
      envelope: setEnvelope,
    });
    const setResult = (await phone.waitFor(
      (m) =>
        m.type === 'agent_profile_list_result' &&
        (m as AgentProfileListResult).requestId === 'req-set-1',
    )) as AgentProfileListResult;
    const setPayload = await phoneOpen<{ profiles: unknown[] }>(
      session.id,
      setResult.envelope,
      key,
    );
    expect(setPayload.profiles).toEqual([profile]);

    phone.send({
      type: 'agent_profile_session_set',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-session-set-1',
      envelope: await phoneSeal(session.id, { profileId: 'prof_min' }, key),
    });
    const sessionSetResult = (await phone.waitFor(
      (m) =>
        m.type === 'agent_profile_session_result' &&
        (m as AgentProfileSessionResult).requestId === 'req-session-set-1',
    )) as AgentProfileSessionResult;
    const sessionSetPayload = await phoneOpen<{ profileId: string | null }>(
      session.id,
      sessionSetResult.envelope,
      key,
    );
    expect(sessionSetPayload.profileId).toBe('prof_min');
  });
});
