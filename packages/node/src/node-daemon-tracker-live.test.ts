import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectedAccountSecretRef,
  PROTOCOL_V1,
  type ConnectedAccount,
  type ConnectedAccountAnnounce,
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

import { AccountPinStore } from './account-pin-store';
import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import { JiraConnectService } from './jira-connect';
import { NativeTrackerStore } from './native-tracker-store';
import { createNode, type NodeDaemon } from './node-daemon';
import { TrackerModeStore } from './tracker-mode-store';

/**
 * Live-mode dispatch, end to end (SPEC §7.10, §7.26; issue #631;
 * re-addressed by `nodeId` + `projectPath` under issue #697):
 * `readTrackerSnapshot`/`applyTrackerWrite` reach a REAL `GithubTrackerBackend`,
 * composed through a REAL `GithubConnectService` and a real file-fallback
 * keyring (mirrors `tracker-backend-composition.test.ts`'s own end-to-end
 * block), over a REAL relay — only the actual GitHub HTTP call is stubbed
 * (`trackerBackendFetchImpl`). No session is ever created in this suite
 * (issue #697's whole point: a project's tracker, native or live, is
 * reachable with no agent session running for it) — mirrors
 * `node-daemon-tracker.test.ts`'s harness exactly. That file itself is
 * untouched by this issue's dispatch logic and is the proof native mode
 * behaves exactly as before (acceptance: those tests still pass, addressing
 * aside).
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

/** Mirrors `node-daemon-tracker.test.ts`'s own `derivePhoneProjectKey` exactly — an independent derivation off `deriveKeyTree`/`importAesGcmKey`, not a call to `deriveProjectKey` itself, so this proves real wire interop. */
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

/** Mirrors `node-daemon-tracker.test.ts`'s own `TestPhone` exactly. */
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

/** A raw node-role peer used only to seed the relay's `connected_accounts` registry via `connected_account_announce` (SPEC §7.26) — the relay-side half of a "prior connect flow", exactly like `connected-accounts.test.ts`'s own `initConnection({role:'node', ...})`. Never the `NodeDaemon` under test itself: the point of this whole suite is that the daemon has NO independent copy of this list and must ask the relay for it on its own connection. */
class AnnouncerPeer {
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, opts: { deviceId: string; authToken: string }) {
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
          devicePublicKey: randomBase64(),
        }),
      );
    });
    this.socket.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type?: string };
      if (!settled && parsed.type === 'initialize_result') {
        settled = true;
        resolve();
      }
    });
    this.socket.addEventListener('error', () => {
      if (!settled) reject(new Error(`AnnouncerPeer: cannot reach ${url}`));
    });
  }

  announce(account: ConnectedAccount): void {
    const message: ConnectedAccountAnnounce = {
      type: 'connected_account_announce',
      protocolVersion: PROTOCOL_V1,
      account,
    };
    this.socket.send(JSON.stringify(message));
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

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const id = 'github:github.com:1111';
  return {
    id,
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1111',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo', 'read:user', 'read:org'],
    capabilities: ['repo', 'issues'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef(id),
    ...overrides,
  };
}

function githubIssuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: 'Ship it',
    html_url: 'https://github.com/fiorelorenzo/loombox/issues/42',
    state: 'open',
    state_reason: null,
    body: 'body text',
    labels: [],
    assignees: [],
    milestone: null,
    user: { login: 'octocat' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

interface RecordedFetch {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** Stubs exactly what `GithubTrackerBackend.list`/`create`/`update` call — never the real GitHub API (issue #213's own acceptance, reused here). Records every call so a test can assert read and write hit the identical `owner/repo`. */
function githubFetchStub(calls: RecordedFetch[], token: string): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe(`Bearer ${token}`);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, url, body });

    if (method === 'GET') return jsonResponse(200, [githubIssuePayload()]);
    if (method === 'POST') {
      return jsonResponse(201, githubIssuePayload({ number: 43, title: body?.title }));
    }
    if (method === 'PATCH') {
      return jsonResponse(
        200,
        githubIssuePayload({ title: body?.title ?? 'Ship it', state: body?.state ?? 'open' }),
      );
    }
    throw new Error(`githubFetchStub: unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
}

const githubMode: TrackerMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'github:github.com:1111',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
};

const NODE_ID = 'node-tracker-live';

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;
let announcer: AnnouncerPeer | undefined;

beforeEach(async () => {
  relay = await startRelay();
  // A plain identifier, deliberately never created as a real directory —
  // see `node-daemon-tracker.test.ts`'s identical `beforeEach` comment:
  // nothing about live-mode dispatch (`TrackerModeStore`/`AccountPinStore`/
  // `GithubConnectService`/`GithubTrackerBackend`) ever touches the
  // filesystem at `projectPath` itself, and issue #697 means no session
  // (which previously needed a real git repo to create) is created here
  // either.
  projectPath = '/home/dev/no-session-live-project';
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tracker-live-state-'));
});

afterEach(async () => {
  phone?.close();
  announcer?.close();
  if (node) await node.close();
  await relay.close();
  await rm(nodeStateDir, { recursive: true, force: true });
});

interface ConnectOverTheWireOptions {
  accountId?: string;
  mode?: TrackerMode;
  /** Announced on the relay before the node connects — omit to leave the registry empty (the `accountNotConnected` case). */
  announcedAccount?: ConnectedAccount;
  /** Written into the shared keyring before the node connects — omit to leave the account connected-but-credential-less (the `credentialUnavailable` case). */
  keyringToken?: string;
  /** Written to `AccountPinStore` for the `github` capability — write-intent resolution never defaults, so a write test needs this even though a read test alone does not. */
  pinnedAccountId?: string;
  fetchImpl?: typeof fetch;
}

async function connectOverTheWire(
  opts: ConnectOverTheWireOptions = {},
): Promise<{ key: CryptoKey; accountId: string }> {
  const amk = generateAmk();
  const accountId = opts.accountId ?? 'acct-tracker-live';

  if (opts.mode) {
    new TrackerModeStore({ stateDir: nodeStateDir }).set(projectPath, opts.mode);
  }
  if (opts.pinnedAccountId) {
    new AccountPinStore({ stateDir: nodeStateDir }).setPin(
      projectPath,
      'github',
      opts.pinnedAccountId,
    );
  }
  if (opts.keyringToken && opts.announcedAccount) {
    const keyring = createConnectedAccountKeyring({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    await keyring.set(
      CONNECTED_ACCOUNT_KEYRING_SERVICE,
      opts.announcedAccount.secretRef,
      opts.keyringToken,
    );
  }
  if (opts.announcedAccount) {
    announcer = new AnnouncerPeer(relay.url, {
      deviceId: `announcer-${accountId}`,
      authToken: accountId,
    });
    await announcer.ready;
    announcer.announce(opts.announcedAccount);
    // A real announce over a real WebSocket needs a real wait to land
    // relay-side before the node's own connection requests the list —
    // mirrors `connected-accounts.test.ts`'s own identical real-timer
    // wait, for the identical reason (no in-process signal to await
    // instead).
    await sleep(50);
  }

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: NODE_ID,
    deviceId: 'device-node-tracker-live',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    githubConnectService: new GithubConnectService({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    }),
    jiraConnectService: new JiraConnectService({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    }),
    trackerBackendFetchImpl: opts.fetchImpl,
  });

  const key = await derivePhoneProjectKey(amk, accountId, projectPath);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-tracker-live',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;

  return { key, accountId };
}

async function requestSnapshot(key: CryptoKey): Promise<TrackerSnapshotResponsePayloadV1> {
  const requestId = `snap-${Math.random()}`;
  const envelope = await phoneSeal(projectPath, {}, key);
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

describe('NodeDaemon live tracker wire path — real relay, real GithubConnectService/keyring, stubbed GitHub API, NO session/bridge ever created (SPEC §7.10, §7.26; issues #631, #697)', () => {
  it('read reaches the real (stubbed) GitHub API and returns the fetched issue, mapped into the native record wire shape', async () => {
    const account = githubAccount();
    const calls: RecordedFetch[] = [];
    const { key } = await connectOverTheWire({
      mode: githubMode,
      announcedAccount: account,
      keyringToken: 'ghp_real_token',
      fetchImpl: githubFetchStub(calls, 'ghp_real_token'),
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('ok');
    if (snapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]?.id).toBe('42');
    expect(snapshot.records[0]?.fields.title).toBe('Ship it');
    expect(snapshot.records[0]?.fields.workflowCategory).toBe('new');
    expect(snapshot.types).toEqual([
      {
        id: 'github',
        label: 'GitHub Issue',
        builtin: true,
        roles: { title: 'title', workflowStatus: 'workflowCategory' },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/repos/fiorelorenzo/loombox/issues');
  });

  it('write (update) reaches the real (stubbed) GitHub API and returns the patched issue', async () => {
    const account = githubAccount();
    const calls: RecordedFetch[] = [];
    const { key } = await connectOverTheWire({
      mode: githubMode,
      announcedAccount: account,
      keyringToken: 'ghp_real_token',
      pinnedAccountId: account.id,
      fetchImpl: githubFetchStub(calls, 'ghp_real_token'),
    });

    const response = await requestWrite(key, {
      op: 'update',
      id: '42',
      fields: { title: 'Ship it faster', state: 'closed' },
    });
    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    expect(response.record?.fields.title).toBe('Ship it faster');
    expect(response.record?.fields.state).toBe('closed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/repos/fiorelorenzo/loombox/issues/42');
  });

  it('a live-mode defineType fails immediately, with no backend call at all — a live project\u2019s types come from the provider, never a user definition', async () => {
    const account = githubAccount();
    const calls: RecordedFetch[] = [];
    const { key } = await connectOverTheWire({
      mode: githubMode,
      announcedAccount: account,
      keyringToken: 'ghp_real_token',
      pinnedAccountId: account.id,
      fetchImpl: githubFetchStub(calls, 'ghp_real_token'),
    });

    const response = await requestWrite(key, {
      op: 'defineType',
      id: 'feature',
      label: 'Feature',
      roles: { title: 'summary' },
    });
    expect(response.outcome).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('read and write resolve the same project to the same tracker — both calls land on the identical owner/repo, from one shared resolution', async () => {
    const account = githubAccount();
    const calls: RecordedFetch[] = [];
    const { key } = await connectOverTheWire({
      mode: githubMode,
      announcedAccount: account,
      keyringToken: 'ghp_real_token',
      pinnedAccountId: account.id,
      fetchImpl: githubFetchStub(calls, 'ghp_real_token'),
    });

    await requestSnapshot(key);
    await requestWrite(key, { op: 'update', id: '42', fields: { title: 'x' } });

    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).pathname.replace(/\/issues.*$/, '')).toBe(
      new URL(calls[1]!.url).pathname.replace(/\/issues.*$/, ''),
    );
    expect(new URL(calls[0]!.url).pathname.replace(/\/issues.*$/, '')).toBe(
      '/repos/fiorelorenzo/loombox',
    );
  });

  it('accountNotConnected: a mode naming an account the relay never announced renders a typed error, never the local native store — even when that project has a real native record already on disk', async () => {
    const calls: RecordedFetch[] = [];
    // Seeded directly through the native store, at the same stateDir the
    // node under test will read from — proves the point concretely: a
    // fallback bug would show this exact record in the 'ok' response
    // instead of the 'error' outcome asserted below.
    const nativeStore = new NativeTrackerStore({ stateDir: nodeStateDir });
    const seeded = nativeStore.create(projectPath, {
      primaryType: 'task',
      fields: { title: 'A real local record that must never leak through' },
      authorId: 'someone',
    });

    const { key } = await connectOverTheWire({
      mode: githubMode, // connectionId 'github:github.com:1111', never announced below
      fetchImpl: githubFetchStub(calls, 'irrelevant'),
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('error');
    if (snapshot.outcome !== 'error') throw new Error('unreachable');
    expect(snapshot.reason).toEqual({
      kind: 'accountNotConnected',
      connectionId: 'github:github.com:1111',
    });
    expect(snapshot.message).toMatch(/connected account/i);
    // The real assertion this test exists for: never a silent 'ok' with
    // the native store's real record, which the seed above proves is
    // genuinely sitting on disk and would appear here if the dispatch
    // ever fell back to it.
    expect(JSON.stringify(snapshot)).not.toContain(seeded.id);
    expect(calls).toHaveLength(0);

    const writeResponse = await requestWrite(key, {
      op: 'update',
      id: '42',
      fields: { title: 'x' },
    });
    expect(writeResponse.outcome).toBe('error');
    if (writeResponse.outcome !== 'error') throw new Error('unreachable');
    expect(writeResponse.reason?.kind).toBe('accountNotConnected');
  });

  it('credentialUnavailable: an announced, pinned account with no token in this node\u2019s keyring renders a typed error, never the local store', async () => {
    const account = githubAccount();
    const calls: RecordedFetch[] = [];
    const { key } = await connectOverTheWire({
      mode: githubMode,
      announcedAccount: account,
      // No keyringToken — the account is connected/pinned but this
      // node's keyring never received its secret.
      pinnedAccountId: account.id,
      fetchImpl: githubFetchStub(calls, 'irrelevant'),
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('error');
    if (snapshot.outcome !== 'error') throw new Error('unreachable');
    expect(snapshot.reason).toEqual({ kind: 'credentialUnavailable', connectionId: account.id });
    expect(calls).toHaveLength(0);
  });
});
