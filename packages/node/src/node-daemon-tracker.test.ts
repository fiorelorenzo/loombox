import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildTrackerTypeRegistryV1,
  PROTOCOL_V1,
  resolveWorkflowCategory,
  type EncryptedEnvelope,
  type TrackerMode,
  type TrackerSnapshotResponsePayloadV1,
  type TrackerWriteResponsePayloadV1,
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
import { NativeTrackerStore } from './native-tracker-store';
import { TrackerModeStore } from './tracker-mode-store';

/**
 * The wire-level proof for issue #212's central acceptance criterion —
 * "UI is exercised against the MCP-created/updated records so agent
 * writes show up live" — re-proven under issue #697's project addressing:
 * a `tracker_snapshot_request`/`tracker_write_request` pair, sealed/opened
 * exactly like a real client would under `deriveProjectKey`, against the
 * SAME `NativeTrackerStore` a future MCP host binds an agent's `tracker_*`
 * tools to (issue #211) — proven here by seeding a record directly through
 * the store (standing in for an agent write) and observing it over the
 * wire. No session is ever created in this suite (that is #697's whole
 * point: the Tracker page's records must be reachable with no agent
 * session running, and no bridge to route through) — mirrors
 * `node-daemon-permission-policy.test.ts`'s real-relay harness shape (same
 * phone-side crypto helpers), narrowed to what tracker requests need: no
 * terminal, no permission policy, no session/`SessionBridge` at all, and
 * an event-driven `TestPhone.waitFor` (a single hang-guard timeout, no
 * busy-poll) rather than that file's polling loop.
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

/**
 * Independently derives the exact same project key `NodeDaemon.getProjectKey`
 * computes internally (via `@loombox/crypto`'s `deriveProjectKey`) — built
 * straight off `deriveKeyTree`/`importAesGcmKey` rather than calling
 * `deriveProjectKey` itself, so this test proves real wire interop rather
 * than being tautological against the same helper the implementation calls
 * (mirrors this file's own former `derivePhoneSessionKey`, and
 * `session-keys.ts`'s documented `['project', accountId, projectPath]`
 * path).
 */
async function derivePhoneProjectKey(
  amk: Uint8Array,
  accountId: string,
  projectPath: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['project', accountId, projectPath]);
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

interface PendingWaiter {
  predicate: (message: WireMessageV1) => boolean;
  resolve: (message: WireMessageV1) => void;
}

/** A bare client speaking just enough of the v1 handshake to exchange `tracker_*` requests/responses — event-driven throughout: `waitFor` resolves the instant a matching message arrives, with a single hang-guard timeout rather than a poll loop. */
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

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;
let trackerStore: NativeTrackerStore;

const NODE_ID = 'node-tracker';
const ACCOUNT_ID = 'acct-tracker';

beforeEach(async () => {
  relay = await startRelay();
  // A plain identifier, deliberately never created as a real directory —
  // `NativeTrackerStore` is a `stateDir`-scoped JSON file keyed by the
  // literal `projectPath` string (see its own doc comment), so nothing
  // about this suite's central claim — a project's tracker is reachable
  // with no bridge and no session — depends on the path resolving to
  // anything on disk.
  projectPath = '/home/dev/no-session-project';
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tracker-state-'));
  trackerStore = new NativeTrackerStore({ stateDir: nodeStateDir });
});

afterEach(async () => {
  phone?.close();
  if (node) await node.close();
  await relay.close();
  await rm(nodeStateDir, { recursive: true, force: true });
});

/** Boots the node and a bare phone client — no session, no bridge, ever. */
async function connectOverTheWire(): Promise<{ key: CryptoKey; amk: Uint8Array }> {
  const amk = generateAmk();

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: NODE_ID,
    deviceId: 'device-node-tracker',
    devicePublicKey: randomBase64(),
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk,
    nativeTrackerStore: trackerStore,
  });

  const key = await derivePhoneProjectKey(amk, ACCOUNT_ID, projectPath);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-tracker',
    devicePublicKey: randomBase64(),
    authToken: ACCOUNT_ID,
  });
  await phone.ready;

  return { key, amk };
}

