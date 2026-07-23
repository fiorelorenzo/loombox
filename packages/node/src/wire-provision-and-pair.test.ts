import { describe, expect, it, vi } from 'vitest';
import { generateEcdhKeyPair, exportPublicKeyRaw } from '@loombox/crypto';
import { PROTOCOL_V1, type ProvisionTargetRequest } from '@loombox/protocol';

import { NodeDaemon } from './node-daemon';
import type { ProvisionAndPairOptions, ProvisionAndPairResult } from './ssh/provision-and-pair';
import { resolveTargetConfig, wireProvisionAndPair } from './wire-provision-and-pair';

/** A bare, never-connected `NodeDaemon` (mirrors `amk-epoch.test.ts`'s own helper) — safe to construct and `.emit()` on directly in a pure unit test. */
function bareDaemon(amk = new Uint8Array(32)): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-acting',
    deviceId: 'device-acting',
    devicePublicKey: 'YWJjZA==',
    authToken: 'acct-unit',
    accountId: 'acct-unit',
    amk,
  });
}

const REQUEST: ProvisionTargetRequest = {
  type: 'provision_target_request',
  protocolVersion: PROTOCOL_V1,
  requestId: 'req-1',
  nodeId: 'node-acting',
  targetId: 'ssh:devbox',
  host: { host: '10.0.0.5', user: 'loombox' },
};

async function actingIdentity() {
  const keyPair = await generateEcdhKeyPair();
  const publicKeyRaw = await exportPublicKeyRaw(keyPair.publicKey);
  return { keyPair, publicKeyRaw };
}

describe('resolveTargetConfig', () => {
  it('builds a manual SshTargetConfig straight from the host input when no alias is given', () => {
    const config = resolveTargetConfig('ssh:devbox', { host: '10.0.0.5', user: 'loombox' }, []);
    expect(config).toEqual({
      id: 'ssh:devbox',
      label: '10.0.0.5',
      host: '10.0.0.5',
      user: 'loombox',
      port: undefined,
      privateKeyPath: undefined,
    });
  });

  it("fills in an autodetected ~/.ssh/config candidate's fields when alias matches", () => {
    const candidates = [
      {
        alias: 'devbox',
        hostName: 'devbox.internal',
        user: 'ops',
        port: 2222,
        identityFiles: ['/home/x/.ssh/id_ed25519'],
      },
    ];
    const config = resolveTargetConfig('ssh:devbox', { host: '', alias: 'devbox' }, candidates);
    expect(config).toEqual({
      id: 'ssh:devbox',
      label: 'devbox',
      host: 'devbox.internal',
      user: 'ops',
      port: 2222,
      privateKeyPath: '/home/x/.ssh/id_ed25519',
    });
  });

  it("lets an explicit host input field win over the matched candidate's own value", () => {
    const candidates = [
      { alias: 'devbox', hostName: 'devbox.internal', user: 'ops', port: 2222, identityFiles: [] },
    ];
    const config = resolveTargetConfig(
      'ssh:devbox',
      { host: '', alias: 'devbox', user: 'override-user' },
      candidates,
    );
    expect(config.user).toBe('override-user');
    expect(config.host).toBe('devbox.internal');
  });
});

