import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  buildTrackerTypeRegistryV1,
  PROTOCOL_V1,
  resolveWorkflowCategory,
  type EncryptedEnvelope,
  type TrackerSnapshotResponsePayloadV1,
  type TrackerWriteResponsePayloadV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor, defaultPtySpawn, TerminalSupervisor } from '@loombox/supervisor';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';
import { NativeTrackerStore } from './native-tracker-store';

/**
 * The wire-level proof for issue #212's central acceptance criterion —
 * "UI is exercised against the MCP-created/updated records so agent
 * writes show up live": a session-scoped `tracker_snapshot_request`/
 * `tracker_write_request` pair, sealed/opened exactly like a real client
 * would, against the SAME `NativeTrackerStore` a future MCP host binds an
 * agent's `tracker_*` tools to (issue #211) — proven here by seeding a
 * record directly through the store (standing in for an agent write) and
 * observing it over the wire. Mirrors `node-daemon-permission-policy.test.ts`'s
 * real-relay harness shape (same echo provider, same phone-side crypto
 * helpers), narrowed to what tracker requests need: no terminal, no
 * permission policy, and an event-driven `TestPhone.waitFor` (a single
 * hang-guard timeout, no busy-poll) rather than that file's polling loop.
 */

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

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

interface PendingWaiter {
  predicate: (message: WireMessageV1) => boolean;
  resolve: (message: WireMessageV1) => void;
}

/** A bare client speaking just enough of the v1 handshake to resume a session and exchange `tracker_*` requests/responses — event-driven throughout: `waitFor` resolves the instant a matching message arrives, with a single hang-guard timeout rather than a poll loop. */
class TestPhone {
  readonly messages: WireMessageV1[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;
  private readonly waiters = new Set<PendingWaiter>();

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
      const message = parsed as WireMessageV1;
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.delete(waiter);
          waiter.resolve(message);
        }
      }
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
    const already = this.messages.find(predicate);
    if (already) return already;
    const { promise, resolve, reject } = Promise.withResolvers<WireMessageV1>();
    const waiter: PendingWaiter = { predicate, resolve };
    this.waiters.add(waiter);
    // A real network round trip against a real relay genuinely needs a
    // hang guard (this is an integration test, not code under test with a
    // deterministic clock to fake) — but this is a single deadline timer,
    // never a busy-poll loop: the promise settles the instant a matching
    // message arrives via the `message` listener above.
    const timer = setTimeout(() => {
      this.waiters.delete(waiter);
      reject(new Error('TestPhone: timed out waiting for a matching message'));
    }, timeoutMs);
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
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

/** Real hermetic bash (issue #503), matching `node-daemon.test.ts`'s own `hermeticTerminalSupervisor()` — a running session needs a `TerminalSupervisor` even though this suite never opens one. */
function hermeticTerminalSupervisor(): TerminalSupervisor {
  return new TerminalSupervisor({
    spawnPty: (options) =>
      defaultPtySpawn({ ...options, args: [...(options.args ?? []), '--noprofile', '--norc'] }),
  });
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;
let trackerStore: NativeTrackerStore;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tracker-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tracker-state-'));
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
  trackerStore = new NativeTrackerStore({ stateDir: nodeStateDir });
});

afterEach(async () => {
  phone?.close();
  if (node) await node.close();
  await relay.close();
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
});

async function connectOverTheWire(): Promise<{
  sessionId: string;
  key: CryptoKey;
  accountId: string;
}> {
  const amk = generateAmk();
  const accountId = 'acct-tracker';

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-tracker',
    deviceId: 'device-node-tracker',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    terminalSupervisor: hermeticTerminalSupervisor(),
    nativeTrackerStore: trackerStore,
  });

  const session = await node.createSession({ projectPath, provider: 'test-echo' });
  const key = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-tracker',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  return { sessionId: session.id, key, accountId };
}

async function requestSnapshot(
  sessionId: string,
  key: CryptoKey,
  includeArchived?: boolean,
): Promise<TrackerSnapshotResponsePayloadV1> {
  const requestId = `snap-${Math.random()}`;
  const envelope = await phoneSeal(sessionId, { includeArchived }, key);
  phone!.send({
    type: 'tracker_snapshot_request',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    targetId: 'local',
    requestId,
    envelope,
  });
  const reply = await phone!.waitFor(
    (m) => m.type === 'tracker_snapshot_response' && m.requestId === requestId,
  );
  if (reply.type !== 'tracker_snapshot_response') throw new Error('unreachable');
  return phoneOpen<TrackerSnapshotResponsePayloadV1>(sessionId, reply.envelope, key);
}

async function requestWrite(
  sessionId: string,
  key: CryptoKey,
  payload: Record<string, unknown>,
): Promise<TrackerWriteResponsePayloadV1> {
  const requestId = `write-${Math.random()}`;
  const envelope = await phoneSeal(sessionId, payload, key);
  phone!.send({
    type: 'tracker_write_request',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    targetId: 'local',
    requestId,
    envelope,
  });
  const reply = await phone!.waitFor(
    (m) => m.type === 'tracker_write_response' && m.requestId === requestId,
  );
  if (reply.type !== 'tracker_write_response') throw new Error('unreachable');
  return phoneOpen<TrackerWriteResponsePayloadV1>(sessionId, reply.envelope, key);
}

