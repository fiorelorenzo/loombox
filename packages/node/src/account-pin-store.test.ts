import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountPinStore, AccountPinStoreError } from './account-pin-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-account-pin-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('AccountPinStore', () => {
  it('get() returns {} for an unconfigured project, against a fresh state dir', () => {
    const store = new AccountPinStore({ stateDir });
    expect(store.get('/proj-a')).toEqual({});
    expect(store.getPin('/proj-a', 'github')).toBeUndefined();
  });

  it('setPin() then getPin() round-trips a string pin for exactly the saved project/capability', () => {
    const store = new AccountPinStore({ stateDir });
    store.setPin('/proj-a', 'github', 'github:github.com:1111');
    expect(store.getPin('/proj-a', 'github')).toBe('github:github.com:1111');
    // A different, never-saved project is unaffected.
    expect(store.getPin('/proj-b', 'github')).toBeUndefined();
  });

  it('setPin(..., null) is an explicit opt-out, distinguishable from an unset capability', () => {
    const store = new AccountPinStore({ stateDir });
    store.setPin('/proj-a', 'github', null);
    expect(store.getPin('/proj-a', 'github')).toBeNull();
    expect('github' in store.get('/proj-a')).toBe(true);
    expect(store.getPin('/proj-a', 'jira')).toBeUndefined();
    expect('jira' in store.get('/proj-a')).toBe(false);
  });

  it('unsetPin() removes the key entirely, reverting to unconfigured — distinct from setPin(..., null)', () => {
    const store = new AccountPinStore({ stateDir });
    store.setPin('/proj-a', 'github', null);
    store.unsetPin('/proj-a', 'github');
    expect(store.getPin('/proj-a', 'github')).toBeUndefined();
    expect('github' in store.get('/proj-a')).toBe(false);
    expect(() => store.unsetPin('/proj-a', 'never-set')).not.toThrow();
  });

  it('setPin() for one capability leaves other capabilities on the same project untouched', () => {
    const store = new AccountPinStore({ stateDir });
    store.setPin('/proj-a', 'github', 'github:github.com:1111');
    store.setPin('/proj-a', 'jira', null);
    expect(store.get('/proj-a')).toEqual({ github: 'github:github.com:1111', jira: null });
    store.setPin('/proj-a', 'github', 'github:github.com:2222');
    expect(store.get('/proj-a')).toEqual({ github: 'github:github.com:2222', jira: null });
  });

  it('remove() clears every pin for a project, and is a no-op for one with no saved pins', () => {
    const store = new AccountPinStore({ stateDir });
    store.setPin('/proj-a', 'github', 'github:github.com:1111');
    store.setPin('/proj-a', 'jira', null);
    store.remove('/proj-a');
    expect(store.get('/proj-a')).toEqual({});
    expect(() => store.remove('/proj-never-saved')).not.toThrow();
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir), preserving the null/absent distinction', () => {
    const first = new AccountPinStore({ stateDir });
    first.setPin('/proj-a', 'github', null);
    first.setPin('/proj-a', 'jira', 'jira:myteam.atlassian.net:5b10ac8d');
    const reopened = new AccountPinStore({ stateDir });
    expect(reopened.getPin('/proj-a', 'github')).toBeNull();
    expect(reopened.getPin('/proj-a', 'jira')).toBe('jira:myteam.atlassian.net:5b10ac8d');
    expect(reopened.getPin('/proj-a', 'never-touched')).toBeUndefined();
  });

  describe('on-disk validation', () => {
    it('throws AccountPinStoreError for invalid JSON', async () => {
      await writeFile(path.join(stateDir, 'account-pins.json'), '{not json');
      const store = new AccountPinStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(AccountPinStoreError);
    });

    it('throws AccountPinStoreError when a pin value is neither a string nor null', async () => {
      await writeFile(
        path.join(stateDir, 'account-pins.json'),
        JSON.stringify({ v: 1, projects: { '/proj-a': { github: 42 } } }),
      );
      const store = new AccountPinStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(AccountPinStoreError);
    });

    it('preserves an on-disk explicit null through validation, distinct from an absent key', async () => {
      await writeFile(
        path.join(stateDir, 'account-pins.json'),
        JSON.stringify({
          v: 1,
          projects: { '/proj-a': { github: null, jira: 'jira:myteam.atlassian.net:5b10ac8d' } },
        }),
      );
      const store = new AccountPinStore({ stateDir });
      expect(store.get('/proj-a')).toEqual({
        github: null,
        jira: 'jira:myteam.atlassian.net:5b10ac8d',
      });
      expect('github' in store.get('/proj-a')).toBe(true);
    });
  });
});
