import { describe, expect, it } from 'vitest';
import type { PluginConfig } from '@loombox/providers-core';
import {
  addPluginConfig,
  createInMemoryPluginConfigStorage,
  createLocalStoragePluginConfigStorage,
  removePluginConfig,
  setPluginEnabled,
} from './plugin-store';
import { addMcpServerConfig, createLocalStorageMcpServerConfigStorage } from './mcp-server-store';

const config: PluginConfig = { name: 'commit-lint', source: '@loombox-plugins/commit-lint' };

describe('plugin-store (issue #191)', () => {
  it('starts empty', () => {
    expect(createInMemoryPluginConfigStorage().get()).toEqual([]);
  });

  it('addPluginConfig adds an enabled record; view/add/remove round-trips', () => {
    const storage = createInMemoryPluginConfigStorage();
    expect(addPluginConfig(storage, config)).toEqual([{ config, enabled: true }]);
    expect(storage.get()).toEqual([{ config, enabled: true }]);
    expect(removePluginConfig(storage, config.name)).toEqual([]);
    expect(storage.get()).toEqual([]);
  });

  it('addPluginConfig rejects a duplicate plugin name', () => {
    const storage = createInMemoryPluginConfigStorage();
    addPluginConfig(storage, config);
    expect(() => addPluginConfig(storage, config)).toThrow(/duplicate/i);
  });

  it('removePluginConfig is a no-op for an unknown name', () => {
    const storage = createInMemoryPluginConfigStorage();
    addPluginConfig(storage, config);
    expect(removePluginConfig(storage, 'nope')).toEqual([{ config, enabled: true }]);
  });

  it('setPluginEnabled toggles enabled without altering the declared config', () => {
    const storage = createInMemoryPluginConfigStorage();
    addPluginConfig(storage, config);
    expect(setPluginEnabled(storage, config.name, false)).toEqual([{ config, enabled: false }]);
    expect(setPluginEnabled(storage, config.name, true)).toEqual([{ config, enabled: true }]);
  });

  it('persists across a fresh storage handle for the same project', () => {
    const memory = new Map<string, string>();
    const fakeLocalStorage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const first = createLocalStoragePluginConfigStorage('/home/user/project-a', fakeLocalStorage);
    addPluginConfig(first, config);

    const second = createLocalStoragePluginConfigStorage('/home/user/project-a', fakeLocalStorage);
    expect(second.get()).toEqual([{ config, enabled: true }]);
  });

  it('degrades a corrupted stored value to an empty list rather than throwing', () => {
    const memory = new Map<string, string>();
    memory.set('loombox:plugins:/home/user/project-a', 'not json{{{');
    const fakeLocalStorage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const storage = createLocalStoragePluginConfigStorage('/home/user/project-a', fakeLocalStorage);
    expect(storage.get()).toEqual([]);
  });

  it('is isolated from the MCP-server store: adding a plugin never touches the MCP-server localStorage key, and vice versa, even with the same project path and record name', () => {
    const memory = new Map<string, string>();
    const fakeLocalStorage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const sharedName = 'shared-name';
    const pluginStorage = createLocalStoragePluginConfigStorage(
      '/home/user/project-a',
      fakeLocalStorage,
    );
    addPluginConfig(pluginStorage, { name: sharedName, source: 'some-source' });

    const mcpStorage = createLocalStorageMcpServerConfigStorage(
      '/home/user/project-a',
      fakeLocalStorage,
    );
    expect(mcpStorage.get()).toEqual([]);

    addMcpServerConfig(mcpStorage, {
      name: sharedName,
      transport: 'stdio',
      command: 'mcp-cmd',
      args: [],
      env: [],
    });

    // Adding the MCP server must not have altered the plugin list.
    expect(pluginStorage.get()).toEqual([
      { config: { name: sharedName, source: 'some-source' }, enabled: true },
    ]);
    expect(memory.size).toBe(2);
  });
});
