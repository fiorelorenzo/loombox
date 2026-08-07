import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AccountPinResolveResponse,
  AccountPinResponse,
  AccountPinScanResponse,
  ConnectedAccount,
  ConnectedAccountDisconnectResponse,
  GithubConnectResult,
  GithubPatConnectResponse,
  JiraConnectResponse,
  WireMessageV1,
} from '@loombox/protocol';
import { PROTOCOL_V1 } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import { generateAmk } from '@loombox/crypto';

import { AccountPinStore } from './account-pin-store';
import { GithubConnectService } from './github-connect';
import { JiraConnectService } from './jira-connect';
import { createNode, type NodeDaemon } from './node-daemon';

/**
 * The SPEC §7.26 connect/disconnect/pin wire handlers this issue (#230)
 * adds to `NodeDaemon` — mirrors `node-daemon-ssh.test.ts`'s lighter
 * `TestPhone` harness (a plain-field message pair needs neither AMK-derived
 * session keys nor an encrypted envelope). Deliberately does not exercise
 * `GithubConnectService.connect`'s device-flow success path or
 * `JiraConnectService.connect`'s identity-resolution success path through
 * this class: `handleGithubConnectStartRequest`/`handleJiraConnectRequest`
 * call `connect()` with no way to inject a stub `fetchImpl` (that's a
 * per-call option those services take, not something `NodeDaemonOptions`
 * exposes) — those paths are already covered end to end by
 * `github-connect.test.ts`/`jira-connect.test.ts` against a stubbed
 * fetch. What this file proves instead: the wiring — the right service
 * method gets called, the right wire reply comes back, and disconnect/pin
 * (which need no network at all) work through the real services.
 */

class TestPhone {
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
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends WireMessageV1>(
    predicate: (message: WireMessageV1) => message is T,
    timeoutMs?: number,
  ): Promise<T>;
  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs?: number,
  ): Promise<WireMessageV1>;
  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 5000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error('TestPhone: timed out waiting for a matching message');
      }
      await sleep(10);
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

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function isGithubConnectResult(m: WireMessageV1): m is GithubConnectResult {
  return m.type === 'github_connect_result';
}

function isGithubPatConnectResponse(m: WireMessageV1): m is GithubPatConnectResponse {
  return m.type === 'github_pat_connect_response';
}

function isJiraConnectResponse(m: WireMessageV1): m is JiraConnectResponse {
  return m.type === 'jira_connect_response';
}

function isDisconnectResponse(m: WireMessageV1): m is ConnectedAccountDisconnectResponse {
  return m.type === 'connected_account_disconnect_response';
}

function isPinResponse(m: WireMessageV1): m is AccountPinResponse {
  return m.type === 'account_pin_response';
}

function isResolveResponse(m: WireMessageV1): m is AccountPinResolveResponse {
  return m.type === 'account_pin_resolve_response';
}

function isScanResponse(m: WireMessageV1): m is AccountPinScanResponse {
  return m.type === 'account_pin_scan_response';
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'github:github.com:1234567',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1234567',
    label: 'octocat',
    credentialSource: 'device_flow',
    scopes: ['repo', 'read:user', 'read:org'],
    capabilities: ['repo', 'issues'],
    connectedAt: Date.now(),
    updatedAt: Date.now(),
    secretRef: 'connected-account-token:github:github.com:1234567',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Stub GitHub fetch used only to seed a real keyring secret directly through `GithubConnectService.connect` (bypassing `NodeDaemon`) — never reached through the wire handlers under test, which use the real global `fetch` and are never asked to succeed in this file. */
function stubGithubFetch(): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://github.com/login/device/code') {
      return jsonResponse(200, {
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return jsonResponse(200, {
        access_token: 'gho_seed-token-never-synced',
        token_type: 'bearer',
        scope: 'repo,read:user,read:org,read:project',
      });
    }
    if (url === 'https://api.github.com/user') {
      return jsonResponse(200, { id: 1234567, login: 'octocat', avatar_url: undefined });
    }
    throw new Error(`stubGithubFetch: unexpected URL ${url}`);
  };
  return impl;
}

/** Stub Jira fetch, same rationale as {@link stubGithubFetch}. */
function stubJiraFetch(): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://myteam.atlassian.net/rest/api/3/myself') {
      return jsonResponse(200, {
        accountId: 'abc-123',
        displayName: 'Ada Lovelace',
        avatarUrls: undefined,
      });
    }
    throw new Error(`stubJiraFetch: unexpected URL ${url}`);
  };
  return impl;
}

