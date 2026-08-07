// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isMacLocalNodeProvisioningAvailable,
  provisionMacLocalNode,
  type ProvisionLocalNodeOutcome,
} from './local-node-provision';

afterEach(() => {
  delete (window as { loombox?: unknown }).loombox;
});

function outcome(overrides: Partial<ProvisionLocalNodeOutcome> = {}): ProvisionLocalNodeOutcome {
  return {
    ok: true,
    progress: [{ step: 'resident_node_install', status: 'ok', message: 'running' }],
    deviceId: 'mac_device',
    nodeId: 'mac_node',
    ...overrides,
  };
}

describe('isMacLocalNodeProvisioningAvailable (issue #654)', () => {
  it('is false in a plain browser tab, with no window.loombox at all', () => {
    expect(isMacLocalNodeProvisioningAvailable()).toBe(false);
  });

  it('is false when window.loombox exists but has no provisionLocalNode method — a stale/partial bridge is exactly as unusable as none', () => {
    (window as { loombox?: unknown }).loombox = { listSshHostCandidates: vi.fn() };
    expect(isMacLocalNodeProvisioningAvailable()).toBe(false);
  });

  it('is true once window.loombox exposes a real provisionLocalNode function', () => {
    (window as { loombox?: unknown }).loombox = { provisionLocalNode: vi.fn() };
    expect(isMacLocalNodeProvisioningAvailable()).toBe(true);
  });
});

describe('provisionMacLocalNode (issue #654)', () => {
  it('rejects with a clear message when there is no desktop bridge in scope, rather than throwing a confusing "not a function"', async () => {
    await expect(
      provisionMacLocalNode({
        relayUrl: 'wss://relay.example',
        accountId: 'acct_1',
        actingAuthToken: 'token_1',
        amk: new Uint8Array(32),
      }),
    ).rejects.toThrow(/desktop app/i);
  });

  it('calls the bridge with a freshly generated nodeId, the base64-encoded AMK, and every field passed straight through', async () => {
    const provisionLocalNode = vi.fn().mockResolvedValue(outcome());
    (window as { loombox?: unknown }).loombox = { provisionLocalNode };

    const amk = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await provisionMacLocalNode({
      relayUrl: 'wss://relay.example',
      accountId: 'acct_1',
      actingAuthToken: 'token_1',
      amk,
      claudeCodeOAuthToken: 'oauth_1',
    });

    expect(provisionLocalNode).toHaveBeenCalledTimes(1);
    const request = provisionLocalNode.mock.calls[0][0] as {
      relayUrl: string;
      accountId: string;
      actingAuthToken: string;
      amkBase64: string;
      nodeId: string;
      tokenLabel: string;
      claudeCodeOAuthToken: string;
    };
    expect(request.relayUrl).toBe('wss://relay.example');
    expect(request.accountId).toBe('acct_1');
    expect(request.actingAuthToken).toBe('token_1');
    expect(request.claudeCodeOAuthToken).toBe('oauth_1');
    // `Uint8Array` -> base64 round trip, `Buffer`-free (`atob` mirrors the
    // module's own `btoa`-based `bytesToBase64`).
    const decoded = Uint8Array.from(atob(request.amkBase64), (char) => char.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(amk));
    expect(request.nodeId).toMatch(/^mac_/);
    expect(request.tokenLabel).toBe(`loombox node: ${request.nodeId}`);
    expect(result).toEqual(outcome());
  });

  it('generates a different nodeId on every call, never reusing one across two separate provisioning attempts', async () => {
    const provisionLocalNode = vi.fn().mockResolvedValue(outcome());
    (window as { loombox?: unknown }).loombox = { provisionLocalNode };

    await provisionMacLocalNode({
      relayUrl: 'wss://relay.example',
      accountId: 'acct_1',
      actingAuthToken: 'token_1',
      amk: new Uint8Array(32),
    });
    await provisionMacLocalNode({
      relayUrl: 'wss://relay.example',
      accountId: 'acct_1',
      actingAuthToken: 'token_1',
      amk: new Uint8Array(32),
    });

    const firstNodeId = provisionLocalNode.mock.calls[0][0].nodeId as string;
    const secondNodeId = provisionLocalNode.mock.calls[1][0].nodeId as string;
    expect(firstNodeId).not.toBe(secondNodeId);
  });

  it('propagates a failed outcome from the bridge unchanged, rather than throwing', async () => {
    const failed = outcome({ ok: false, failedStep: 'mint_node_token' });
    const provisionLocalNode = vi.fn().mockResolvedValue(failed);
    (window as { loombox?: unknown }).loombox = { provisionLocalNode };

    const result = await provisionMacLocalNode({
      relayUrl: 'wss://relay.example',
      accountId: 'acct_1',
      actingAuthToken: 'token_1',
      amk: new Uint8Array(32),
    });

    expect(result).toEqual(failed);
  });
});
