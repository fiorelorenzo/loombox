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
import { createNode, type NodeDaemon } from './node-daemon';
import { resolveTrackerBackend } from './tracker-backend-composition';
import { TrackerModeStore } from './tracker-mode-store';

/**
 * Live-mode dispatch, end to end, for Jira (SPEC §7.10, §7.26; issues
 * #631, #696) — the direct counterpart of `node-daemon-tracker-live.test.ts`
 * (GitHub), which this file mirrors line-for-line in harness shape: a REAL
 * `JiraTrackerBackend`, composed through a REAL `JiraConnectService` and a
 * real file-fallback keyring, over a REAL relay — only the actual Jira
 * HTTP call is stubbed (`trackerBackendFetchImpl`). No session is ever
 * created here either (issue #697).
 *
 * Issue #696's own reasoning for why this file has to exist separately
 * from asserting "the code path is shared, so it must work": Jira and
 * GitHub diverge exactly where a wire bug hides — a `cloudId`-shaped
 * `JiraTarget` instead of `{owner, repo}`, a Basic `authHeader` built from
 * an `{email, apiToken}` keyring blob instead of a bearer token,
 * `credentialSource: 'api_token'` gating a resolution branch GitHub never
 * takes (`credentialSourceUnsupported`, tested below), and — the write-back
 * half — a *discovered*, per-issue transition graph rather than GitHub's
 * fixed two-state pair. None of that is exercised by the GitHub file, and
 * unit tests on `JiraTrackerBackend` alone never prove any of it survives
 * a real `tracker_snapshot_request`/`tracker_write_request` round trip
 * through the relay and `resolveTrackerDispatch`.
 *
 * **What the stubbed Jira API fixture does and does not prove.** The fake
 * `fetchImpl` below is an in-memory Jira issue with a `statusCategory` and
 * a small, hand-written transition graph — never Jira's real REST v3
 * service, which is not reachable from CI (issue #696's own text). It
 * proves this repo's own wiring — `resolveTrackerDispatch` ->
 * `JiraTrackerBackend` -> `applyLiveTrackerCategoryMove` -> the wire
 * response — reaches the right URLs with the right auth header and the
 * right bodies, and that a mutation the fixture records is the one that
 * comes back on the next read. It does NOT prove real Jira's `search/jql`,
 * `transitions`, or ADF field validation behave the way this fixture
 * assumes; that assumption already carries the same risk
 * `jira-tracker-backend.test.ts` accepted for every other Jira behavior it
 * covers, and is called out again here rather than left implicit.
 *
 * **Boards/sprints (issue #217) extend this SAME harness, not a second
 * one, with one honest difference from the issue-CRUD coverage above:
 * there is no `tracker_snapshot_request`/`tracker_write_request` wire
 * message for `listBoards`/`listSprints`/`moveToSprint` at all yet (no
 * consumer wires them onto the wire protocol as of #217 — that is a
 * later slice's job, not this one's). So the boards/sprints block below
 * calls `resolveTrackerBackend` directly — the exact same composition
 * function `NodeDaemon.resolveTrackerDispatch` calls internally
 * (`./tracker-backend-composition.ts`) — rather than going through
 * `phone.send`/`requestSnapshot`. It still proves something real: a
 * SECOND `JiraConnectService` instance, pointed at the same
 * `nodeStateDir` `connectOverTheWire` already provisioned (the identical
 * on-disk keyring secret a real relay announce + a real `AccountPinStore`
 * pin wrote), resolves the identical credential the issue-CRUD tests
 * above already proved works — so boards/sprints are NOT a second,
 * untested credential path. The Jira API itself is still the same
 * `jiraFetchStub`, extended with `GET board`/`GET board/{id}/sprint`/
 * `POST sprint/{id}/issue` branches over a small in-memory board/sprint
 * fixture — never a real Jira Agile REST service, same fixture-honesty
 * disclosure as the paragraph above.
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

/** Mirrors `node-daemon-tracker-live.test.ts`'s own `derivePhoneProjectKey` exactly. */
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

