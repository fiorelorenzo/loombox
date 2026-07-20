import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpServerSecretMissingError, type McpServerConfig } from '@loombox/providers-core';

import { NodeMcpSecretManager } from './mcp-secrets';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-mcp-secrets-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** Forces the deterministic 0600-file fallback (issue #118), matching this devbox's real keyring session (verified in `keyring.test.ts`) without depending on it. */
function manager(extra: Partial<ConstructorParameters<typeof NodeMcpSecretManager>[0]> = {}) {
  return new NodeMcpSecretManager({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
    ...extra,
  });
}

const project = '/repo/a';

const withSecretEnv: McpServerConfig = {
  name: 'github',
  transport: 'stdio',
  command: 'mcp-server-github',
  args: [],
  env: [{ name: 'GITHUB_TOKEN', secret: 'github-token' }],
};

const noSecrets: McpServerConfig = {
  name: 'fs',
  transport: 'stdio',
  command: 'mcp-server-fs',
  args: [],
  env: [],
};

describe('NodeMcpSecretManager', () => {
  describe('grant ACL', () => {
    it('starts with no grants', () => {
      const mgr = manager();
      expect(mgr.isGranted(project, 'github', 'github-token')).toBe(false);
    });

    it('grant() then isGranted() reflects it; revoke() removes it', () => {
      const mgr = manager();
      mgr.grant(project, 'github', 'github-token');
      expect(mgr.isGranted(project, 'github', 'github-token')).toBe(true);

      mgr.revoke(project, 'github', 'github-token');
      expect(mgr.isGranted(project, 'github', 'github-token')).toBe(false);
    });

    it('revoking one (server, secret) grant never affects another', () => {
      const mgr = manager();
      mgr.grant(project, 'github', 'github-token');
      mgr.grant(project, 'other-server', 'github-token');
      mgr.grant(project, 'github', 'other-secret');

      mgr.revoke(project, 'github', 'github-token');

      expect(mgr.isGranted(project, 'github', 'github-token')).toBe(false);
      expect(mgr.isGranted(project, 'other-server', 'github-token')).toBe(true);
      expect(mgr.isGranted(project, 'github', 'other-secret')).toBe(true);
    });

    it('grants are scoped per project', () => {
      const mgr = manager();
      mgr.grant('/repo/a', 'github', 'github-token');
      expect(mgr.isGranted('/repo/b', 'github', 'github-token')).toBe(false);
    });

    it('grants persist across a simulated restart (a fresh manager instance over the same stateDir)', () => {
      const first = manager();
      first.grant(project, 'github', 'github-token');

      const second = manager();
      expect(second.isGranted(project, 'github', 'github-token')).toBe(true);
    });

    it('revoke() on a grant that was never made is a no-op', () => {
      const mgr = manager();
      expect(() => mgr.revoke(project, 'github', 'github-token')).not.toThrow();
    });
  });

  describe('secret values', () => {
    it('has no value yet for a secret that was never set', async () => {
      const mgr = manager();
      await expect(mgr.getSecretValue(project, 'github-token')).resolves.toBeUndefined();
    });

    it('setSecretValue() then getSecretValue() round-trips', async () => {
      const mgr = manager();
      await mgr.setSecretValue(project, 'github-token', 'ghp_abc123');
      await expect(mgr.getSecretValue(project, 'github-token')).resolves.toBe('ghp_abc123');
    });

    it('secret values are scoped per project', async () => {
      const mgr = manager();
      await mgr.setSecretValue('/repo/a', 'github-token', 'value-a');
      await expect(mgr.getSecretValue('/repo/b', 'github-token')).resolves.toBeUndefined();
    });

    it('deleteSecretValue() removes it', async () => {
      const mgr = manager();
      await mgr.setSecretValue(project, 'github-token', 'ghp_abc123');
      await mgr.deleteSecretValue(project, 'github-token');
      await expect(mgr.getSecretValue(project, 'github-token')).resolves.toBeUndefined();
    });

    it('a secret value persists across a simulated restart', async () => {
      const first = manager();
      await first.setSecretValue(project, 'github-token', 'ghp_abc123');

      const second = manager();
      await expect(second.getSecretValue(project, 'github-token')).resolves.toBe('ghp_abc123');
    });

    it('the secret value never appears in the plain-text grants file', async () => {
      const mgr = manager();
      await mgr.setSecretValue(project, 'github-token', 'super-secret-value');
      mgr.grant(project, 'github', 'github-token');

      const { readFile } = await import('node:fs/promises');
      const grantsRaw = await readFile(path.join(stateDir, 'mcp-secret-grants.json'), 'utf8');
      expect(grantsRaw).not.toContain('super-secret-value');
    });
  });

  describe('resolveForSession() (issue #189)', () => {
    it('resolves a server with no secret declarations with no grants at all', async () => {
      const mgr = manager();
      const resolved = await mgr.resolveForSession(project, [noSecrets]);

      expect(resolved).toEqual([{ name: 'fs', command: 'mcp-server-fs', args: [], env: [] }]);
    });

    it('rejects an ungranted secret before returning anything (McpServerSecretMissingError)', async () => {
      const mgr = manager();
      await mgr.setSecretValue(project, 'github-token', 'ghp_abc123'); // value set, but never granted

      await expect(mgr.resolveForSession(project, [withSecretEnv])).rejects.toThrow(
        McpServerSecretMissingError,
      );
    });

    it('rejects a granted secret with no stored value', async () => {
      const mgr = manager();
      mgr.grant(project, 'github', 'github-token'); // granted, but no value stored

      await expect(mgr.resolveForSession(project, [withSecretEnv])).rejects.toThrow(
        McpServerSecretMissingError,
      );
    });

    it('resolves a granted secret with a stored value into the plain AcpMcpServerConfig shape', async () => {
      const mgr = manager();
      await mgr.setSecretValue(project, 'github-token', 'ghp_abc123');
      mgr.grant(project, 'github', 'github-token');

      const resolved = await mgr.resolveForSession(project, [withSecretEnv]);

      expect(resolved).toEqual([
        {
          name: 'github',
          command: 'mcp-server-github',
          args: [],
          env: [{ name: 'GITHUB_TOKEN', value: 'ghp_abc123' }],
        },
      ]);
    });

    it('a grant/value for one project never leaks into another project resolving the same server name', async () => {
      const mgr = manager();
      await mgr.setSecretValue('/repo/a', 'github-token', 'ghp_abc123');
      mgr.grant('/repo/a', 'github', 'github-token');

      await expect(mgr.resolveForSession('/repo/b', [withSecretEnv])).rejects.toThrow(
        McpServerSecretMissingError,
      );
    });
  });
});