let relay: StartedRelay;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-account-connect-node-daemon-'));
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

function buildNode(opts: {
  nodeId: string;
  accountId: string;
  githubConnectClientId?: string;
  githubConnectService?: GithubConnectService;
  jiraConnectService?: JiraConnectService;
  accountPinStore?: AccountPinStore;
}): NodeDaemon {
  return createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: opts.nodeId,
    deviceId: `device-${opts.nodeId}`,
    devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    authToken: opts.accountId,
    accountId: opts.accountId,
    amk: generateAmk(),
    supervisor: new AgentSupervisor({ providers: [] }),
    githubConnectClientId: opts.githubConnectClientId,
    githubConnectService: opts.githubConnectService,
    jiraConnectService: opts.jiraConnectService,
    accountPinStore: opts.accountPinStore,
  });
}

async function connectPhone(accountId: string): Promise<TestPhone> {
  const p = new TestPhone(relay.url, {
    deviceId: `phone-${accountId}`,
    devicePublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    authToken: accountId,
  });
  await p.ready;
  return p;
}

describe('github_connect_start_request (SPEC §7.26, #230)', () => {
  it('fails immediately with a named error when no client id is configured, never touching the network', async () => {
    const accountId = 'acct-gh-noclient';
    node = buildNode({ nodeId: 'node-gh-1', accountId, githubConnectClientId: undefined });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'github_connect_start_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-gh-1',
    });
    const result = await phone.waitFor(isGithubConnectResult);
    expect(result.result).toEqual({
      outcome: 'failure',
      reason: 'error',
      message:
        'this node has no GitHub OAuth App client id configured (LOOMBOX_GITHUB_CONNECT_CLIENT_ID)',
    });
  });
});

describe('github_connect_cancel_request', () => {
  it('is a no-op for a requestId this node holds no in-flight flow for', async () => {
    const accountId = 'acct-gh-cancel';
    node = buildNode({ nodeId: 'node-gh-2', accountId });
    phone = await connectPhone(accountId);

    // No crash, no reply expected — just proves the handler tolerates an
    // unknown/already-settled requestId rather than throwing.
    phone.send({
      type: 'github_connect_cancel_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'never-started',
      nodeId: 'node-gh-2',
    });
    await sleep(100);
    expect(phone.messages).toEqual([]);
  });
});

describe('jira_connect_request / jira_connect_response', () => {
  it('surfaces a failure outcome, never the apiToken, when the connect attempt fails', async () => {
    const accountId = 'acct-jira-fail';
    node = buildNode({ nodeId: 'node-jira-1', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'jira_connect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-jira-1',
      nodeId: 'node-jira-1',
      siteUrl: 'this-host-does-not-resolve.invalid',
      email: 'me@example.com',
      apiToken: 'super-secret-token-never-synced',
    });
    const response = await phone.waitFor(isJiraConnectResponse, 15000);
    expect(response.result.outcome).toBe('failure');
    expect(JSON.stringify(response)).not.toContain('super-secret-token-never-synced');
  }, 20000);
});

describe('github_pat_connect_request / github_pat_connect_response (issue #224)', () => {
  it('surfaces a failure outcome, never the token, when the connect attempt fails', async () => {
    const accountId = 'acct-github-pat-fail';
    node = buildNode({ nodeId: 'node-github-pat-1', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'github_pat_connect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-github-pat-1',
      nodeId: 'node-github-pat-1',
      token: 'super-secret-fine-grained-pat-never-synced',
      host: 'this-host-does-not-resolve.invalid',
    });
    const response = await phone.waitFor(isGithubPatConnectResponse, 15000);
    expect(response.result.outcome).toBe('failure');
    expect(JSON.stringify(response)).not.toContain('super-secret-fine-grained-pat-never-synced');
  }, 20000);
});