/** Mirrors `node-daemon-tracker-live.test.ts`'s own `TestPhone` exactly. */
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

/** Mirrors `node-daemon-tracker-live.test.ts`'s own `AnnouncerPeer` exactly. */
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

function jiraAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const id = 'jira:myteam.atlassian.net:acct-42';
  return {
    id,
    provider: 'jira',
    host: 'myteam.atlassian.net',
    providerAccountId: 'acct-42',
    label: 'lorenzo',
    credentialSource: 'api_token',
    scopes: null,
    capabilities: ['comments', 'transitions', 'boards', 'sprints'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef(id),
    ...overrides,
  };
}

const SITE_BASE = 'https://myteam.atlassian.net';

/** The one in-memory issue the fixture below reads/writes — deliberately mutable, so a PUT/transition really changes what the next GET returns (issue #696's own "asserted rather than assumed" bar for the write-back test). */
interface FakeJiraIssue {
  key: string;
  title: string;
  statusName: string;
  statusCategoryKey: 'new' | 'indeterminate' | 'done';
}

function newFakeIssue(overrides: Partial<FakeJiraIssue> = {}): FakeJiraIssue {
  return {
    key: 'LB-213',
    title: 'Ship it',
    statusName: 'To Do',
    statusCategoryKey: 'new',
    ...overrides,
  };
}

function jiraIssuePayload(issue: FakeJiraIssue): Record<string, unknown> {
  return {
    id: '10000',
    key: issue.key,
    self: `${SITE_BASE}/rest/api/3/issue/${issue.key}`,
    fields: {
      summary: issue.title,
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body text' }] }],
      },
      status: {
        name: issue.statusName,
        statusCategory: { key: issue.statusCategoryKey, name: issue.statusName },
      },
      issuetype: { name: 'Task' },
      assignee: null,
      reporter: null,
      labels: [],
      priority: { name: 'Medium' },
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
      resolutiondate: null,
    },
  };
}

/** A hand-written, small transition graph keyed on the issue's CURRENT `statusCategoryKey` — never Jira's real per-project workflow (see this file's own top comment). Just enough to prove a reachable move lands and an unreachable one is refused: from `new` only `done` is reachable; from `done` only back to `new`; `indeterminate` has no outgoing transition at all (the "zero transitions available" case). */
const FAKE_TRANSITIONS: Record<
  FakeJiraIssue['statusCategoryKey'],
  Array<{ id: string; name: string; to: FakeJiraIssue['statusCategoryKey'] }>
> = {
  new: [{ id: '21', name: 'Done', to: 'done' }],
  indeterminate: [],
  done: [{ id: '11', name: 'To Do', to: 'new' }],
};

/**
 * The board/sprint fixture issue #217's Agile REST coverage moves issues
 * through — deliberately separate from `FakeJiraIssue`'s single-issue
 * transition fixture above: a board carries no state of its own, and a
 * sprint's `state` (never flattened away — the field the acceptance
 * criteria exist for) is exactly what these tests prove survives the
 * round trip. `movedIssues` records what `moveToSprint` actually posted,
 * mutable the same "asserted rather than assumed" way `FakeJiraIssue`
 * is. Never a real Jira board (this file's own top comment).
 */
const FAKE_BOARD_ID = 84;

interface FakeJiraSprint {
  id: number;
  name: string;
  state: 'future' | 'active' | 'closed';
  startDate?: string;
  endDate?: string;
  goal?: string;
  movedIssues: string[];
}

function newFakeSprints(): FakeJiraSprint[] {
  return [
    {
      id: 30,
      name: 'Sprint 0',
      state: 'closed',
      startDate: '2025-12-01T00:00:00.000Z',
      endDate: '2025-12-14T00:00:00.000Z',
      movedIssues: [],
    },
    {
      id: 37,
      name: 'Sprint 1',
      state: 'active',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-14T00:00:00.000Z',
      goal: 'ship the boards/sprints slice',
      movedIssues: [],
    },
    { id: 44, name: 'Sprint 2', state: 'future', movedIssues: [] },
  ];
}
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => {
      throw new Error('emptyResponse: no body — a 204 caller must never call .json()');
    },
  } as unknown as Response;
}

