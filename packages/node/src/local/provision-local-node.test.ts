import { generateAmk, unpackAmkHandoffFromFile, unwrapAmkForNodeHandoff } from '@loombox/crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeIdentityStore, type NodeIdentityStoreOptions } from '../identity';
import { FakeTransport } from '../ssh/fake-transport';
import { LocalProcessTransport } from '../ssh/local-process-transport';
import type { MintNodeTokenOptions, MintNodeTokenResult } from '../ssh/mint-node-token';
import { DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME } from '../ssh/amk-handoff-provision';
import type {
  SupervisorBackend,
  SupervisorBackendInstallConfig,
  SupervisorBackendInstallResult,
} from '../supervisor-backend';
import { provisionLocalNode } from './provision-local-node';

/** Forces the deterministic 0600-file fallback (issue #118), independent of this devbox's real keyring session — same convention `identity.test.ts` uses. */
const noOsKeyring: NodeIdentityStoreOptions['osKeyringBackendFactory'] = async () => undefined;

function fakeBackend(
  installResult: SupervisorBackendInstallResult = {
    ok: true,
    action: 'install',
    message: 'installed',
  },
): SupervisorBackend & { installCalls: SupervisorBackendInstallConfig[] } {
  const installCalls: SupervisorBackendInstallConfig[] = [];
  return {
    installCalls,
    async install(config) {
      installCalls.push(config);
      return installResult;
    },
    async start() {
      return { ok: true, message: 'started' };
    },
    async stop() {
      return { ok: true, message: 'stopped' };
    },
    async status() {
      return { installed: true, state: 'running', message: 'running' };
    },
    async uninstall() {
      return { ok: true, message: 'uninstalled' };
    },
    async survivesReboot() {
      return true;
    },
  };
}