describe('connected_account_disconnect_request / _response', () => {
  it('deletes a real GitHub keyring secret and replies ok', async () => {
    const accountId = 'acct-disc-gh';
    const githubService = new GithubConnectService({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    const account = await githubService.connect({
      clientId: 'client-id',
      fetchImpl: stubGithubFetch(),
      sleep: async () => {},
    });
    expect(await githubService.getAccessToken(account)).toBe('gho_seed-token-never-synced');

    node = buildNode({ nodeId: 'node-disc-1', accountId, githubConnectService: githubService });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'connected_account_disconnect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-disc-1',
      nodeId: 'node-disc-1',
      accountId: account.id,
    });
    const response = await phone.waitFor(isDisconnectResponse);
    expect(response.outcome).toBe('ok');
    expect(await githubService.getAccessToken(account)).toBeUndefined();
  });

  it('deletes a real Jira keyring secret and replies ok', async () => {
    const accountId = 'acct-disc-jira';
    const jiraService = new JiraConnectService({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    const account = await jiraService.connect({
      siteUrl: 'myteam.atlassian.net',
      email: 'me@example.com',
      apiToken: 'super-secret-token-never-synced',
      fetchImpl: stubJiraFetch(),
    });
    expect(await jiraService.getCredential(account)).toBeDefined();

    node = buildNode({ nodeId: 'node-disc-2', accountId, jiraConnectService: jiraService });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'connected_account_disconnect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-disc-2',
      nodeId: 'node-disc-2',
      accountId: account.id,
    });
    const response = await phone.waitFor(isDisconnectResponse);
    expect(response.outcome).toBe('ok');
    expect(await jiraService.getCredential(account)).toBeUndefined();
  });

  it('replies with an error outcome for an accountId with no recognized provider', async () => {
    const accountId = 'acct-disc-bad';
    node = buildNode({ nodeId: 'node-disc-3', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'connected_account_disconnect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-disc-3',
      nodeId: 'node-disc-3',
      accountId: 'not-a-connected-account-id',
    });
    const response = await phone.waitFor(isDisconnectResponse);
    expect(response.outcome).toBe('error');
    expect(response.message).toMatch(/unknown provider/);
  });
});

describe('account_pin_get/set/unset_request round trip (SPEC §7.26/#227, #230)', () => {
  it('sets, reads, opts out, and unsets a pin through the real AccountPinStore', async () => {
    const accountId = 'acct-pin-roundtrip';
    node = buildNode({ nodeId: 'node-pin-1', accountId });
    phone = await connectPhone(accountId);
    const p = phone;

    p.send({
      type: 'account_pin_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-pin-get-1',
      nodeId: 'node-pin-1',
      projectPath: '/home/dev/proj',
    });
    await p.waitFor(isPinResponse);
    expect(p.messages.filter(isPinResponse)[0]?.pins).toEqual({});

    p.send({
      type: 'account_pin_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-pin-set-1',
      nodeId: 'node-pin-1',
      projectPath: '/home/dev/proj',
      capability: 'github',
      accountId: 'github:github.com:1234567',
    });
    await p.waitFor(() => p.messages.filter(isPinResponse).length >= 2);
    expect(p.messages.filter(isPinResponse)[1]?.pins).toEqual({
      github: 'github:github.com:1234567',
    });

    p.send({
      type: 'account_pin_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-pin-set-2',
      nodeId: 'node-pin-1',
      projectPath: '/home/dev/proj',
      capability: 'jira',
      accountId: null,
    });
    await p.waitFor(() => p.messages.filter(isPinResponse).length >= 3);
    expect(p.messages.filter(isPinResponse)[2]?.pins).toEqual({
      github: 'github:github.com:1234567',
      jira: null,
    });

    p.send({
      type: 'account_pin_unset_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-pin-unset-1',
      nodeId: 'node-pin-1',
      projectPath: '/home/dev/proj',
      capability: 'github',
    });
    await p.waitFor(() => p.messages.filter(isPinResponse).length >= 4);
    expect(p.messages.filter(isPinResponse)[3]?.pins).toEqual({ jira: null });
  });
});

