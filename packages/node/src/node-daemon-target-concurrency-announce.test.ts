import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAmk } from '@loombox/crypto';
import { PROTOCOL_V1, type TargetList, type WireMessageV1 } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { createNode, type NodeDaemon } from './node-daemon';
import { FakeTransport } from './ssh/fake-transport';

/**
 * A bare client speaking just enough of the v1 handshake to send
 * `target_list_request` and read back `target_list` — duplicated from
 * `node-daemon-target-providers.test.ts`'s identical helper rather than
 * shared, so this file stays a single self-contained test-only unit
 * (matches this package's own per-file `TestPhone` convention).
 */
class TargetListClient {
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;
  private latest: TargetList | undefined;

  constructor(url: string, opts: { accountId: string }) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({
            type: 'initialize',
            protocolVersion: PROTOCOL_V1,
            role: 'client',
            authToken: opts.accountId,
            deviceId: `device-${opts.accountId}`,
            devicePublicKey: 'YWJjZA==',
          }),
        );
      });
      this.socket.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data)) as WireMessageV1;
        if (!settled && parsed.type === 'initialize_result') {
          settled = true;
          resolve();
          return;
        }
        if (parsed.type === 'target_list') this.latest = parsed;
      });
      this.socket.addEventListener('error', () => {
        if (!settled) reject(new Error(`TargetListClient: cannot reach ${url}`));
      });
    });
  }

  requestTargets(): void {
    this.socket.send(
      JSON.stringify({
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: `req-${Date.now()}-${Math.random()}`,
      }),
    );
  }

  /** Polls `target_list_request`/`target_list` until `predicate` matches, or times out. */
  async waitForTargets(
    predicate: (list: TargetList) => boolean,
    timeoutMs = 10000,
  ): Promise<TargetList> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.requestTargets();
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.latest && predicate(this.latest)) return this.latest;
      if (Date.now() > deadline) {
        throw new Error('TargetListClient: timed out waiting for a matching target_list');
      }
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
let node: NodeDaemon | undefined;
let client: TargetListClient | undefined;
let nodeStateDir: string;

beforeEach(async () => {
  relay = await startRelay();
  nodeStateDir = await mkdtemp(
    path.join(tmpdir(), 'loombox-node-daemon-target-concurrency-announce-state-'),
  );
});

afterEach(async () => {
  node?.close();
  client?.close();
  node = undefined;
  client = undefined;
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon target_announce concurrency cap (SPEC §7.16, issue #255)', () => {
  it("announces local's cap as 'default' (this host's own CPU core count) when LOOMBOX_LOCAL_MAX_CONCURRENT_SESSIONS/localMaxConcurrentSessions is unset", async () => {
    const accountId = 'acct-concurrency-local-default';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-concurrency-local-default',
      deviceId: 'device-concurrency-local-default',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets((l) => l.targets.some((t) => t.targetId === 'local'));
    const local = list.targets.find((t) => t.targetId === 'local');
    expect(local?.maxConcurrentSessions).toBeGreaterThan(0);
    expect(local?.maxConcurrentSessionsSource).toBe('default');
  });

  it("announces local's cap as 'configured' once localMaxConcurrentSessions is set, with the exact configured number", async () => {
    const accountId = 'acct-concurrency-local-configured';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-concurrency-local-configured',
      deviceId: 'device-concurrency-local-configured',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      localMaxConcurrentSessions: 7,
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets((l) => l.targets.some((t) => t.targetId === 'local'));
    const local = list.targets.find((t) => t.targetId === 'local');
    expect(local?.maxConcurrentSessions).toBe(7);
    expect(local?.maxConcurrentSessionsSource).toBe('configured');
  });

  it("announces an ssh: target's cap as 'default' (the conservative fallback) when its SshTargetConfig.maxConcurrentSessions is unset", async () => {
    const accountId = 'acct-concurrency-ssh-default';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-concurrency-ssh-default',
      deviceId: 'device-concurrency-ssh-default',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'devbox', providers: [] }],
      sshTargets: [{ id: 'ssh:devbox', label: 'devbox', host: '10.0.0.5' }],
      sshTransportFactory: () => new FakeTransport(),
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets((l) =>
      l.targets.some((t) => t.targetId === 'ssh:devbox'),
    );
    const target = list.targets.find((t) => t.targetId === 'ssh:devbox');
    expect(target?.maxConcurrentSessions).toBe(2);
    expect(target?.maxConcurrentSessionsSource).toBe('default');
  });

  it("announces an ssh: target's cap as 'configured' once its own SshTargetConfig.maxConcurrentSessions is set", async () => {
    const accountId = 'acct-concurrency-ssh-configured';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-concurrency-ssh-configured',
      deviceId: 'device-concurrency-ssh-configured',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'devbox', providers: [] }],
      sshTargets: [{ id: 'ssh:devbox', label: 'devbox', host: '10.0.0.5', maxConcurrentSessions: 3 }],
      sshTransportFactory: () => new FakeTransport(),
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets((l) =>
      l.targets.some((t) => t.targetId === 'ssh:devbox'),
    );
    const target = list.targets.find((t) => t.targetId === 'ssh:devbox');
    expect(target?.maxConcurrentSessions).toBe(3);
    expect(target?.maxConcurrentSessionsSource).toBe('configured');
  });
});