interface RecordedFetch {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** Stubs exactly what `JiraTrackerBackend.list`/`get`/`update`/`listTransitions`/`transition` call against a single mutable `issue`, PLUS (issue #217) `listBoards`/`listSprints`/`moveToSprint` against a small mutable `sprints` fixture — never the real Jira API (issue #696's own text: a real instance is not available in CI). Records every call so a test can assert both the request shape (method/url/auth/body) and, for the write-back tests, that a later read reflects an earlier write. */
function jiraFetchStub(
  calls: RecordedFetch[],
  expectedAuthHeader: string,
  issue: FakeJiraIssue,
  sprints: FakeJiraSprint[] = newFakeSprints(),
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsedUrl = new URL(url);
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe(expectedAuthHeader);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, url, body });

    if (url === `${SITE_BASE}/rest/api/3/search/jql` && method === 'POST') {
      return jsonResponse(200, { issues: [jiraIssuePayload(issue)], isLast: true });
    }
    if (url === `${SITE_BASE}/rest/api/3/issue/${issue.key}/transitions` && method === 'GET') {
      const options = FAKE_TRANSITIONS[issue.statusCategoryKey];
      return jsonResponse(200, {
        transitions: options.map((t) => ({
          id: t.id,
          name: t.name,
          fields: {},
          to: { statusCategory: { key: t.to } },
        })),
      });
    }
    if (url === `${SITE_BASE}/rest/api/3/issue/${issue.key}/transitions` && method === 'POST') {
      const transitionId = (body?.transition as { id?: string } | undefined)?.id;
      const match = FAKE_TRANSITIONS[issue.statusCategoryKey].find((t) => t.id === transitionId);
      if (!match)
        throw new Error(
          `jiraFetchStub: transition "${String(transitionId)}" is not available from "${issue.statusCategoryKey}"`,
        );
      issue.statusName = match.name;
      issue.statusCategoryKey = match.to;
      return emptyResponse(204);
    }
    if (url === `${SITE_BASE}/rest/api/3/issue/${issue.key}` && method === 'GET') {
      return jsonResponse(200, jiraIssuePayload(issue));
    }
    if (url === `${SITE_BASE}/rest/api/3/issue/${issue.key}` && method === 'PUT') {
      const fields = (body?.fields as Record<string, unknown> | undefined) ?? {};
      if (typeof fields.summary === 'string') issue.title = fields.summary;
      return emptyResponse(204);
    }
    if (parsedUrl.pathname === '/rest/agile/1.0/board' && method === 'GET') {
      return jsonResponse(200, {
        isLast: true,
        maxResults: 50,
        startAt: 0,
        total: 1,
        values: [
          {
            id: FAKE_BOARD_ID,
            name: 'LB board',
            self: `${SITE_BASE}/rest/agile/1.0/board/${FAKE_BOARD_ID}`,
            type: 'scrum',
          },
        ],
      });
    }
    if (
      parsedUrl.pathname === `/rest/agile/1.0/board/${FAKE_BOARD_ID}/sprint` &&
      method === 'GET'
    ) {
      return jsonResponse(200, {
        isLast: true,
        maxResults: 50,
        startAt: 0,
        total: sprints.length,
        values: sprints.map((sprint) => ({
          id: sprint.id,
          self: `${SITE_BASE}/rest/agile/1.0/sprint/${sprint.id}`,
          state: sprint.state,
          name: sprint.name,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          originBoardId: FAKE_BOARD_ID,
          goal: sprint.goal,
        })),
      });
    }
    const sprintIssueMatch = /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/.exec(parsedUrl.pathname);
    if (sprintIssueMatch && method === 'POST') {
      const sprintId = Number(sprintIssueMatch[1]);
      const sprint = sprints.find((s) => s.id === sprintId);
      if (!sprint) throw new Error(`jiraFetchStub: no such sprint ${sprintId}`);
      const issues = (body?.issues as string[] | undefined) ?? [];
      sprint.movedIssues.push(...issues);
      return emptyResponse(204);
    }
    throw new Error(`jiraFetchStub: unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
}

const jiraMode: TrackerMode = {
  kind: 'live',
  provider: 'jira',
  connectionId: 'jira:myteam.atlassian.net:acct-42',
  target: { cloudId: 'cloud-id-123', projectKey: 'LB' },
};

const NODE_ID = 'node-tracker-live-jira';

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;
let announcer: AnnouncerPeer | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = '/home/dev/no-session-live-project-jira';
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-tracker-live-jira-state-'));
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
  announcedAccount?: ConnectedAccount;
  /** Written into the shared keyring as the raw `{email, apiToken}` JSON blob `JiraConnectService.getCredential` expects — omit to leave the account connected-but-credential-less. */
  keyringSecret?: { email: string; apiToken: string };
  pinnedAccountId?: string;
  fetchImpl?: typeof fetch;
}

async function connectOverTheWire(
  opts: ConnectOverTheWireOptions = {},
): Promise<{ key: CryptoKey; accountId: string }> {
  const amk = generateAmk();
  const accountId = opts.accountId ?? 'acct-tracker-live-jira';

  if (opts.mode) {
    new TrackerModeStore({ stateDir: nodeStateDir }).set(projectPath, opts.mode);
  }
  if (opts.pinnedAccountId) {
    new AccountPinStore({ stateDir: nodeStateDir }).setPin(
      projectPath,
      'jira',
      opts.pinnedAccountId,
    );
  }
  if (opts.keyringSecret && opts.announcedAccount) {
    const keyring = createConnectedAccountKeyring({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    await keyring.set(
      CONNECTED_ACCOUNT_KEYRING_SERVICE,
      opts.announcedAccount.secretRef,
      JSON.stringify(opts.keyringSecret),
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
    // mirrors `node-daemon-tracker-live.test.ts`'s/`connected-accounts.test.ts`'s
    // own identical real-timer wait, for the identical reason (no
    // in-process signal to await instead).
    await sleep(50);
  }

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: NODE_ID,
    deviceId: 'device-node-tracker-live-jira',
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
    deviceId: 'device-phone-tracker-live-jira',
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

const KEYRING_SECRET = { email: 'lorenzo@example.com', apiToken: 'jira-real-token' };
const EXPECTED_AUTH_HEADER = `Basic ${Buffer.from(`${KEYRING_SECRET.email}:${KEYRING_SECRET.apiToken}`).toString('base64')}`;

describe('NodeDaemon live tracker wire path — Jira, real relay, real JiraConnectService/keyring, stubbed Jira API, NO session/bridge ever created (SPEC §7.10, §7.26; issues #631, #696)', () => {
  it('read reaches the real (stubbed) Jira search/jql endpoint over Basic auth and returns the fetched issue, mapped into the native record wire shape', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('ok');
    if (snapshot.outcome !== 'ok') throw new Error('unreachable');
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]?.id).toBe('LB-213');
    expect(snapshot.records[0]?.fields.title).toBe('Ship it');
    expect(snapshot.records[0]?.fields.workflowCategory).toBe('new');
    expect(snapshot.types).toEqual([
      {
        id: 'jira',
        label: 'Jira Issue',
        builtin: true,
        roles: { title: 'title', workflowStatus: 'workflowCategory' },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${SITE_BASE}/rest/api/3/search/jql`);
    expect(calls[0]?.body?.jql).toContain('project = "LB"');
  });

  it('write (a plain field edit, no category change) PUTs the field then GETs the canonical issue back — Jira\u2019s own PUT response is empty', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    const response = await requestWrite(key, {
      op: 'update',
      id: 'LB-213',
      fields: { summary: 'Ship it faster' },
    });
    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    expect(response.record?.fields.title).toBe('Ship it faster');
    expect(response.record?.fields.workflowCategory).toBe('new');
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);
    expect(calls[0]?.url).toBe(`${SITE_BASE}/rest/api/3/issue/LB-213`);
    expect(calls[0]?.body?.fields).toEqual({ summary: 'Ship it faster' });
  });

  it('a board move to a reachable category discovers the matching Jira transition, posts it, then writes the rest of the fields — the write-back issue #696 exists for, asserted via a real follow-up read', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue(); // starts 'To Do' / category 'new'
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    const response = await requestWrite(key, {
      op: 'update',
      id: 'LB-213',
      fields: { summary: 'Ship it', workflowCategory: 'done' },
    });

    expect(response.outcome).toBe('ok');
    if (response.outcome !== 'ok') throw new Error('unreachable');
    // The real assertion this test exists for: the record handed back is a
    // fresh GET, not the pre-move fields echoed back — it genuinely
    // reflects the fixture's own post-transition state.
    expect(response.record?.fields.workflowCategory).toBe('done');
    expect(response.record?.fields.status).toBe('Done');

    // Exactly the sequence `applyLiveTrackerCategoryMove` documents: read
    // current category, discover transitions, post the matching one, then
    // PUT the remaining fields (with workflowCategory stripped) and GET
    // the canonical result.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /rest/api/3/issue/LB-213',
      'GET /rest/api/3/issue/LB-213/transitions',
      'POST /rest/api/3/issue/LB-213/transitions',
      'PUT /rest/api/3/issue/LB-213',
      'GET /rest/api/3/issue/LB-213',
    ]);
    expect(calls[2]?.body).toEqual({ transition: { id: '21' } });
    // workflowCategory never re-sent as a raw field PATCH — the whole
    // point of routing this through the discovered transition instead.
    expect(calls[3]?.body?.fields).toEqual({ summary: 'Ship it' });
  });

  it('a board move to a category with no discovered transition from here is refused end to end — an error outcome, and never a PUT that would silently drop the move', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    // 'indeterminate' has zero outgoing transitions in this fixture (see
    // FAKE_TRANSITIONS) — the "genuinely nowhere to go" case.
    const issue = newFakeIssue({ statusName: 'In Progress', statusCategoryKey: 'indeterminate' });
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    const response = await requestWrite(key, {
      op: 'update',
      id: 'LB-213',
      fields: { workflowCategory: 'done' },
    });

    expect(response.outcome).toBe('error');
    if (response.outcome !== 'error') throw new Error('unreachable');
    expect(response.message).toContain('done');
    expect(response.message).toMatch(/no transitions are available/i);
    // Never a PUT: a move that cannot land must never fall through to a
    // plain field patch that would silently succeed at the wrong thing.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(issue.statusCategoryKey).toBe('indeterminate');
  });

  it('a live-mode defineType fails immediately, with no backend call at all', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
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

  it('read and write resolve the same project to the same tracker — both calls land on the identical cloudId/projectKey binding, from one shared resolution', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    await requestSnapshot(key);
    await requestWrite(key, { op: 'update', id: 'LB-213', fields: { summary: 'x' } });

    expect(calls[0]?.body?.jql).toContain('project = "LB"');
    expect(calls.every((c) => c.url.startsWith(SITE_BASE))).toBe(true);
  });

  it('accountNotConnected: a mode naming an account the relay never announced renders a typed error', async () => {
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const { key } = await connectOverTheWire({
      mode: jiraMode, // connectionId 'jira:myteam.atlassian.net:acct-42', never announced below
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('error');
    if (snapshot.outcome !== 'error') throw new Error('unreachable');
    expect(snapshot.reason).toEqual({
      kind: 'accountNotConnected',
      connectionId: 'jira:myteam.atlassian.net:acct-42',
    });
    expect(calls).toHaveLength(0);
  });

  it('credentialUnavailable: an announced, pinned account with no secret in this node\u2019s keyring renders a typed error, never a request to Jira', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      // No keyringSecret — the account is connected/pinned but this
      // node's keyring never received its {email, apiToken}.
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('error');
    if (snapshot.outcome !== 'error') throw new Error('unreachable');
    expect(snapshot.reason).toEqual({ kind: 'credentialUnavailable', connectionId: account.id });
    expect(calls).toHaveLength(0);
  });

  it('credentialSourceUnsupported: a Jira account announced with any credentialSource other than api_token is refused before ever touching the keyring — a branch GitHub\u2019s own resolution path never takes', async () => {
    const account = jiraAccount({ credentialSource: 'oauth_3lo' });
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const { key } = await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue),
    });

    const snapshot = await requestSnapshot(key);
    expect(snapshot.outcome).toBe('error');
    if (snapshot.outcome !== 'error') throw new Error('unreachable');
    expect(snapshot.reason).toEqual({
      kind: 'credentialSourceUnsupported',
      connectionId: account.id,
      credentialSource: 'oauth_3lo',
    });
    expect(calls).toHaveLength(0);
  });
});