describe('account_pin_resolve_request / _response (SPEC §7.26/#227, #230)', () => {
  const target = { provider: 'github', host: 'github.com' };

  it('resolves a single unambiguous candidate on a read with no pin', async () => {
    const accountId = 'acct-resolve-read-ok';
    node = buildNode({ nodeId: 'node-resolve-1', accountId });
    phone = await connectPhone(accountId);
    const account = githubAccount();

    phone.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-1',
      nodeId: 'node-resolve-1',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'read',
      target,
      accounts: [account],
    });
    const response = await phone.waitFor(isResolveResponse);
    expect(response.result).toEqual({ outcome: 'resolved', account });
  });

  it('resolves to none on a read with no pin and no candidates', async () => {
    const accountId = 'acct-resolve-read-none';
    node = buildNode({ nodeId: 'node-resolve-2', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-2',
      nodeId: 'node-resolve-2',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'read',
      target,
      accounts: [],
    });
    const response = await phone.waitFor(isResolveResponse);
    expect(response.result).toEqual({ outcome: 'none' });
  });

  it('AmbiguousAccountError on a read with two same-host candidates and no pin', async () => {
    const accountId = 'acct-resolve-ambiguous';
    node = buildNode({ nodeId: 'node-resolve-3', accountId });
    phone = await connectPhone(accountId);
    const first = githubAccount();
    const second = githubAccount({
      id: 'github:github.com:7654321',
      providerAccountId: '7654321',
      label: 'second-account',
      secretRef: 'connected-account-token:github:github.com:7654321',
    });

    phone.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-3',
      nodeId: 'node-resolve-3',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'read',
      target,
      accounts: [first, second],
    });
    const response = await phone.waitFor(isResolveResponse);
    expect(response.result.outcome).toBe('error');
    if (response.result.outcome === 'error') {
      expect(response.result.errorType).toBe('AmbiguousAccountError');
      expect(response.result.candidateAccountIds).toEqual([first.id, second.id]);
    }
  });

  it('AccountPinRequiredError on a write with no pin', async () => {
    const accountId = 'acct-resolve-required';
    node = buildNode({ nodeId: 'node-resolve-4', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-4',
      nodeId: 'node-resolve-4',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'write',
      target,
      accounts: [githubAccount()],
    });
    const response = await phone.waitFor(isResolveResponse);
    expect(response.result.outcome).toBe('error');
    if (response.result.outcome === 'error') {
      expect(response.result.errorType).toBe('AccountPinRequiredError');
    }
  });

  it('AccountHostMismatchError when the pinned account targets a different host', async () => {
    const accountId = 'acct-resolve-mismatch';
    const pinStore = new AccountPinStore({ stateDir: nodeStateDir });
    pinStore.setPin('/home/dev/proj', 'github', 'github:github.example.com:1234567');
    node = buildNode({ nodeId: 'node-resolve-5', accountId, accountPinStore: pinStore });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-5',
      nodeId: 'node-resolve-5',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'write',
      target,
      accounts: [
        githubAccount({ id: 'github:github.example.com:1234567', host: 'github.example.com' }),
      ],
    });
    const response = await phone.waitFor(isResolveResponse);
    expect(response.result.outcome).toBe('error');
    if (response.result.outcome === 'error') {
      expect(response.result.errorType).toBe('AccountHostMismatchError');
      expect(response.result.expectedHost).toBe('github.com');
      expect(response.result.actualHost).toBe('github.example.com');
    }
  });

  it('AccountPinDanglingError when the pinned account is no longer connected', async () => {
    const accountId = 'acct-resolve-dangling';
    const pinStore = new AccountPinStore({ stateDir: nodeStateDir });
    pinStore.setPin('/home/dev/proj', 'github', 'github:github.com:9999999');
    node = buildNode({ nodeId: 'node-resolve-6', accountId, accountPinStore: pinStore });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-6',
      nodeId: 'node-resolve-6',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'read',
      target,
      accounts: [githubAccount()],
    });
    const response = await phone.waitFor(isResolveResponse);
    expect(response.result.outcome).toBe('error');
    if (response.result.outcome === 'error') {
      expect(response.result.errorType).toBe('AccountPinDanglingError');
    }
  });

  it('AccountPinMalformedError when the stored pin does not parse as an account id', async () => {
    const accountId = 'acct-resolve-malformed';
    const pinStore = new AccountPinStore({ stateDir: nodeStateDir });
    pinStore.setPin('/home/dev/proj', 'github', 'not-a-valid-account-id');
    node = buildNode({ nodeId: 'node-resolve-7', accountId, accountPinStore: pinStore });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-resolve-7',
      nodeId: 'node-resolve-7',
      projectPath: '/home/dev/proj',
      capability: 'github',
      mode: 'read',
      target,
      accounts: [githubAccount()],
    });
    const response = await phone.waitFor(isResolveResponse);
    expect(response.result.outcome).toBe('error');
    if (response.result.outcome === 'error') {
      expect(response.result.errorType).toBe('AccountPinMalformedError');
    }
  });
});

