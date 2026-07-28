import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAmk } from '@loombox/crypto';
import { PROTOCOL_V1, type TargetList, type WireMessageV1 } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { createNode, type NodeDaemon } from './node-daemon';
import type { ProviderAvailabilityCandidate } from './provider-availability';
import { FakeTransport } from './ssh/fake-transport';

/**
 * A bare client speaking just enough of the v1 handshake to send
 * `target_list_request` and read back `target_list` — duplicated from
 * `node-daemon-target-health.test.ts`'s identical helper rather than
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

/** Waits until `node` has completed the relay handshake at least once — mirrors `node-daemon.test.ts`'s identical helper. */
function waitForConnected(node: NodeDaemon): Promise<void> {
  return new Promise((resolve) => node.once('connected', resolve));
}

const CANDIDATES: ProviderAvailabilityCandidate[] = [
  { id: 'claude', requiredCommand: 'claude' },
  { id: 'codex', requiredCommand: 'codex' },
];

let relay: StartedRelay;
let node: NodeDaemon | undefined;
let client: TargetListClient | undefined;
let nodeStateDir: string;

beforeEach(async () => {
  relay = await startRelay();
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-target-providers-state-'));
});

afterEach(async () => {
  node?.close();
  client?.close();
  node = undefined;
  client = undefined;
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon target_announce providers (SPEC §5.5)', () => {
  it('a local target with no providerCandidates configured announces providers: [] (threaded through, not omitted)', async () => {
    const accountId = 'acct-providers-local-default';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-providers-local',
      deviceId: 'device-providers-local',
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
    expect(local).toHaveProperty('providers');
    expect(local?.providers).toEqual([]);
  });

  it('with no providerCandidates configured, an ssh: target is never even connected for probing purposes (nothing to check for, so no connection nobody opted into)', async () => {
    const accountId = 'acct-providers-no-candidates-ssh';
    let transportsBuilt = 0;

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-providers-no-candidates',
      deviceId: 'device-providers-no-candidates',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      targets: [{ id: 'ssh:untouched', kind: 'ssh', label: 'untouched', providers: [] }],
      sshTargets: [{ id: 'ssh:untouched', label: 'untouched', host: '10.0.0.9' }],
      sshTransportFactory: () => {
        transportsBuilt += 1;
        return new FakeTransport();
      },
      // No `providerCandidates` configured — nothing to check for.
    });

    await waitForConnected(node);

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;
    const list = await client.waitForTargets((l) =>
      l.targets.some((t) => t.targetId === 'ssh:untouched'),
    );
    expect(list.targets.find((t) => t.targetId === 'ssh:untouched')?.providers).toEqual([]);
    expect(transportsBuilt).toBe(0);
  });

  it("an ssh: target's announced providers come from its own remote probe over the already-pooled transport, not the local machine's PATH", async () => {
    const accountId = 'acct-providers-ssh';
    let capturedCommand = '';
    const transport = new FakeTransport({
      onExec: (command) => {
        capturedCommand = command;
        // The remote "has" only codex — deliberately the opposite of what
        // this test's own devbox PATH would report for `claude`, proving
        // the result isn't shortcut to a local answer.
        return { stdout: 'codex\n', stderr: '', exitCode: 0 };
      },
    });

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-providers-ssh',
      deviceId: 'device-providers-ssh',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'devbox', providers: [] }],
      sshTargets: [{ id: 'ssh:devbox', label: 'devbox', host: '10.0.0.5' }],
      sshTransportFactory: () => transport,
      providerCandidates: CANDIDATES,
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets(
      (l) => (l.targets.find((t) => t.targetId === 'ssh:devbox')?.providers.length ?? 0) > 0,
    );
    const devbox = list.targets.find((t) => t.targetId === 'ssh:devbox');
    expect(devbox?.providers).toEqual(['codex']);
    // The single-exec-call script really did name every candidate, not a
    // hardcoded guess.
    expect(capturedCommand).toContain('claude');
    expect(capturedCommand).toContain('codex');
  });

  it('never throws when an ssh: target is unreachable — it announces providers: [] and the node stays connected', async () => {
    const accountId = 'acct-providers-unreachable';
    const transport = new FakeTransport({ connectError: new Error('ECONNREFUSED') });

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-providers-unreachable',
      deviceId: 'device-providers-unreachable',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      targets: [{ id: 'ssh:flaky', kind: 'ssh', label: 'flaky', providers: [] }],
      sshTargets: [{ id: 'ssh:flaky', label: 'flaky', host: '10.0.0.9' }],
      sshTransportFactory: () => transport,
      providerCandidates: CANDIDATES,
    });

    await waitForConnected(node);
    expect(node.isConnected).toBe(true);

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const list = await client.waitForTargets((l) =>
      l.targets.some((t) => t.targetId === 'ssh:flaky'),
    );
    const flaky = list.targets.find((t) => t.targetId === 'ssh:flaky');
    expect(flaky?.providers).toEqual([]);
    expect(node.isConnected).toBe(true);
  });

  it('re-probes and refreshes the announced providers on reconnect, not merely once at startup (cache per target)', async () => {
    const accountId = 'acct-providers-reconnect';
    let remoteHasCodex = false;
    const transport = new FakeTransport({
      onExec: () => ({
        stdout: remoteHasCodex ? 'codex\n' : '',
        stderr: '',
        exitCode: remoteHasCodex ? 0 : 1,
      }),
    });

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-providers-reconnect',
      deviceId: 'device-providers-reconnect',
      devicePublicKey: 'YWJjZA==',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'devbox', providers: [] }],
      sshTargets: [{ id: 'ssh:devbox', label: 'devbox', host: '10.0.0.5' }],
      sshTransportFactory: () => transport,
      providerCandidates: CANDIDATES,
      reconnect: { initialBackoffMs: 20, maxBackoffMs: 200 },
      // Resource sampling stays off (its default): the only thing in this
      // test that can possibly notice "codex" appearing is the reconnect
      // probe, never a sampler tick — pins issue's "not on the hot
      // resource-sample interval" requirement.
    });

    client = new TargetListClient(relay.url, { accountId });
    await client.ready;

    const before = await client.waitForTargets((l) =>
      l.targets.some((t) => t.targetId === 'ssh:devbox'),
    );
    expect(before.targets.find((t) => t.targetId === 'ssh:devbox')?.providers).toEqual([]);

    // "codex" gets installed on the remote host, then the connection drops
    // and comes back.
    remoteHasCodex = true;
    const connectedAgain = new Promise<void>((resolve) => node!.once('connected', resolve));
    node.simulateRelayDrop();
    await connectedAgain;

    const after = await client.waitForTargets(
      (l) => (l.targets.find((t) => t.targetId === 'ssh:devbox')?.providers.length ?? 0) > 0,
    );
    expect(after.targets.find((t) => t.targetId === 'ssh:devbox')?.providers).toEqual(['codex']);
  });
});
