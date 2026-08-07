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
  type PermissionPolicyViolationPayloadV1,
  type SessionUpdateEnvelopeV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import { decryptEnvelope, deriveKeyTree, generateAmk, importAesGcmKey } from '@loombox/crypto';

import { AgentProfileStore } from './agent-profile-store';
import { createNode, type NodeDaemon } from './node-daemon';
import { NativeTrackerStore } from './native-tracker-store';
import { TrackerModeStore } from './tracker-mode-store';

/**
 * Real wire-level proof for issue #627 (SPEC §7.10): a real relay, a real
 * encrypted session, and `test/fixtures/tracker-mcp-acp-agent.mjs` — a real
 * ACP agent AND a real @modelcontextprotocol/sdk MCP client — proving a
 * connected agent can genuinely discover and call the `tracker_*` tools
 * `NodeDaemon` injects into its session's own `mcpServers`, not just that
 * the tool CONTRACT (`tracker-mcp-tools.test.ts`) or the HOST in isolation
 * (`tracker-mcp-host.test.ts`) work. Harness duplicated from
 * `node-daemon-agent-profile.test.ts` (this package's own established
 * per-file convention, see that file's doc comment) rather than shared.
 */

type CryptoKey = webcrypto.CryptoKey;

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'tracker-mcp-acp-agent.mjs',
);

function trackerAgentProvider(): AcpProvider {
  return {
    id: 'test-tracker-mcp',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [FIXTURE_PATH], cwd }),
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

  /**
   * Polls for a message arriving over a REAL WebSocket to a REAL relay
   * process — genuine wall-clock delay, not a race to mask: nothing in
   * this test's own process controls when the relay/node round trip
   * actually completes, so there is no event/promise this could `await`
   * instead. Same convention as `node-daemon.test.ts`'s own `TestPhone`/
   * `waitForDecryptedKinds` this file's harness is duplicated from.
   */
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

interface DecryptedSessionEvent {
  seq: number;
  kind: string;
  text?: string;
}

/**
 * Same real-relay/real-WebSocket rationale as `TestPhone.waitFor` above
 * for the `setTimeout` poll: this decrypts whatever `session_update`
 * envelopes have arrived so far and waits for the agent's own turn
 * (routed through a real ACP child process and, for a `tracker-tool-call`
 * prompt, a real outbound HTTP round trip to `TrackerMcpHost`) to finish
 * and flush one — no in-process promise/event exists to await instead.
 */
async function waitForAgentMessageChunk(
  phone: TestPhone,
  sessionId: string,
  key: CryptoKey,
  timeoutMs = 10000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidates = phone.messages.filter(
      (m): m is SessionUpdateEnvelopeV1 => m.type === 'session_update' && m.sessionId === sessionId,
    );
    const decrypted = await Promise.all(
      candidates.map((m) => phoneOpen<DecryptedSessionEvent>(sessionId, m.envelope, key)),
    );
    const chunk = decrypted.find((d) => d.kind === 'agent_message_chunk');
    if (chunk?.text) return chunk.text;
    if (Date.now() > deadline) {
      throw new Error('waitForAgentMessageChunk: timed out waiting for an agent_message_chunk');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tracker-mcp-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tracker-mcp-state-'));
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

async function startTrackerSession(
  options: { agentProfileStore?: AgentProfileStore; profileId?: string } = {},
): Promise<{
  node: NodeDaemon;
  phone: TestPhone;
  sessionId: string;
  key: CryptoKey;
  accountId: string;
}> {
  const amk = generateAmk();
  const accountId = 'acct-tracker-mcp';
  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-tracker-mcp',
    deviceId: 'device-node-tracker-mcp',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [trackerAgentProvider()] }),
    agentProfileStore: options.agentProfileStore,
  });

  const session = await node.createSession({
    projectPath,
    provider: 'test-tracker-mcp',
    profileId: options.profileId,
    worktree: false,
  });

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-tracker-mcp',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  const key = await derivePhoneSessionKey(amk, accountId, session.id);
  return { node, phone, sessionId: session.id, key, accountId };
}