describe('account_pin_scan_request / _response (SPEC §7.26 pre-disconnect scan-and-warn, issue #229)', () => {
  it('affected is [] for an account nothing is pinned to', async () => {
    const accountId = 'acct-scan-empty';
    node = buildNode({ nodeId: 'node-scan-1', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'account_pin_scan_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-scan-1',
      nodeId: 'node-scan-1',
      accountId: 'github:github.com:9999999',
    });
    const response = await phone.waitFor(isScanResponse);
    expect(response.affected).toEqual([]);
  });

  it('names every real project/capability still pinned to the target account, across a store with several mixed pins', async () => {
    const accountId = 'acct-scan-named';
    const targetAccountId = 'github:github.com:1234567';
    const pinStore = new AccountPinStore({ stateDir: nodeStateDir });
    pinStore.setPin('/home/dev/loombox', 'github', targetAccountId);
    pinStore.setPin('/home/dev/side-project', 'github', targetAccountId);
    pinStore.setPin('/home/dev/other-repo', 'github', 'github:github.com:7654321');
    pinStore.setPin('/home/dev/loombox', 'jira', 'jira:myteam.atlassian.net:5b10ac8d');
    pinStore.setPin('/home/dev/opted-out', 'github', null);
    node = buildNode({ nodeId: 'node-scan-2', accountId, accountPinStore: pinStore });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'account_pin_scan_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-scan-2',
      nodeId: 'node-scan-2',
      accountId: targetAccountId,
    });
    const response = await phone.waitFor(isScanResponse);
    expect(response.affected).toEqual([
      { projectPath: '/home/dev/loombox', capability: 'github' },
      { projectPath: '/home/dev/side-project', capability: 'github' },
    ]);
  });

  it('a pin found by the scan is left dangling (not cleared) after disconnect, and the next resolve through it fails honestly instead of falling back to a different account', async () => {
    const accountId = 'acct-scan-then-disconnect';
    const projectPath = '/home/dev/loombox';
    const githubService = new GithubConnectService({
      stateDir: nodeStateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    const account = await githubService.connect({
      clientId: 'client-id',
      fetchImpl: stubGithubFetch(),
      sleep: async () => {},
    });
    const pinStore = new AccountPinStore({ stateDir: nodeStateDir });
    pinStore.setPin(projectPath, 'github', account.id);
    node = buildNode({
      nodeId: 'node-scan-3',
      accountId,
      githubConnectService: githubService,
      accountPinStore: pinStore,
    });
    phone = await connectPhone(accountId);
    const p = phone;

    // Before disconnect: the scan names this exact project/capability —
    // this is what a real confirm dialog would show the operator.
    p.send({
      type: 'account_pin_scan_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-scan-3a',
      nodeId: 'node-scan-3',
      accountId: account.id,
    });
    const preScan = await p.waitFor(isScanResponse);
    expect(preScan.affected).toEqual([{ projectPath, capability: 'github' }]);

    // Disconnect the account the operator was warned about.
    p.send({
      type: 'connected_account_disconnect_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-scan-3b',
      nodeId: 'node-scan-3',
      accountId: account.id,
    });
    const disconnectResponse = await p.waitFor(isDisconnectResponse);
    expect(disconnectResponse.outcome).toBe('ok');

    // The pin itself is untouched (orphaned, not cleared or blocked) — a
    // rescan still names the same project/capability, so the operator can
    // find and fix it.
    p.send({
      type: 'account_pin_scan_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-scan-3c',
      nodeId: 'node-scan-3',
      accountId: account.id,
    });
    await p.waitFor(() => p.messages.filter(isScanResponse).length >= 2);
    expect(p.messages.filter(isScanResponse)[1]?.affected).toEqual([
      { projectPath, capability: 'github' },
    ]);

    // A resolve that used to go through the now-disconnected account fails
    // honestly — `accounts` here is the client's own post-disconnect
    // `connected_account_list` snapshot, which no longer includes it —
    // never a silent fallback to some other connected account.
    p.send({
      type: 'account_pin_resolve_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-scan-3d',
      nodeId: 'node-scan-3',
      projectPath,
      capability: 'github',
      mode: 'write',
      target: { provider: 'github', host: 'github.com' },
      accounts: [],
    });
    const resolveResponse = await p.waitFor(isResolveResponse);
    expect(resolveResponse.result.outcome).toBe('error');
    if (resolveResponse.result.outcome === 'error') {
      expect(resolveResponse.result.errorType).toBe('AccountPinDanglingError');
      expect(resolveResponse.result.pinnedAccountId).toBe(account.id);
      expect(resolveResponse.result.capability).toBe('github');
    }
  });
});