describe('NodeDaemon native tracker wire path — real terminal-free session, real relay (SPEC §7.10; issue #212)', () => {
  it('tracker_snapshot_request returns the bound project\u2019s built-in types and an empty record list for a fresh project', async () => {
    const { sessionId, key } = await connectOverTheWire();
    const snapshot = await requestSnapshot(sessionId, key);
    expect(snapshot.outcome).toBe('ok');
    if (snapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(snapshot.records).toEqual([]);
    expect(snapshot.types.map((t) => t.id).sort()).toEqual(['bug', 'epic', 'task']);
  });

  it('a record seeded directly through the store — standing in for an agent\u2019s tracker_create MCP call (#211) — shows up live in a snapshot fetched over the wire', async () => {
    const { sessionId, key } = await connectOverTheWire();
    const seeded = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Agent-authored', status: 'todo' },
      authorId: 'agent-session-1',
    });

    const snapshot = await requestSnapshot(sessionId, key);
    expect(snapshot.outcome).toBe('ok');
    if (snapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toEqual(seeded);
  });

  it('tracker_write_request(op: create) persists through the real store and stamps authorId from the node\u2019s own accountId, never from the payload', async () => {
    const { sessionId, key, accountId } = await connectOverTheWire();
    const response = await requestWrite(sessionId, key, {
      op: 'create',
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
    });
    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    expect(response.record).toBeDefined();
    const record = response.record!;
    expect(record.fields).toEqual({ title: 'Ship it', status: 'todo' });
    expect(record.system.authorId).toBe(accountId);
    expect(trackerStore.get(projectPath, record.id)).toEqual(record);
  });

  it('tracker_write_request(op: update) moves a record between kanban columns through the real store', async () => {
    const { sessionId, key } = await connectOverTheWire();
    const created = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
      authorId: 'agent-session-1',
    });

    const response = await requestWrite(sessionId, key, {
      op: 'update',
      id: created.id,
      fields: { title: 'Ship it', status: 'done' },
    });
    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    expect(response.record?.fields.status).toBe('done');
    expect(trackerStore.get(projectPath, created.id)?.fields.status).toBe('done');
  });

  it('tracker_write_request(op: defineType) registers a custom type through the real store, visible in the next snapshot', async () => {
    const { sessionId, key } = await connectOverTheWire();
    const response = await requestWrite(sessionId, key, {
      op: 'defineType',
      id: 'feature-request',
      label: 'Feature Request',
      roles: { title: 'summary', workflowStatus: 'stage' },
    });
    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    expect(response.typeDefinition).toEqual({
      id: 'feature-request',
      label: 'Feature Request',
      builtin: false,
      roles: { title: 'summary', workflowStatus: 'stage' },
    });

    const snapshot = await requestSnapshot(sessionId, key);
    expect(snapshot.outcome).toBe('ok');
    if (snapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(snapshot.types.map((t) => t.id).sort()).toEqual([
      'bug',
      'epic',
      'feature-request',
      'task',
    ]);
  });

  it('tracker_write_request(op: create) with an unknown type comes back as a retryable outcome: error, never a silent drop', async () => {
    const { sessionId, key } = await connectOverTheWire();
    const response = await requestWrite(sessionId, key, {
      op: 'create',
      primaryType: 'ghost-type',
      fields: {},
    });
    expect(response.outcome).toBe('error');
    if (response.outcome !== 'error') throw new Error('unreachable');
    expect(response.message).toMatch(/ghost-type/);
  });

  it('tracker_snapshot_request(includeArchived: true) includes an archived record; the default excludes it', async () => {
    const { sessionId, key } = await connectOverTheWire();
    const created = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Old' },
      authorId: 'a',
    });
    trackerStore.update(projectPath, created.id, { archived: true });

    const defaultSnapshot = await requestSnapshot(sessionId, key);
    expect(defaultSnapshot.outcome).toBe('ok');
    if (defaultSnapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(defaultSnapshot.records).toEqual([]);

    const fullSnapshot = await requestSnapshot(sessionId, key, true);
    expect(fullSnapshot.outcome).toBe('ok');
    if (fullSnapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(fullSnapshot.records).toHaveLength(1);
  });

  it('moving a card across a workflow-category boundary (issue #651, v7 decision F4-2) writes the literal category id back through the real store, and it resolves to the same category on a fresh snapshot', async () => {
    const { sessionId, key } = await connectOverTheWire();
    const created = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
      authorId: 'agent-session-1',
    });

    const initialSnapshot = await requestSnapshot(sessionId, key);
    expect(initialSnapshot.outcome).toBe('ok');
    if (initialSnapshot.outcome !== 'ok') throw new Error('unreachable');
    const registry = buildTrackerTypeRegistryV1(initialSnapshot.types);
    // 'todo' has no dedicated category column of its own any more — it
    // resolves into the 'new' workflow category.
    expect(resolveWorkflowCategory(created, registry)).toBe('new');

    // What a board drag across the 'new' -> 'done' column boundary
    // actually sends: the literal category id, not a synonym like
    // 'complete' or 'closed' — see `TrackerCard.svelte`'s own "Move to"
    // wiring and `resolveWorkflowCategory`'s doc comment on why that
    // round-trips.
    const response = await requestWrite(sessionId, key, {
      op: 'update',
      id: created.id,
      fields: { title: 'Ship it', status: 'done' },
    });
    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    const written = response.record!;
    expect(written.fields.status).toBe('done');
    expect(resolveWorkflowCategory(written, registry)).toBe('done');

    // Not just the wire echo: the real on-disk store itself now holds
    // the new status, and reading it back over a fresh snapshot request
    // resolves to the same category — nothing about this round-trip
    // depended on client-held state.
    expect(trackerStore.get(projectPath, created.id)?.fields.status).toBe('done');
    const finalSnapshot = await requestSnapshot(sessionId, key);
    expect(finalSnapshot.outcome).toBe('ok');
    if (finalSnapshot.outcome !== 'ok') throw new Error('unreachable');
    const reread = finalSnapshot.records.find((record) => record.id === created.id)!;
    expect(resolveWorkflowCategory(reread, registry)).toBe('done');
  });
});
