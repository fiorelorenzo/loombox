import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROTOCOL_V1, type TargetList, type WireMessageV1 } from '@loombox/protocol';
import { generateAmk } from '@loombox/crypto';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { createNode, type NodeDaemon } from './node-daemon';
import { FakeTransport } from './ssh/fake-transport';

/** A bare client speaking just enough of the v1 handshake to send `target_list_request` and read back `target_list` (issues #253/#269's status view is the eventual consumer of this same flow). */
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

  /** Polls `target_list_request`/`target_list` until `predicate` matches one of the returned entries, or times out. */
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

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  node?.close();
  client?.close();
  node = undefined;
  client = undefined;
  await relay.close();
});

describe('NodeDaemon resource-sampling wire integration (issues #253/#269)', () => {
  it('never reports a health reading when resourceSampling is left disabled (the default)', async () => {
    const accountId = 'acct-sampling-off';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-off',
      deviceId: 'device-node-off',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets((l) => l.targets.some((t) => t.targetId === 'local'));
    const local = list.targets.find((t) => t.targetId === 'local');
    expect(local?.reachable).toBe(true);
    expect(local?.health).toBeUndefined();
  });

  it('reports a healthy local-target reading once resourceSampling is enabled', async () => {
    const accountId = 'acct-sampling-local';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-local',
      deviceId: 'device-node-local',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      resourceSampling: { enabled: true, intervalMs: 200, timeoutMs: 2000 },
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets(
      (l) => l.targets.find((t) => t.targetId === 'local')?.health !== undefined,
    );
    const local = list.targets.find((t) => t.targetId === 'local');
    expect(local?.health?.healthy).toBe(true);
    expect(local?.health?.memTotalBytes).toBeGreaterThan(0);
    expect(local?.health?.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(local?.health?.cpuPercent).toBeLessThanOrEqual(100);
    expect(local?.health?.diskTotalBytes).toBeGreaterThan(0);
  });

  it('samples an ssh: target over its existing pooled transport (never a second connection) and reports it as healthy', async () => {
    const accountId = 'acct-sampling-ssh';
    const fakeTransport = new FakeTransport({
      onExec: () => ({
        stdout: [
          'NPROC=4',
          'LOAD=2',
          'MEMTOTAL=8000000000',
          'MEMFREE=2000000000',
          'DISK=100 40 60',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });
    let transportsBuilt = 0;

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-ssh',
      deviceId: 'device-node-ssh',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      targets: [
        { id: 'local', kind: 'local', label: 'This machine' },
        { id: 'ssh:devbox', kind: 'ssh', label: 'devbox' },
      ],
      sshTargets: [{ id: 'ssh:devbox', label: 'devbox', host: '10.0.0.5' }],
      sshTransportFactory: () => {
        transportsBuilt += 1;
        return fakeTransport;
      },
      resourceSampling: { enabled: true, intervalMs: 200, timeoutMs: 2000 },
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets(
      (l) => l.targets.find((t) => t.targetId === 'ssh:devbox')?.health !== undefined,
    );
    const sshTarget = list.targets.find((t) => t.targetId === 'ssh:devbox');
    expect(sshTarget?.health?.healthy).toBe(true);
    expect(sshTarget?.health?.cpuPercent).toBe(50);
    expect(sshTarget?.health?.memPercent).toBe(75);
    expect(sshTarget?.health?.diskPercent).toBe(40);
    // Sampling on an interval reuses the one pooled transport rather than
    // opening a fresh connection per tick (issue #253's "reuse
    // remote-runtime/transport").
    expect(transportsBuilt).toBe(1);
  });

  it('reports an ssh: target as unhealthy once its transport starts failing, without ever throwing out of the sampler', async () => {
    const accountId = 'acct-sampling-ssh-down';
    const failingTransport = new FakeTransport({
      onExec: () => {
        throw new Error('ECONNRESET');
      },
    });

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-ssh-down',
      deviceId: 'device-node-ssh-down',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      targets: [{ id: 'ssh:flaky', kind: 'ssh', label: 'flaky' }],
      sshTargets: [{ id: 'ssh:flaky', label: 'flaky', host: '10.0.0.9' }],
      sshTransportFactory: () => failingTransport,
      resourceSampling: { enabled: true, intervalMs: 200, timeoutMs: 2000 },
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets(
      (l) => l.targets.find((t) => t.targetId === 'ssh:flaky')?.health !== undefined,
    );
    const flaky = list.targets.find((t) => t.targetId === 'ssh:flaky');
    expect(flaky?.health?.healthy).toBe(false);
  });
});
