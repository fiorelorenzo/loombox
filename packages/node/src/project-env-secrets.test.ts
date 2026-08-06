import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectEnvVarMissingError, type ProjectEnvVarDecl } from '@loombox/providers-core';

import { NodeProjectEnvManager, type ProjectSecretValueSource } from './project-env-secrets';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-project-env-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const project = '/repo/a';

const withSecret: ProjectEnvVarDecl = { name: 'DB_PASSWORD', secret: 'db-password' };

/** A fake `ProjectSecretValueSource`, mirroring `NodeMcpSecretManager.getSecretValue`'s shape without pulling in the real keyring-backed store — this manager's own tests only need the structural interface, not real secrets-at-rest. */
function fakeSecretSource(values: Record<string, Record<string, string>> = {}): {
  source: ProjectSecretValueSource;
  set(projectPath: string, secretName: string, value: string): void;
} {
  const store = new Map(Object.entries(values).map(([p, v]) => [p, new Map(Object.entries(v))]));
  return {
    source: {
      getSecretValue: async (projectPath, secretName) => store.get(projectPath)?.get(secretName),
    },
    set(projectPath, secretName, value) {
      if (!store.has(projectPath)) store.set(projectPath, new Map());
      store.get(projectPath)!.set(secretName, value);
    },
  };
}

function manager(secrets: ProjectSecretValueSource): NodeProjectEnvManager {
  return new NodeProjectEnvManager({ stateDir, secrets });
}

describe('NodeProjectEnvManager grant ACL (issue #258)', () => {
  it('starts with no grants', () => {
    const { source } = fakeSecretSource();
    const mgr = manager(source);
    expect(mgr.isGranted(project, 'db-password')).toBe(false);
  });

  it('grant() is a distinct explicit action per (project, secret)', () => {
    const { source } = fakeSecretSource();
    const mgr = manager(source);
    mgr.grant(project, 'db-password');
    expect(mgr.isGranted(project, 'db-password')).toBe(true);
    expect(mgr.isGranted('/repo/b', 'db-password')).toBe(false);
  });

  it('revoke() removes only that grant, leaving others untouched', () => {
    const { source } = fakeSecretSource();
    const mgr = manager(source);
    mgr.grant(project, 'db-password');
    mgr.grant(project, 'api-key');
    mgr.revoke(project, 'db-password');
    expect(mgr.isGranted(project, 'db-password')).toBe(false);
    expect(mgr.isGranted(project, 'api-key')).toBe(true);
  });

  it('revoking a never-granted secret is a harmless no-op', () => {
    const { source } = fakeSecretSource();
    const mgr = manager(source);
    expect(() => mgr.revoke(project, 'never-granted')).not.toThrow();
  });

  it('grants persist across a fresh manager instance over the same stateDir', () => {
    const { source } = fakeSecretSource();
    manager(source).grant(project, 'db-password');
    expect(manager(source).isGranted(project, 'db-password')).toBe(true);
  });
});

describe('NodeProjectEnvManager.resolveForSession() (issue #258)', () => {
  it('resolves a granted, valued secret into the env the agent process gets', async () => {
    const { source, set } = fakeSecretSource();
    set(project, 'db-password', 'hunter2');
    const mgr = manager(source);
    mgr.grant(project, 'db-password');

    await expect(mgr.resolveForSession(project, [withSecret])).resolves.toEqual({
      DB_PASSWORD: 'hunter2',
    });
  });

  it('throws ProjectEnvVarMissingError when the secret has a value but was never granted', async () => {
    const { source, set } = fakeSecretSource();
    set(project, 'db-password', 'hunter2');
    const mgr = manager(source);

    await expect(mgr.resolveForSession(project, [withSecret])).rejects.toThrow(
      ProjectEnvVarMissingError,
    );
  });

  it('throws ProjectEnvVarMissingError when granted but no value is stored', async () => {
    const { source } = fakeSecretSource();
    const mgr = manager(source);
    mgr.grant(project, 'db-password');

    await expect(mgr.resolveForSession(project, [withSecret])).rejects.toThrow(
      ProjectEnvVarMissingError,
    );
  });

  it('a grant on one project never satisfies the same secret name on another', async () => {
    const { source, set } = fakeSecretSource();
    set('/repo/a', 'db-password', 'hunter2');
    const mgr = manager(source);
    mgr.grant('/repo/a', 'db-password');

    await expect(mgr.resolveForSession('/repo/b', [withSecret])).rejects.toThrow(
      ProjectEnvVarMissingError,
    );
  });

  it('resolves an empty decl list to an empty env with no grant or value lookup needed', async () => {
    const { source } = fakeSecretSource();
    await expect(manager(source).resolveForSession(project, [])).resolves.toEqual({});
  });

  it('never includes the resolved value in a thrown error message, even when a later decl fails after an earlier one resolved', async () => {
    const { source, set } = fakeSecretSource();
    set(project, 'db-password', 'hunter2');
    const mgr = manager(source);
    mgr.grant(project, 'db-password');

    const decls: ProjectEnvVarDecl[] = [withSecret, { name: 'API_KEY', secret: 'ungranted' }];
    try {
      await mgr.resolveForSession(project, decls);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectEnvVarMissingError);
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});
