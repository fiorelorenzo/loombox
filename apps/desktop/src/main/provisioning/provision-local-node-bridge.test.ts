import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeTransport, NodeIdentityStore } from '@loombox/node';
import { describe, expect, it } from 'vitest';

import type { ProvisionLocalNodeRequest } from '../../shared/bridge';
import {
  resolveProvisionLocalNodeDeps,
  runProvisionLocalNode,
} from './provision-local-node-bridge';

const BASE_REQUEST: ProvisionLocalNodeRequest = {
  relayUrl: 'wss://relay.loombox.dev',
  accountId: 'acct-1',
  actingAuthToken: 'session-token',
  amkBase64: randomBytes(32).toString('base64'),
  nodeId: 'mac-local-1',
};

describe('resolveProvisionLocalNodeDeps (issue #654)', () => {
  it('resolves a real, working node-release source and a real launchd SupervisorBackend, no scaffold gap', async () => {
    const deps = await resolveProvisionLocalNodeDeps();

    expect(deps.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof deps.fetchArchive).toBe('function');
    expect(typeof deps.backend?.install).toBe('function');
    expect(typeof deps.backend?.uninstall).toBe('function');
  });

  it('honors an overridden releasesDir instead of the default ~/.loombox/releases', async () => {
    const releasesDir = await mkdtemp(join(tmpdir(), 'loombox-desktop-node-releases-'));
    try {
      const deps = await resolveProvisionLocalNodeDeps({ releasesDir });
      await expect(deps.fetchArchive('1.0.0')).rejects.toThrow(/no node build staged/);
    } finally {
      await rm(releasesDir, { recursive: true, force: true });
    }
  });
});

describe('runProvisionLocalNode (issue #654)', () => {
  it('genuinely delegates to @loombox/node provisionLocalNode() and returns a structured failure, never rejecting, when the transport cannot connect', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'loombox-desktop-local-node-bridge-'));
    try {
      const connectError = new Error('spawn ENOENT');
      const result = await runProvisionLocalNode(BASE_REQUEST, {
        version: '1.0.0',
        fetchArchive: async () => {
          throw new Error('fetchArchive should never be called: the transport never connects');
        },
        backend: {
          install: async () => {
            throw new Error('backend.install should never be called');
          },
          start: async () => ({ ok: false, message: 'unused' }),
          stop: async () => ({ ok: false, message: 'unused' }),
          status: async () => ({ installed: false, state: 'stopped', message: 'unused' }),
          uninstall: async () => ({ ok: false, message: 'unused' }),
          survivesReboot: async () => false,
        },
        transport: new FakeTransport({ connectError }),
        stateDir,
        identityStore: new NodeIdentityStore({
          stateDir,
          osKeyringBackendFactory: async () => undefined,
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe('runtime_bootstrap');
      expect(result.progress.at(-1)?.message).toContain('spawn ENOENT');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