describe('wireProvisionAndPair (#408)', () => {
  it("resolves the host, runs provisionAndPair with this node's own AMK/epoch/identity, and streams progress + a success result", async () => {
    const node = bareDaemon(new Uint8Array([1, 2, 3]));
    const { keyPair, publicKeyRaw } = await actingIdentity();
    const sentProgress: unknown[] = [];
    const sentResults: unknown[] = [];
    vi.spyOn(node, 'sendProvisionProgress').mockImplementation((p) => {
      sentProgress.push(p);
    });
    vi.spyOn(node, 'sendProvisionResult').mockImplementation((r) => {
      sentResults.push(r);
    });

    let capturedOptions: ProvisionAndPairOptions | undefined;
    const provisionAndPairImpl = vi.fn(
      async (_target, opts: ProvisionAndPairOptions): Promise<ProvisionAndPairResult> => {
        capturedOptions = opts;
        opts.onProgress?.({ step: 'verify_and_persist', status: 'started', message: 'go' });
        return { ok: true, targetId: 'ssh:devbox', progress: [] };
      },
    );

    const unwire = wireProvisionAndPair(node, {
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-unit',
      authToken: 'acct-unit',
      actingIdentity: { keyPair, publicKeyRaw },
      supervisor: {
        artifactSource: { fetch: vi.fn() },
        targetVersion: '1.0.0',
        publicKey: new Uint8Array(),
      },
      discoverSshTargetsImpl: async () => ({
        candidates: [],
        agent: { available: false, identities: [] },
        requiresManualEntry: true,
      }),
      provisionAndPairImpl,
    });

    node.emit('provision_target_request', REQUEST);
    // Let the async listener's microtasks/promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provisionAndPairImpl).toHaveBeenCalledTimes(1);
    expect(capturedOptions?.relayUrl).toBe('wss://relay.loombox.dev');
    expect(capturedOptions?.accountId).toBe('acct-unit');
    expect(capturedOptions?.actingAuthToken).toBe('acct-unit');
    expect(Array.from(capturedOptions?.amk ?? [])).toEqual([1, 2, 3]);
    expect(capturedOptions?.amkEpoch).toBe(0);

    expect(sentProgress).toEqual([
      {
        requestId: 'req-1',
        nodeId: 'node-acting',
        targetId: 'ssh:devbox',
        step: 'verify_and_persist',
        status: 'started',
        message: 'go',
      },
    ]);
    expect(sentResults).toEqual([
      {
        requestId: 'req-1',
        nodeId: 'node-acting',
        targetId: 'ssh:devbox',
        ok: true,
        failedStep: undefined,
        message: '"ssh:devbox" provisioned and paired',
      },
    ]);

    unwire();
  });

  it('reports a failed provisionAndPair result rather than throwing', async () => {
    const node = bareDaemon();
    const { keyPair, publicKeyRaw } = await actingIdentity();
    const sentResults: unknown[] = [];
    vi.spyOn(node, 'sendProvisionProgress').mockImplementation(() => {});
    vi.spyOn(node, 'sendProvisionResult').mockImplementation((r) => {
      sentResults.push(r);
    });

    wireProvisionAndPair(node, {
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-unit',
      authToken: 'acct-unit',
      actingIdentity: { keyPair, publicKeyRaw },
      supervisor: {
        artifactSource: { fetch: vi.fn() },
        targetVersion: '1.0.0',
        publicKey: new Uint8Array(),
      },
      discoverSshTargetsImpl: async () => ({
        candidates: [],
        agent: { available: false, identities: [] },
        requiresManualEntry: true,
      }),
      provisionAndPairImpl: async () => ({
        ok: false,
        targetId: 'ssh:devbox',
        progress: [],
        failedStep: 'mint_node_token',
      }),
    });

    node.emit('provision_target_request', REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentResults).toEqual([
      {
        requestId: 'req-1',
        nodeId: 'node-acting',
        targetId: 'ssh:devbox',
        ok: false,
        failedStep: 'mint_node_token',
        message: 'provisioning "ssh:devbox" failed at mint_node_token',
      },
    ]);
  });

  it('catches a thrown error from provisionAndPair and reports it as a failed result, never crashing the node', async () => {
    const node = bareDaemon();
    const { keyPair, publicKeyRaw } = await actingIdentity();
    const sentResults: unknown[] = [];
    vi.spyOn(node, 'sendProvisionProgress').mockImplementation(() => {});
    vi.spyOn(node, 'sendProvisionResult').mockImplementation((r) => {
      sentResults.push(r);
    });

    wireProvisionAndPair(node, {
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-unit',
      authToken: 'acct-unit',
      actingIdentity: { keyPair, publicKeyRaw },
      supervisor: {
        artifactSource: { fetch: vi.fn() },
        targetVersion: '1.0.0',
        publicKey: new Uint8Array(),
      },
      discoverSshTargetsImpl: async () => {
        throw new Error('no ~/.ssh/config readable');
      },
    });

    node.emit('provision_target_request', REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentResults).toHaveLength(1);
    const [result] = sentResults as Array<{ ok: boolean; message: string }>;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no ~/.ssh/config readable');
  });

  it('ignores a duplicate request for a requestId already in flight', async () => {
    const node = bareDaemon();
    const { keyPair, publicKeyRaw } = await actingIdentity();
    vi.spyOn(node, 'sendProvisionProgress').mockImplementation(() => {});
    vi.spyOn(node, 'sendProvisionResult').mockImplementation(() => {});

    let resolveFirst: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const provisionAndPairImpl = vi.fn(async (): Promise<ProvisionAndPairResult> => {
      resolveFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, targetId: 'ssh:devbox', progress: [] };
    });

    wireProvisionAndPair(node, {
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-unit',
      authToken: 'acct-unit',
      actingIdentity: { keyPair, publicKeyRaw },
      supervisor: {
        artifactSource: { fetch: vi.fn() },
        targetVersion: '1.0.0',
        publicKey: new Uint8Array(),
      },
      discoverSshTargetsImpl: async () => ({
        candidates: [],
        agent: { available: false, identities: [] },
        requiresManualEntry: true,
      }),
      provisionAndPairImpl,
    });

    node.emit('provision_target_request', REQUEST);
    await started;
    node.emit('provision_target_request', REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(provisionAndPairImpl).toHaveBeenCalledTimes(1);
  });
});
