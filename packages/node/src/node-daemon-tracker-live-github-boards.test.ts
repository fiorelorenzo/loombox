import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectedAccountSecretRef,
  PROTOCOL_V1,
  type ConnectedAccount,
  type ConnectedAccountAnnounce,
  type ConnectedAccountList,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';
import { GithubConnectService } from './github-connect';
import { GithubTrackerBackend } from './github-tracker-backend';
import { JiraConnectService } from './jira-connect';
import { resolveTrackerBackend } from './tracker-backend-composition';

/**
 * GitHub Projects v2 boards (SPEC §7.10, issue #218), covered at the
 * SAME layer `node-daemon-tracker-live.test.ts` covers GitHub's issue
 * read/write path at (issue #696's shape): a REAL relay, a REAL
 * `connected_account_announce` -> `connected_account_list_request` round
 * trip (never an in-memory `accounts` array handed straight to
 * `resolveTrackerBackend`, the shortcut `tracker-backend-composition.test.ts`'s
 * own unit tests take), a REAL `GithubConnectService` + file-fallback
 * keyring resolving the actual stored token, and REAL `resolveTrackerBackend`
 * composition — the identical function `NodeDaemon.resolveTrackerDispatch`
 * calls internally. Only the GitHub GraphQL HTTP call itself is stubbed.
 *
 * **Why not drive this through `tracker_snapshot_request`/`NodeDaemon`
 * like the issue read/write suite does.** Boards are a `TrackerBackend`-
 * level capability (SPEC §7.10's phased delivery, slice 3) with no wire
 * message of their own — issue #218's acceptance is entirely about
 * `GithubTrackerBackend.listBoards`/`addBoardItem`/`moveBoardItemToCategory`,
 * never a client-facing board UI or its wire shape (out of scope here,
 * same as #215/#216 never added one for transitions either). This suite
 * proves the exact same things #696's file proves for issue read/write —
 * a real relay-sourced account, a real keyring-resolved token, real
 * composition — for the one entry point that actually exists today:
 * `resolveTrackerBackend` -> `GithubTrackerBackend`'s board methods.
 *
 * **The board fixture is recorded, not hand-written.** Reuses
 * `github-projects-v2.test.ts`'s own `LOOMBOX_BOARD_FIELDS` recording of
 * `gh project field-list 4 --owner fiorelorenzo --format json` (loombox's
 * own board), reshaped into the raw GraphQL envelope this backend's
 * stubbed `fetchImpl` returns.
 */

