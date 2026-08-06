import { describe, expect, it } from 'vitest';

import {
  clearConfigOptionOverride,
  configOptionOverridesFor,
  createInMemoryConfigOptionOverrideStorage,
  createLocalStorageConfigOptionOverrideStorage,
  setConfigOptionOverride,
} from './config-option-overrides';

function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('setConfigOptionOverride / clearConfigOptionOverride (issue #753)', () => {
  it('starts with no override for a provider nothing has been pinned for yet', () => {
    const storage = createInMemoryConfigOptionOverrideStorage();
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({});
  });

  it('pins a category, merging into rather than replacing other pinned categories', () => {
    const storage = createInMemoryConfigOptionOverrideStorage();
    setConfigOptionOverride(storage, 'claude', 'model', 'opus');
    setConfigOptionOverride(storage, 'claude', 'thought_level', 'high');
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({
      model: 'opus',
      thought_level: 'high',
    });
  });

  it('re-pinning the same category replaces its value', () => {
    const storage = createInMemoryConfigOptionOverrideStorage();
    setConfigOptionOverride(storage, 'claude', 'model', 'sonnet');
    setConfigOptionOverride(storage, 'claude', 'model', 'opus');
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({ model: 'opus' });
  });

  it('clearConfigOptionOverride removes only the named category', () => {
    const storage = createInMemoryConfigOptionOverrideStorage();
    setConfigOptionOverride(storage, 'claude', 'model', 'opus');
    setConfigOptionOverride(storage, 'claude', 'thought_level', 'high');
    clearConfigOptionOverride(storage, 'claude', 'model');
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({ thought_level: 'high' });
  });

  it('clearConfigOptionOverride is a no-op for a category that was never pinned', () => {
    const storage = createInMemoryConfigOptionOverrideStorage();
    setConfigOptionOverride(storage, 'claude', 'model', 'opus');
    clearConfigOptionOverride(storage, 'claude', 'mode');
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({ model: 'opus' });
  });

  it('keeps different providers separate', () => {
    const storage = createInMemoryConfigOptionOverrideStorage();
    setConfigOptionOverride(storage, 'claude', 'model', 'opus');
    setConfigOptionOverride(storage, 'codex', 'model', 'gpt-5');
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({ model: 'opus' });
    expect(configOptionOverridesFor(storage, 'codex')).toEqual({ model: 'gpt-5' });
  });
});

describe('createLocalStorageConfigOptionOverrideStorage (issue #753)', () => {
  it('defaults to no override when nothing is stored yet', () => {
    const storage = createLocalStorageConfigOptionOverrideStorage(
      '/home/user/project-a',
      fakeLocalStorage(),
    );
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({});
  });

  it('persists across a fresh storage handle for the same project (localStorage-like round trip)', () => {
    const backing = fakeLocalStorage();
    const first = createLocalStorageConfigOptionOverrideStorage('/home/user/project-a', backing);
    setConfigOptionOverride(first, 'claude', 'model', 'opus');
    const second = createLocalStorageConfigOptionOverrideStorage('/home/user/project-a', backing);
    expect(configOptionOverridesFor(second, 'claude')).toEqual({ model: 'opus' });
  });

  it('scopes storage per project path — mirrors mcp-server-store.ts:44', () => {
    const backing = fakeLocalStorage();
    const projectA = createLocalStorageConfigOptionOverrideStorage('/home/user/project-a', backing);
    const projectB = createLocalStorageConfigOptionOverrideStorage('/home/user/project-b', backing);
    setConfigOptionOverride(projectA, 'claude', 'model', 'opus');
    setConfigOptionOverride(projectB, 'claude', 'model', 'haiku');
    expect(configOptionOverridesFor(projectA, 'claude')).toEqual({ model: 'opus' });
    expect(configOptionOverridesFor(projectB, 'claude')).toEqual({ model: 'haiku' });
  });

  it('degrades a corrupted stored value to no overrides rather than throwing', () => {
    const backing = fakeLocalStorage();
    backing.setItem('loombox:config-option-overrides:/home/user/project-a', 'not json{{{');
    const storage = createLocalStorageConfigOptionOverrideStorage('/home/user/project-a', backing);
    expect(configOptionOverridesFor(storage, 'claude')).toEqual({});
  });
});
