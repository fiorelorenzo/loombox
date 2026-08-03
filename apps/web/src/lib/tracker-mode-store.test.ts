import { describe, expect, it } from 'vitest';
import type { TrackerMode } from '@loombox/protocol';
import {
  createInMemoryTrackerModeStorage,
  createLocalStorageTrackerModeStorage,
} from './tracker-mode-store';

const nativeMode = { kind: 'native' } satisfies TrackerMode;
const githubMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'conn_1',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
} satisfies TrackerMode;
const jiraMode = {
  kind: 'live',
  provider: 'jira',
  connectionId: 'conn_2',
  target: { cloudId: 'abc-123', projectKey: 'LB' },
} satisfies TrackerMode;

function fakeLocalStorage(): Storage {
  const memory = new Map<string, string>();
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe('tracker-mode-store (issue #209)', () => {
  it('starts unset — no default silently assumed', () => {
    const storage = createInMemoryTrackerModeStorage();
    expect(storage.get()).toBeUndefined();
  });

  it('in-memory storage round-trips native mode', () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set(nativeMode);
    expect(storage.get()).toEqual(nativeMode);
  });

  it('in-memory storage round-trips a live GitHub mode', () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set(githubMode);
    expect(storage.get()).toEqual(githubMode);
  });

  it('createLocalStorageTrackerModeStorage persists across a fresh storage handle for the same project (localStorage-like round trip)', () => {
    const backing = fakeLocalStorage();

    const first = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    first.set(jiraMode);

    const second = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    expect(second.get()).toEqual(jiraMode);
  });

  it('createLocalStorageTrackerModeStorage returns undefined for a project that has never had a mode set', () => {
    const backing = fakeLocalStorage();
    const storage = createLocalStorageTrackerModeStorage('/home/user/never-configured', backing);
    expect(storage.get()).toBeUndefined();
  });

  it('createLocalStorageTrackerModeStorage scopes storage per project path', () => {
    const backing = fakeLocalStorage();

    const projectA = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    projectA.set(nativeMode);

    const projectB = createLocalStorageTrackerModeStorage('/home/user/project-b', backing);
    expect(projectB.get()).toBeUndefined();
  });

  it('degrades unparsable stored JSON to undefined rather than throwing or defaulting to native', () => {
    const backing = fakeLocalStorage();
    backing.setItem('loombox:tracker-mode:/home/user/project-a', 'not json{{{');

    const storage = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    expect(storage.get()).toBeUndefined();
  });

  it('degrades a schema-invalid stored value to undefined rather than coercing it to native', () => {
    const backing = fakeLocalStorage();
    backing.setItem(
      'loombox:tracker-mode:/home/user/project-a',
      JSON.stringify({
        kind: 'live',
        provider: 'jira',
        connectionId: 'c1',
        target: { owner: 'a', repo: 'b' },
      }),
    );

    const storage = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    expect(storage.get()).toBeUndefined();
  });

  it('overwriting a stored mode replaces it, not merges it', () => {
    const backing = fakeLocalStorage();
    const storage = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    storage.set(githubMode);
    storage.set(nativeMode);
    expect(storage.get()).toEqual(nativeMode);
  });
});