/** `initialize`'s `devicePublicKey` must parse as base64 (`@loombox/protocol`'s `base64String`) — a real ECDH P-256 public key in production, any random 32 bytes here since nothing in this suite exercises device-key crypto itself. */
function randomBase64Key(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

/** Mirrors `node-daemon-tracker-live.test.ts`'s own `AnnouncerPeer`, extended with the account-list round trip this suite needs instead of a phone-side encrypted wire path. A raw node-role relay connection — never the `NodeDaemon` under test itself, since there is none here (see this file's own top comment): the point is that account resolution reaches all the way to the relay's own registry, with no in-process shortcut. */
class RelayAccountPeer {
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;
  private readonly pending: Array<{
    predicate: (message: WireMessageV1) => boolean;
    resolve: (message: WireMessageV1) => void;
  }> = [];

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
          devicePublicKey: randomBase64Key(),
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
      for (let i = this.pending.length - 1; i >= 0; i -= 1) {
        if (this.pending[i]!.predicate(message)) {
          this.pending[i]!.resolve(message);
          this.pending.splice(i, 1);
        }
      }
    });
    this.socket.addEventListener('error', () => {
      if (!settled) reject(new Error(`RelayAccountPeer: cannot reach ${url}`));
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

  /** Mirrors exactly what `NodeDaemon.sendConnectedAccountListRequest`/`handleConnectedAccountList` do on every fresh connection (SPEC §7.26) — a real round trip through the relay's own registry, never a shortcut. */
  async listAccounts(): Promise<ConnectedAccount[]> {
    const waiter = new Promise<WireMessageV1>((resolve) => {
      this.pending.push({ predicate: (m) => m.type === 'connected_account_list', resolve });
    });
    this.socket.send(
      JSON.stringify({ type: 'connected_account_list_request', protocolVersion: PROTOCOL_V1 }),
    );
    const reply = (await waiter) as ConnectedAccountList;
    return reply.accounts;
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
  const id = 'github:github.com:2222';
  return {
    id,
    provider: 'github',
    host: 'github.com',
    providerAccountId: '2222',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo', 'read:user', 'read:org', 'read:project'],
    capabilities: ['repo', 'issues', 'boards'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: connectedAccountSecretRef(id),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as Response;
}

/**
 * `gh project field-list 4 --owner fiorelorenzo --format json`'s real
 * response against loombox's own project board (recorded 2026-08-08),
 * reshaped into the raw GraphQL envelope `PROJECT_V2_BOARD_QUERY`
 * returns — the identical fixture `github-projects-v2.test.ts`'s
 * `LOOMBOX_BOARD_FIELDS` uses. Kept as its own copy here (matching this
 * repo's own "each live-tracker relay suite is self-contained" harness
 * convention — see `node-daemon-tracker-live-jira.test.ts`'s top
 * comment) rather than an import, so this file reads standalone.
 */
function loombergBoardGraphQlResponse() {
  return {
    data: {
      repositoryOwner: {
        projectV2: {
          id: 'PVT_kwHOAci1qs4Bdjw9',
          title: 'loombox roadmap',
          fields: {
            nodes: [
              { __typename: 'ProjectV2Field', id: 'PVTF_lAHOAci1qs4Bdjw9zhYEdcs', name: 'Title' },
              {
                __typename: 'ProjectV2SingleSelectField',
                id: 'PVTSSF_lAHOAci1qs4Bdjw9zhYEdc0',
                name: 'Status',
                options: [
                  { id: 'f75ad846', name: 'Todo' },
                  { id: '47fc9ee4', name: 'In Progress' },
                  { id: '98236657', name: 'Done' },
                ],
              },
              {
                __typename: 'ProjectV2SingleSelectField',
                id: 'PVTSSF_lAHOAci1qs4Bdjw9zhZbVog',
                name: 'Priority',
                options: [
                  { id: 'c76fc317', name: 'P0' },
                  { id: '015792f7', name: 'P1' },
                  { id: 'ac34ba44', name: 'P2' },
                  { id: 'cb687423', name: 'P3' },
                ],
              },
              {
                __typename: 'ProjectV2SingleSelectField',
                id: 'PVTSSF_lAHOAci1qs4Bdjw9zhZbVx0',
                name: 'Effort',
                options: [
                  { id: '1917bf6c', name: 'S' },
                  { id: '19da86ee', name: 'M' },
                  { id: 'b53cfee4', name: 'L' },
                  { id: 'fb6b2ee7', name: 'XL' },
                ],
              },
              {
                __typename: 'ProjectV2SingleSelectField',
                id: 'PVTSSF_lAHOAci1qs4Bdjw9zhZbVx8',
                name: 'Parallel',
                options: [
                  { id: '8bb614bd', name: 'Yes' },
                  { id: '2ececb59', name: 'No' },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** The same real project's non-status fields ONLY (Priority/Effort/Parallel) — a board with no field whose options resolve to a workflow status, the degrade-honestly case (issue #218 acceptance). */
function boardWithNoUsableStatusFieldResponse() {
  const full = loombergBoardGraphQlResponse();
  full.data.repositoryOwner.projectV2.fields.nodes =
    full.data.repositoryOwner.projectV2.fields.nodes.filter((node) => node.name !== 'Status');
  return full;
}

let relay: StartedRelay;
let nodeStateDir: string;
let peer: RelayAccountPeer | undefined;

beforeEach(async () => {
  relay = await startRelay();
  nodeStateDir = await mkdtemp(
    path.join(tmpdir(), 'loombox-node-daemon-tracker-live-github-boards-state-'),
  );
});

afterEach(async () => {
  peer?.close();
  await relay.close();
  await rm(nodeStateDir, { recursive: true, force: true });
});

/**
 * Announces `account` over a real relay connection, writes its token to
 * the real shared keyring (the local equivalent of a prior device-flow
 * `connect()`), then asks the SAME relay for the account list back —
 * this is the "relay level" half of this suite: the `ConnectedAccount[]`
 * `resolveTrackerBackend` receives below comes from a real WebSocket
 * round trip through the relay's own registry, not a literal passed
 * straight to the function. `authToken`/`accountId` here is loombox's
 * OWN account identity (the relay connection's `connection.accountId`,
 * mirroring `node-daemon-tracker-live.test.ts`'s identical `authToken:
 * accountId` shape) — a different id entirely from `account`'s own
 * `providerAccountId` (GitHub's numeric user id), which the relay never
 * sees as an auth credential, only as `ConnectedAccount` metadata.
 */
async function connectOverTheWire(
  account: ConnectedAccount,
  token: string,
): Promise<ConnectedAccount[]> {
  const loomboxAccountId = 'acct-tracker-live-github-boards';
  const keyring = createConnectedAccountKeyring({
    stateDir: nodeStateDir,
    osKeyringBackendFactory: async () => undefined,
  });
  await keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, account.secretRef, token);

  peer = new RelayAccountPeer(relay.url, {
    deviceId: 'device-tracker-live-github-boards',
    authToken: loomboxAccountId,
  });
  await peer.ready;
  peer.announce(account);
  // A real announce over a real WebSocket needs a real wait to land
  // relay-side before this same connection's own list request —
  // mirrors `node-daemon-tracker-live.test.ts`'s identical real-timer
  // wait, for the identical reason (no in-process signal to await
  // instead).
  await sleep(50);
  return peer.listAccounts();
}

describe('GitHub Projects v2 board discovery, over a real relay + real credential resolution (SPEC §7.10; issues #218, #696)', () => {
  it('discovers the real board\u2019s own "Status" field rather than assuming one, using a relay-resolved account and a keyring-resolved token', async () => {
    const account = githubAccount();
    const accounts = await connectOverTheWire(account, 'ghp_real_token_for_boards');

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/graphql');
      expect((init?.headers as Record<string, string>).authorization).toBe(
        'Bearer ghp_real_token_for_boards',
      );
      const parsed = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      expect(parsed.variables).toEqual({ login: 'fiorelorenzo', number: 4 });
      return jsonResponse(200, loombergBoardGraphQlResponse());
    });

    const resolution = await resolveTrackerBackend({
      mode: {
        kind: 'live',
        provider: 'github',
        connectionId: account.id,
        target: { owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 },
      },
      projectPath: '/home/dev/no-session-live-project',
      intent: 'read',
      accounts,
      pins: {},
      githubConnectService: new GithubConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      jiraConnectService: new JiraConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      fetchImpl,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('unreachable');

    const boards = await resolution.backend.listBoards!({
      connectionId: account.id,
      target: { owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 },
    });

    expect(boards).toHaveLength(1);
    expect(boards[0]!.name).toBe('loombox roadmap');
    expect(boards[0]!.statusFieldUnavailableReason).toBeUndefined();
    expect(boards[0]!.statusField).toEqual({
      id: 'PVTSSF_lAHOAci1qs4Bdjw9zhYEdc0',
      name: 'Status',
      columns: [
        { id: 'f75ad846', name: 'Todo', targetCategory: 'new' },
        { id: '47fc9ee4', name: 'In Progress', targetCategory: 'indeterminate' },
        { id: '98236657', name: 'Done', targetCategory: 'done' },
      ],
    });
  });

  it('degrades with a stated reason, never a guess, when the board has no field whose options map onto a workflow status', async () => {
    const account = githubAccount();
    const accounts = await connectOverTheWire(account, 'ghp_real_token_for_boards');

    const fetchImpl = vi.fn(async () => jsonResponse(200, boardWithNoUsableStatusFieldResponse()));

    const resolution = await resolveTrackerBackend({
      mode: {
        kind: 'live',
        provider: 'github',
        connectionId: account.id,
        target: { owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 },
      },
      projectPath: '/home/dev/no-session-live-project',
      intent: 'read',
      accounts,
      pins: {},
      githubConnectService: new GithubConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      jiraConnectService: new JiraConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      fetchImpl,
    });
    if (!resolution.ok) throw new Error('unreachable');

    const boards = await resolution.backend.listBoards!({
      connectionId: account.id,
      target: { owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 },
    });

    expect(boards).toHaveLength(1);
    expect(boards[0]!.statusField).toBeUndefined();
    expect(boards[0]!.statusFieldUnavailableReason).toContain('Priority');
    expect(boards[0]!.statusFieldUnavailableReason).toContain('Effort');
    expect(boards[0]!.statusFieldUnavailableReason).toContain('Parallel');
  });

  it('links an issue onto the board then moves it by category, end to end, with a write-intent pin (Mutation.addProjectV2ItemById + Mutation.updateProjectV2ItemFieldValue)', async () => {
    const account = githubAccount();
    const accounts = await connectOverTheWire(account, 'ghp_real_token_for_boards');

    interface GraphQlRequestBody {
      readonly variables: Record<string, unknown>;
    }

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://api.github.com/repos/fiorelorenzo/loombox/issues/218') {
        return jsonResponse(200, {
          number: 218,
          node_id: 'I_kwDOboards218',
          title: 'GitHub Projects v2 boards',
          html_url: 'https://github.com/fiorelorenzo/loombox/issues/218',
          state: 'open',
          state_reason: null,
          body: '',
          labels: [],
          assignees: [],
          milestone: null,
          user: { login: 'octocat' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          closed_at: null,
        });
      }
      expect(url).toBe('https://api.github.com/graphql');
      const parsedBody = JSON.parse(String(init?.body)) as GraphQlRequestBody;
      const parsedVariables = parsedBody.variables;
      if ('contentId' in parsedVariables) {
        expect(parsedVariables).toEqual({
          contentId: 'I_kwDOboards218',
          projectId: 'PVT_kwHOAci1qs4Bdjw9',
        });
        return jsonResponse(200, {
          data: { addProjectV2ItemById: { item: { id: 'PVTI_item218' } } },
        });
      }
      expect(parsedVariables).toEqual({
        projectId: 'PVT_kwHOAci1qs4Bdjw9',
        itemId: 'PVTI_item218',
        fieldId: 'PVTSSF_lAHOAci1qs4Bdjw9zhYEdc0',
        value: { singleSelectOptionId: '47fc9ee4' },
      });
      return jsonResponse(200, {
        data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_item218' } } },
      });
    });

    const resolution = await resolveTrackerBackend({
      mode: {
        kind: 'live',
        provider: 'github',
        connectionId: account.id,
        target: { owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 },
      },
      projectPath: '/home/dev/no-session-live-project',
      intent: 'write',
      accounts,
      pins: { github: account.id },
      githubConnectService: new GithubConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      jiraConnectService: new JiraConnectService({
        stateDir: nodeStateDir,
        osKeyringBackendFactory: async () => undefined,
      }),
      fetchImpl,
    });
    if (!resolution.ok) throw new Error('unreachable');
    if (!(resolution.backend instanceof GithubTrackerBackend)) {
      throw new Error('unreachable: this suite only ever composes a github backend');
    }
    const backend = resolution.backend;
    const binding = {
      connectionId: account.id,
      target: { owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 },
    };

    const board = {
      id: 'PVT_kwHOAci1qs4Bdjw9',
      name: 'loombox roadmap',
      statusField: {
        id: 'PVTSSF_lAHOAci1qs4Bdjw9zhYEdc0',
        name: 'Status',
        columns: [
          { id: 'f75ad846', name: 'Todo', targetCategory: 'new' as const },
          { id: '47fc9ee4', name: 'In Progress', targetCategory: 'indeterminate' as const },
          { id: '98236657', name: 'Done', targetCategory: 'done' as const },
        ],
      },
    };

    const itemId = await backend.addBoardItem!(binding, board.id, '218');
    expect(itemId).toBe('PVTI_item218');

    await backend.moveBoardItemToCategory!(binding, board, itemId, 'indeterminate');

    expect(calls).toEqual([
      'https://api.github.com/repos/fiorelorenzo/loombox/issues/218',
      'https://api.github.com/graphql',
      'https://api.github.com/graphql',
    ]);
  });
});