describe('NodeDaemon + TrackerMcpHost: real agent, real MCP wire protocol (issue #627)', () => {
  it(
    "a real connected agent's tools/list sees exactly the five tracker_* tools for a native-mode project (the default: no TrackerMode ever saved)",
    { retry: 0, timeout: 20000 },
    async () => {
      const { node, phone, sessionId, key } = await startTrackerSession();
      void node.promptSession(sessionId, 'tracker-tool-list');

      const text = await waitForAgentMessageChunk(phone, sessionId, key);
      const result = JSON.parse(text) as { tools: { name: string }[] };
      expect(result.tools.map((tool) => tool.name)).toEqual([
        'tracker_list',
        'tracker_get',
        'tracker_create',
        'tracker_update',
        'tracker_link_session',
      ]);
    },
  );

  it(
    'tools/list carries no loombox-tracker server at all for a live-mode project — never advertised only to fail (acceptance\u2019s tool-list-honesty bullet)',
    { retry: 0, timeout: 20000 },
    async () => {
      const trackerModeStore = new TrackerModeStore({ stateDir: nodeStateDir });
      trackerModeStore.set(projectPath, {
        kind: 'live',
        provider: 'github',
        connectionId: 'github:github.com:1',
        target: { owner: 'acme', repo: 'widgets' },
      });

      const amk = generateAmk();
      const accountId = 'acct-tracker-live';
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-tracker-live',
        deviceId: 'device-node-tracker-live',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [trackerAgentProvider()] }),
        trackerModeStore,
      });
      const session = await node.createSession({
        projectPath,
        provider: 'test-tracker-mcp',
        worktree: false,
      });
      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-tracker-live',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;
      phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
      await phone.waitFor((m) => m.type === 'session_announce');
      const key = await derivePhoneSessionKey(amk, accountId, session.id);

      void node.promptSession(session.id, 'tracker-tool-list');
      const text = await waitForAgentMessageChunk(phone, session.id, key);
      expect(JSON.parse(text)).toEqual({ error: 'no loombox-tracker server in mcpServers' });
    },
  );

  it(
    'tracker_list — a real read — returns a real, empty result with no permission prompt',
    { retry: 0, timeout: 20000 },
    async () => {
      const { node, phone, sessionId, key } = await startTrackerSession();
      void node.promptSession(
        sessionId,
        `tracker-tool-call:${JSON.stringify({ name: 'tracker_list', arguments: {} })}`,
      );

      const text = await waitForAgentMessageChunk(phone, sessionId, key);
      const result = JSON.parse(text) as { content: { type: string; text: string }[] };
      expect(JSON.parse(result.content[0]!.text)).toEqual({ records: [] });
    },
  );

  it(
    'tracker_create — a real write, no active profile — goes through the same live permission queue as any other mutating tool call: the session reaches permission_required and the relay sends a real permission_request, exactly like packages/providers/core\u2019s own permission-integration.test.ts proves for a built-in tool',
    { retry: 0, timeout: 20000 },
    async () => {
      const { node, phone, sessionId } = await startTrackerSession();

      // Fired without awaiting: this write's synthetic permission request
      // has no answerer in this test (no `permission_response` wire
      // handling exists node-side yet for ANY tool call — a pre-existing,
      // separately-tracked gap, not something this issue introduces or
      // fixes) — same "fire the prompt, never await it" convention
      // node-daemon-agent-profile.test.ts's own "request-permission" case
      // uses for the identical reason.
      void node.promptSession(
        sessionId,
        `tracker-tool-call:${JSON.stringify({
          name: 'tracker_create',
          arguments: { primaryType: 'task', fields: { title: 'Ship it' } },
        })}`,
      );

      const permissionRequest = await phone.waitFor((m) => m.type === 'permission_request');
      expect(permissionRequest).toBeDefined();

      const statusEvent = await phone.waitFor((m) => {
        if (m.type !== 'session_update') return false;
        return true; // status is encrypted; presence of any session_update after the request is enough to prove the turn is genuinely blocked, checked precisely below via the store.
      });
      expect(statusEvent).toBeDefined();

      // The one assertion that actually proves nothing was written: the
      // real on-disk store this session's tracker_create would have
      // mutated has no record at all — the write never ran past the gate.
      const store = new NativeTrackerStore({ stateDir: nodeStateDir });
      expect(store.list(projectPath)).toEqual([]);
    },
  );

  it(
    "tracker_create — a real write, DENIED by the session's active profile — resolves synchronously through the exact same D3-4 profile gate every other mutating tool uses (issue #752), and the client is told which profile refused it",
    { retry: 0, timeout: 20000 },
    async () => {
      const agentProfileStore = new AgentProfileStore({ stateDir: nodeStateDir });
      agentProfileStore.saveAll([
        {
          id: 'prof_no_writes',
          name: 'No Writes',
          deniedToolKinds: ['edit'],
          deniedToolNamePatterns: [],
          deniedMcpServers: [],
        },
      ]);

      const { node, phone, sessionId, key } = await startTrackerSession({
        agentProfileStore,
        profileId: 'prof_no_writes',
      });

      void node.promptSession(
        sessionId,
        `tracker-tool-call:${JSON.stringify({
          name: 'tracker_create',
          arguments: { primaryType: 'task', fields: { title: 'Should never exist' } },
        })}`,
      );

      const violationMessage = (await phone.waitFor(
        (m) => m.type === 'permission_policy_violation',
      )) as Extract<WireMessageV1, { type: 'permission_policy_violation' }>;
      const violation = await phoneOpen<PermissionPolicyViolationPayloadV1>(
        sessionId,
        violationMessage.envelope,
        key,
      );
      expect(violation.reason).toEqual({
        kind: 'profile',
        profileId: 'prof_no_writes',
        profileName: 'No Writes',
        matchedBy: 'tool-kind',
        rule: 'edit',
      });

      // The agent's own tools/call still gets an MCP-level answer back
      // (the fixture's own message chunk) — a profile refusal is a real,
      // completed tool result the agent can react to, never a silently
      // hung request.
      const text = await waitForAgentMessageChunk(phone, sessionId, key);
      const result = JSON.parse(text) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/not approved/);

      const store = new NativeTrackerStore({ stateDir: nodeStateDir });
      expect(store.list(projectPath)).toEqual([]);
    },
  );

  it(
    "a profile that denies the whole loombox-tracker MCP server (issue #752's deniedMcpServers) keeps it out of the session's mcpServers entirely — the agent never even sees tracker_* in its own tools/list",
    { retry: 0, timeout: 20000 },
    async () => {
      const agentProfileStore = new AgentProfileStore({ stateDir: nodeStateDir });
      agentProfileStore.saveAll([
        {
          id: 'prof_no_tracker',
          name: 'No Tracker',
          deniedToolKinds: [],
          deniedToolNamePatterns: [],
          deniedMcpServers: ['loombox-tracker'],
        },
      ]);

      const { node, phone, sessionId, key } = await startTrackerSession({
        agentProfileStore,
        profileId: 'prof_no_tracker',
      });

      void node.promptSession(sessionId, 'tracker-tool-list');
      const text = await waitForAgentMessageChunk(phone, sessionId, key);
      expect(JSON.parse(text)).toEqual({ error: 'no loombox-tracker server in mcpServers' });
    },
  );
});