async function requestSnapshot(
  key: CryptoKey,
  includeArchived?: boolean,
): Promise<TrackerSnapshotResponsePayloadV1> {
  const requestId = `snap-${Math.random()}`;
  const envelope = await phoneSeal(projectPath, { includeArchived }, key);
  phone!.send({
    type: 'tracker_snapshot_request',
    protocolVersion: PROTOCOL_V1,
    nodeId: NODE_ID,
    projectPath,
    requestId,
    envelope,
  });
  const reply = await phone!.waitFor(
    (m) => m.type === 'tracker_snapshot_response' && m.requestId === requestId,
  );
  if (reply.type !== 'tracker_snapshot_response') throw new Error('unreachable');
  return phoneOpen<TrackerSnapshotResponsePayloadV1>(projectPath, reply.envelope, key);
}

async function requestWrite(
  key: CryptoKey,
  payload: Record<string, unknown>,
): Promise<TrackerWriteResponsePayloadV1> {
  const requestId = `write-${Math.random()}`;
  const envelope = await phoneSeal(projectPath, payload, key);
  phone!.send({
    type: 'tracker_write_request',
    protocolVersion: PROTOCOL_V1,
    nodeId: NODE_ID,
    projectPath,
    requestId,
    envelope,
  });
  const reply = await phone!.waitFor(
    (m) => m.type === 'tracker_write_response' && m.requestId === requestId,
  );
  if (reply.type !== 'tracker_write_response') throw new Error('unreachable');
  return phoneOpen<TrackerWriteResponsePayloadV1>(projectPath, reply.envelope, key);
}