describe("JiraTrackerBackend Agile REST — boards/sprints resolved through the SAME resolveTrackerBackend/JiraConnectService/keyring composition as the wire tests above (issue #217; this file's own top comment explains why this block calls resolveTrackerBackend directly instead of phone.send)", () => {
  it('listBoards/listSprints/moveToSprint resolve credentials through a second JiraConnectService reading the identical on-disk keyring secret connectOverTheWire already wrote, then read/write the Agile REST base — a genuinely different base path and pagination shape from the issue API above', async () => {
    const account = jiraAccount();
    const calls: RecordedFetch[] = [];
    const issue = newFakeIssue();
    const sprints = newFakeSprints();
    await connectOverTheWire({
      mode: jiraMode,
      announcedAccount: account,
      keyringSecret: KEYRING_SECRET,
      pinnedAccountId: account.id,
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue, sprints),
    });

    // The exact same composition `NodeDaemon.resolveTrackerDispatch` calls
    // internally (`./tracker-backend-composition.ts`) — a SECOND
    // `JiraConnectService`/`GithubConnectService` pair, pointed at the
    // same `nodeStateDir`, reads the identical on-disk keyring secret and
    // account pin `connectOverTheWire` already wrote via a real relay
    // announce. If credential resolution for the Agile base diverged from
    // the issue base's own (already wire-tested above), the auth-header
    // assertion inside `jiraFetchStub` would fail here.
    const resolution = await resolveTrackerBackend({
      mode: jiraMode,
      projectPath,
      intent: 'read',
      accounts: [account],
      pins: new AccountPinStore({ stateDir: nodeStateDir }).get(projectPath),
      githubConnectService: new GithubConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      jiraConnectService: new JiraConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      fetchImpl: jiraFetchStub(calls, EXPECTED_AUTH_HEADER, issue, sprints),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('unreachable');
    const { backend } = resolution;
    if (!backend.listBoards || !backend.listSprints || !backend.moveToSprint) {
      throw new Error('unreachable: JiraTrackerBackend always implements boards/sprints');
    }

    const boards = await backend.listBoards({
      connectionId: account.id,
      target: jiraMode.target,
    });
    expect(boards).toEqual([{ id: expect.any(String), name: 'LB board' }]);

    const sprintList = await backend.listSprints(boards[0].id);
    // Sprint state modelled, not flattened into one combined list: three
    // sprints, three distinct states, each still carrying its board id.
    expect(sprintList.map((s) => ({ name: s.name, state: s.state }))).toEqual([
      { name: 'Sprint 0', state: 'closed' },
      { name: 'Sprint 1', state: 'active' },
      { name: 'Sprint 2', state: 'future' },
    ]);
    expect(sprintList.every((s) => s.boardId === boards[0].id)).toBe(true);

    const activeSprint = sprintList.find((s) => s.state === 'active');
    if (!activeSprint) throw new Error('unreachable');
    await backend.moveToSprint(activeSprint.id, ['LB-213']);

    // Asserted, not assumed: the fixture's own mutable sprint really
    // recorded the move.
    expect(sprints[1].movedIssues).toEqual(['LB-213']);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /rest/agile/1.0/board',
      'GET /rest/agile/1.0/board/84/sprint',
      'POST /rest/agile/1.0/sprint/37/issue',
    ]);
  });
});