describe('provisionLocalNode (issue #654)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'loombox-provision-local-node-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('runs every step in order, installs via the injected backend, and reports ok', async () => {
    const backend = fakeBackend();
    const amk = generateAmk();
    const mintCalls: MintNodeTokenOptions[] = [];
    const mintNodeToken = async (opts: MintNodeTokenOptions): Promise<MintNodeTokenResult> => {
      mintCalls.push(opts);
      return { id: 'tok-id', token: 'minted-token-123' };
    };

    const result = await provisionLocalNode({
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-1',
      actingAuthToken: 'session-token',
      amk,
      nodeId: 'mac-local-1',
      version: '1.0.0',
      fetchArchive: async () => new Uint8Array(),
      backend,
      runtime: { skip: true },
      stateDir,
      transport: new LocalProcessTransport(),
      identityStore: new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring }),
      mintNodeToken,
    });

    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe('mac-local-1');
    expect(result.nodeId).toBe('mac-local-1');
    expect(result.progress.map((p) => `${p.step}:${p.status}`)).toEqual([
      'runtime_bootstrap:started',
      'runtime_bootstrap:ok',
      'target_identity:started',
      'target_identity:ok',
      'mint_node_token:started',
      'mint_node_token:ok',
      'amk_handoff:started',
      'amk_handoff:ok',
      'resident_node_install:started',
      'resident_node_install:ok',
    ]);

    expect(mintCalls).toEqual([
      {
        relayUrl: 'wss://relay.loombox.dev',
        authToken: 'session-token',
        label: 'loombox node: mac-local-1',
      },
    ]);

    expect(backend.installCalls).toHaveLength(1);
    const installed = backend.installCalls[0];
    expect(installed?.version).toBe('1.0.0');
    expect(installed?.environment.LOOMBOX_RELAY_URL).toBe('wss://relay.loombox.dev');
    expect(installed?.environment.LOOMBOX_NODE_ID).toBe('mac-local-1');
    expect(installed?.environment.LOOMBOX_DEVICE_ID).toBe('mac-local-1');
    expect(installed?.environment.LOOMBOX_DEVICE_TOKEN).toBe('minted-token-123');
    expect(installed?.environment.LOOMBOX_ACCOUNT_ID).toBe('acct-1');
    expect(installed?.environment.LOOMBOX_WRAPPED_AMK_FILE).toBe(
      join(stateDir, DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME).replace(/\\/g, '/'),
    );
    expect(installed?.nodeExecutable.length).toBeGreaterThan(0);

    // The one-shot handoff file genuinely round-trips back to the same AMK
    // via this device's own just-generated identity — not merely "a file
    // exists", but that the C1-2 handoff actually works end to end.
    const handoffRaw = await readFile(join(stateDir, DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME), 'utf8');
    const unpacked = unpackAmkHandoffFromFile(handoffRaw);
    const identity = await new NodeIdentityStore({
      stateDir,
      osKeyringBackendFactory: noOsKeyring,
    }).load();
    expect(identity).toBeDefined();
    const unwrapped = await unwrapAmkForNodeHandoff({
      envelope: unpacked.envelope,
      epoch: unpacked.epoch,
      accountId: 'acct-1',
      targetDeviceId: 'mac-local-1',
      targetPrivateKey: identity!.keyPair.privateKey,
      actingDevicePublicKeyRaw: unpacked.actingDevicePublicKeyRaw,
    });
    expect(Buffer.from(unwrapped)).toEqual(Buffer.from(amk));
  });

  it('applies a collision-free nodeId/deviceId when environment is preview, leaving production untouched (issue #867)', async () => {
    const backend = fakeBackend();
    const mintNodeToken = async (): Promise<MintNodeTokenResult> => ({
      id: 'tok-id',
      token: 'minted-token-preview',
    });

    const result = await provisionLocalNode({
      relayUrl: 'wss://preview-relay.loombox.dev',
      accountId: 'acct-1',
      actingAuthToken: 'session-token',
      amk: generateAmk(),
      nodeId: 'mac-local-1',
      environment: 'preview',
      version: '1.0.0',
      fetchArchive: async () => new Uint8Array(),
      backend,
      runtime: { skip: true },
      stateDir,
      transport: new LocalProcessTransport(),
      identityStore: new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring }),
      mintNodeToken,
    });

    expect(result.ok).toBe(true);
    // The exact "two rows both called devbox-node-1" collision issue #867
    // names — a caller that reuses the same nodeId for both environments
    // still gets a distinguishable id for the preview one.
    expect(result.nodeId).toBe('mac-local-1-preview');
    expect(result.deviceId).toBe('mac-local-1-preview');
    expect(backend.installCalls[0]?.environment.LOOMBOX_NODE_ID).toBe('mac-local-1-preview');
    expect(backend.installCalls[0]?.environment.LOOMBOX_DEVICE_ID).toBe('mac-local-1-preview');
  });

  it('stops at mint_node_token and never calls the backend when minting fails', async () => {
    const backend = fakeBackend();
    const result = await provisionLocalNode({
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-1',
      actingAuthToken: 'session-token',
      amk: generateAmk(),
      nodeId: 'mac-local-2',
      version: '1.0.0',
      fetchArchive: async () => new Uint8Array(),
      backend,
      runtime: { skip: true },
      stateDir,
      transport: new LocalProcessTransport(),
      identityStore: new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring }),
      mintNodeToken: async () => {
        throw new Error('relay unreachable');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('mint_node_token');
    expect(result.progress.map((p) => p.step)).toEqual([
      'runtime_bootstrap',
      'runtime_bootstrap',
      'target_identity',
      'target_identity',
      'mint_node_token',
      'mint_node_token',
    ]);
    expect(backend.installCalls).toHaveLength(0);
  });

  it('surfaces a failing backend.install() as a failed resident_node_install step', async () => {
    const backend = fakeBackend({
      ok: false,
      action: 'install',
      message: 'launchctl bootstrap failed',
    });
    const result = await provisionLocalNode({
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-1',
      actingAuthToken: 'session-token',
      amk: generateAmk(),
      nodeId: 'mac-local-3',
      version: '1.0.0',
      fetchArchive: async () => new Uint8Array(),
      backend,
      runtime: { skip: true },
      stateDir,
      transport: new LocalProcessTransport(),
      identityStore: new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring }),
      mintNodeToken: async () => ({ id: 'tok', token: 'tok-value' }),
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('resident_node_install');
    expect(result.progress.at(-1)).toEqual({
      step: 'resident_node_install',
      status: 'failed',
      message: 'launchctl bootstrap failed',
    });
  });

  it('reports a failed runtime_bootstrap step (never rejecting) when the transport fails to connect', async () => {
    const backend = fakeBackend();
    const connectError = new Error('spawn ENOENT');
    const result = await provisionLocalNode({
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-1',
      actingAuthToken: 'session-token',
      amk: generateAmk(),
      nodeId: 'mac-local-4',
      version: '1.0.0',
      fetchArchive: async () => new Uint8Array(),
      backend,
      stateDir,
      transport: new FakeTransport({ connectError }),
      identityStore: new NodeIdentityStore({ stateDir, osKeyringBackendFactory: noOsKeyring }),
      mintNodeToken: async () => ({ id: 'tok', token: 'tok-value' }),
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('runtime_bootstrap');
    expect(result.progress.at(-1)?.message).toContain('spawn ENOENT');
    expect(backend.installCalls).toHaveLength(0);
  });
});