describe('NodeDaemon native tracker wire path — real terminal-free node, real relay, NO session/bridge ever created (SPEC §7.10; issues #212, #697)', () => {
  it('tracker_snapshot_request returns real records for a project with no bridge at all — not by tearing a session down, by never creating one', async () => {
    const { key } = await connectOverTheWire();
    const seeded = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Agent-authored', status: 'todo' },
      authorId: 'agent-session-1',
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('ok');
    if (snapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toEqual(seeded);
    expect(snapshot.types.map((t) => t.id).sort()).toEqual(['bug', 'epic', 'task']);
  });

  it('tracker_snapshot_request returns an empty record list and the built-in types for a project that has never had any tracker activity', async () => {
    const { key } = await connectOverTheWire();
    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('ok');
    if (snapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(snapshot.records).toEqual([]);
    expect(snapshot.types.map((t) => t.id).sort()).toEqual(['bug', 'epic', 'task']);
  });

  it('tracker_write_request(op: create) persists through the real store with no session, and stamps authorId from the node\u2019s own accountId, never from the payload', async () => {
    const { key } = await connectOverTheWire();
    const response = await requestWrite(key, {
      op: 'create',
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
    });
    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    expect(response.record).toBeDefined();
    const record = response.record!;
    expect(record.fields).toEqual({ title: 'Ship it', status: 'todo' });
    expect(record.system.authorId).toBe(ACCOUNT_ID);
    expect(trackerStore.get(projectPath, record.id)).toEqual(record);
  });

  it('tracker_write_request(op: update) moves a record between kanban columns through the real store', async () => {
    const { key } = await connectOverTheWire();
    const created = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
      authorId: 'agent-session-1',
    });

    const response = await requestWrite(key, {
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
    const { key } = await connectOverTheWire();
    const response = await requestWrite(key, {
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

    const snapshot = await requestSnapshot(key);
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
    const { key } = await connectOverTheWire();
    const response = await requestWrite(key, {
      op: 'create',
      primaryType: 'ghost-type',
      fields: {},
    });
    expect(response.outcome).toBe('error');
    if (response.outcome !== 'error') throw new Error('unreachable');
    expect(response.message).toMatch(/ghost-type/);
  });

  it('tracker_snapshot_request(includeArchived: true) includes an archived record; the default excludes it', async () => {
    const { key } = await connectOverTheWire();
    const created = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Old' },
      authorId: 'a',
    });
    trackerStore.update(projectPath, created.id, { archived: true });

    const defaultSnapshot = await requestSnapshot(key);
    expect(defaultSnapshot.outcome).toBe('ok');
    if (defaultSnapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(defaultSnapshot.records).toEqual([]);

    const fullSnapshot = await requestSnapshot(key, true);
    expect(fullSnapshot.outcome).toBe('ok');
    if (fullSnapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(fullSnapshot.records).toHaveLength(1);
  });

  it('moving a card across a workflow-category boundary (issue #651, v7 decision F4-2) writes the literal category id back through the real store, and it resolves to the same category on a fresh snapshot', async () => {
    const { key } = await connectOverTheWire();
    const created = trackerStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
      authorId: 'agent-session-1',
    });

    const initialSnapshot = await requestSnapshot(key);
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
    const response = await requestWrite(key, {
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
    const finalSnapshot = await requestSnapshot(key);
    expect(finalSnapshot.outcome).toBe('ok');
    if (finalSnapshot.outcome !== 'ok') throw new Error('unreachable');
    const reread = finalSnapshot.records.find((record) => record.id === created.id)!;
    expect(resolveWorkflowCategory(reread, registry)).toBe('done');
  });
});

describe('tracker_snapshot_request/tracker_write_request answer every request, never silence it (issue #697; #691\u2019s class one layer down)', () => {
  it('an envelope that fails to decrypt (wrong key entirely) comes back as an outcome: error response, not a timeout', async () => {
    const { amk } = await connectOverTheWire();
    // A key derived for a DIFFERENT project — decrypting under the real
    // project key will fail its AES-GCM auth tag, exactly the "unparseable
    // envelope" case #697 requires an answer for.
    const wrongKey = await derivePhoneProjectKey(amk, ACCOUNT_ID, '/home/dev/some-other-project');

    const requestId = `snap-bad-${Math.random()}`;
    const envelope = await phoneSeal(projectPath, { includeArchived: false }, wrongKey);
    phone!.send({
      type: 'tracker_snapshot_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: NODE_ID,
      projectPath,
      requestId,
      envelope,
    });
    const reply = await phone!.waitFor(
      (m) => m.type === 'tracker_snapshot_response' && m.requestId === requestId,
    );
    if (reply.type !== 'tracker_snapshot_response') throw new Error('unreachable');
    // The response envelope is sealed under the REAL project key (the node
    // derives it locally, independent of what the request could decrypt
    // under) — open it with the correct key to read the error.
    const correctKey = await derivePhoneProjectKey(amk, ACCOUNT_ID, projectPath);
    const payload = await phoneOpen<TrackerSnapshotResponsePayloadV1>(
      projectPath,
      reply.envelope,
      correctKey,
    );
    expect(payload.outcome).toBe('error');
  });

  it('a live-mode project this node cannot resolve a backend for (no connected account) still answers with an outcome: error response, not silence', async () => {
    const { key } = await connectOverTheWire();
    // Puts the project in live mode with no connected GitHub account at
    // all — `resolveTrackerDispatch` cannot compose a backend, which is a
    // real "cannot serve" case distinct from a decrypt failure, already
    // routed through `trackerResolutionErrorPayload` rather than a silent
    // drop. Written through a fresh `TrackerModeStore` pointed at the same
    // `nodeStateDir` the node itself defaults its own store to (mirrors
    // `node-daemon-tracker-live.test.ts`'s own `connectOverTheWire` setup)
    // — `TrackerModeStore.get` re-reads from disk on every call, so the
    // node picks this up on its very next request with no extra wiring.
    const mode: TrackerMode = {
      kind: 'live',
      provider: 'github',
      connectionId: 'github:github.com:no-such-account',
      target: { owner: 'octo', repo: 'demo' },
    };
    new TrackerModeStore({ stateDir: nodeStateDir }).set(projectPath, mode);

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('error');
  });
});
