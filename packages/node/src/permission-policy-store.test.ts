import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_PERMISSION_POLICY, type PermissionPolicy } from './permission-policy';
import { PermissionPolicyError, PermissionPolicyStore } from './permission-policy-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-permission-policy-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const restrictive: PermissionPolicy = {
  command: { allow: [], deny: ['rm -rf *'] },
  network: { allow: [], deny: ['evil.example:*'] },
};

describe('PermissionPolicyStore', () => {
  it('get() returns EMPTY_PERMISSION_POLICY (allow-all) for an unconfigured project, against a fresh state dir', () => {
    const store = new PermissionPolicyStore({ stateDir });
    expect(store.get('/proj-a')).toEqual(EMPTY_PERMISSION_POLICY);
  });

  it('save() then get() round-trips a policy for exactly the saved project', () => {
    const store = new PermissionPolicyStore({ stateDir });
    store.save('/proj-a', restrictive);
    expect(store.get('/proj-a')).toEqual(restrictive);
    // A different, never-saved project is unaffected — still the default.
    expect(store.get('/proj-b')).toEqual(EMPTY_PERMISSION_POLICY);
  });

  it('save() replaces an existing policy wholesale', () => {
    const store = new PermissionPolicyStore({ stateDir });
    store.save('/proj-a', restrictive);
    const replacement: PermissionPolicy = {
      command: { allow: ['git *'], deny: [] },
      network: { allow: [], deny: [] },
    };
    store.save('/proj-a', replacement);
    expect(store.get('/proj-a')).toEqual(replacement);
  });

  it('remove() reverts a project to the default, and is a no-op for one with no saved policy', () => {
    const store = new PermissionPolicyStore({ stateDir });
    store.save('/proj-a', restrictive);
    store.remove('/proj-a');
    expect(store.get('/proj-a')).toEqual(EMPTY_PERMISSION_POLICY);
    expect(() => store.remove('/proj-never-saved')).not.toThrow();
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir)', () => {
    new PermissionPolicyStore({ stateDir }).save('/proj-a', restrictive);
    const reopened = new PermissionPolicyStore({ stateDir });
    expect(reopened.get('/proj-a')).toEqual(restrictive);
  });

  describe('on-disk validation', () => {
    it('throws PermissionPolicyError for invalid JSON', async () => {
      await writeFile(path.join(stateDir, 'permission-policy.json'), '{not json');
      const store = new PermissionPolicyStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(PermissionPolicyError);
    });

    it('throws PermissionPolicyError when a rule list is not an array of strings', async () => {
      await writeFile(
        path.join(stateDir, 'permission-policy.json'),
        JSON.stringify({
          v: 1,
          projects: { '/proj-a': { command: { allow: 'not-an-array', deny: [] } } },
        }),
      );
      const store = new PermissionPolicyStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(PermissionPolicyError);
    });

    it('tolerates a project record missing the network field, defaulting it empty', async () => {
      await writeFile(
        path.join(stateDir, 'permission-policy.json'),
        JSON.stringify({ v: 1, projects: { '/proj-a': { command: { allow: [], deny: ['rm'] } } } }),
      );
      const store = new PermissionPolicyStore({ stateDir });
      expect(store.get('/proj-a')).toEqual({
        command: { allow: [], deny: ['rm'] },
        network: { allow: [], deny: [] },
      });
    });
  });
});
