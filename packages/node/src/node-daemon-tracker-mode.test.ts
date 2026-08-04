import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrackerMode, TrackerModeResponse, WireMessageV1 } from '@loombox/protocol';
import { PROTOCOL_V1 } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import { generateAmk } from '@loombox/crypto';

import { TrackerModeStore } from './tracker-mode-store';
import { createNode, type NodeDaemon } from './node-daemon';

/**
 * `tracker_mode_get_request`/`tracker_mode_set_request` (SPEC §7.10; issue
 * #631) — mirrors `node-daemon-account-connect.test.ts`'s `TestPhone`
 * harness for `account_pin_get/set_request`: a plain-field message pair
 * needing neither a session bridge nor an encrypted envelope, exactly like
 * the account pin round trip this issue's own doc comment says these
 * messages were modeled on.
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

function isTrackerModeResponse(m: WireMessageV1): m is TrackerModeResponse {
  return m.type === 'tracker_mode_response';
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const githubMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'github:github.com:1111',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
} satisfies TrackerMode;

let relay: StartedRelay;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-tracker-mode-node-daemon-'));
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
  trackerModeStore?: TrackerModeStore;
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
    trackerModeStore: opts.trackerModeStore,
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

describe('tracker_mode_get/set_request round trip (SPEC §7.10, issue #631)', () => {
  it('a project with no saved mode gets back an undefined mode, never a native default', async () => {
    const accountId = 'acct-mode-none';
    node = buildNode({ nodeId: 'node-mode-1', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'tracker_mode_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-mode-get-1',
      nodeId: 'node-mode-1',
      projectPath: '/home/dev/proj',
    });
    const response = await phone.waitFor(isTrackerModeResponse);
    expect(response.mode).toBeUndefined();
  });

  it('a mode set through the wire is immediately visible through a get — one device sets, another reads (SPEC §7.10)', async () => {
    const accountId = 'acct-mode-roundtrip';
    node = buildNode({ nodeId: 'node-mode-2', accountId });
    const deviceA = await connectPhone(accountId);
    const deviceB = await connectPhone(accountId);

    deviceA.send({
      type: 'tracker_mode_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-mode-set-1',
      nodeId: 'node-mode-2',
      projectPath: '/home/dev/proj',
      mode: githubMode,
    });
    const setResponse = await deviceA.waitFor(isTrackerModeResponse);
    expect(setResponse.mode).toEqual(githubMode);

    deviceB.send({
      type: 'tracker_mode_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-mode-get-2',
      nodeId: 'node-mode-2',
      projectPath: '/home/dev/proj',
    });
    const getResponse = await deviceB.waitFor(isTrackerModeResponse);
    expect(getResponse.mode).toEqual(githubMode);

    deviceA.close();
    deviceB.close();
  });

  it('setting a mode replaces a previously saved one outright — there is no unset request', async () => {
    const accountId = 'acct-mode-replace';
    node = buildNode({ nodeId: 'node-mode-3', accountId });
    phone = await connectPhone(accountId);
    const p = phone;

    p.send({
      type: 'tracker_mode_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-mode-set-a',
      nodeId: 'node-mode-3',
      projectPath: '/home/dev/proj',
      mode: githubMode,
    });
    await p.waitFor(() => p.messages.filter(isTrackerModeResponse).length >= 1);

    p.send({
      type: 'tracker_mode_set_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-mode-set-b',
      nodeId: 'node-mode-3',
      projectPath: '/home/dev/proj',
      mode: { kind: 'native' },
    });
    await p.waitFor(() => p.messages.filter(isTrackerModeResponse).length >= 2);
    expect(p.messages.filter(isTrackerModeResponse)[1]?.mode).toEqual({ kind: 'native' });
  });

  it('a real, invalid on-disk mode reads back as absent through the wire, never as native (issue #631/#209)', async () => {
    const accountId = 'acct-mode-invalid';
    // Seeds the on-disk file directly with a value that would never pass
    // `TrackerMode`'s own validation — the same "hand-edited file"
    // scenario `tracker-mode-store.test.ts` covers directly, proven here
    // end to end through the real wire handler and the default,
    // node-constructed `TrackerModeStore({stateDir: nodeStateDir})`.
    await writeFile(
      path.join(nodeStateDir, 'tracker-modes.json'),
      JSON.stringify({ v: 1, projects: { '/home/dev/proj': { kind: 'not-a-real-kind' } } }),
    );
    node = buildNode({ nodeId: 'node-mode-4', accountId });
    phone = await connectPhone(accountId);

    phone.send({
      type: 'tracker_mode_get_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-mode-get-invalid',
      nodeId: 'node-mode-4',
      projectPath: '/home/dev/proj',
    });
    const response = await phone.waitFor(isTrackerModeResponse);
    expect(response.mode).toBeUndefined();
  });
});
