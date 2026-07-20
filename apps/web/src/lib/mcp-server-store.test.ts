import { describe, expect, it } from 'vitest';
import {
  MCP_SERVER_PRESET_CATALOG,
  instantiateMcpPreset,
  parseMcpServerConfig,
  requiredSecrets,
} from '@loombox/providers-core';
import {
  addMcpServerConfig,
  addMcpServerFromPreset,
  createInMemoryMcpServerConfigStorage,
  createLocalStorageMcpServerConfigStorage,
  removeMcpServerConfig,
  requiredSecretNames,
  setMcpServerEnabled,
} from './mcp-server-store';

const manualConfig = parseMcpServerConfig({
  name: 'custom-tool',
  transport: 'stdio',
  command: '/usr/local/bin/custom-tool',
  args: ['--serve'],
  env: [],
});

describe('mcp-server-store (issue #188)', () => {
  it('starts empty', () => {
    const storage = createInMemoryMcpServerConfigStorage();
    expect(storage.get()).toEqual([]);
  });

  it('addMcpServerConfig adds a manually entered server as an enabled record', () => {
    const storage = createInMemoryMcpServerConfigStorage();
    const result = addMcpServerConfig(storage, manualConfig);
    expect(result).toEqual([{ config: manualConfig, enabled: true }]);
    expect(storage.get()).toEqual([{ config: manualConfig, enabled: true }]);
  });

  it('addMcpServerConfig rejects a duplicate server name', () => {
    const storage = createInMemoryMcpServerConfigStorage();
    addMcpServerConfig(storage, manualConfig);
    expect(() => addMcpServerConfig(storage, manualConfig)).toThrow(/duplicate/i);
  });

  it('addMcpServerFromPreset produces the exact same record shape addMcpServerConfig would for the equivalent manual entry (issue #188 core guarantee)', () => {
    const preset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'filesystem')!;

    const viaPreset = createInMemoryMcpServerConfigStorage();
    addMcpServerFromPreset(viaPreset, preset);

    const viaManual = createInMemoryMcpServerConfigStorage();
    addMcpServerConfig(viaManual, instantiateMcpPreset(preset));

    expect(viaPreset.get()).toEqual(viaManual.get());
    expect(viaPreset.get()).toEqual([{ config: preset.config, enabled: true }]);
  });

  it('a secret-requiring preset still adds cleanly and surfaces its required secret names, without ever carrying a value', () => {
    const preset = MCP_SERVER_PRESET_CATALOG.find((p) => requiredSecrets(p.config).length > 0)!;
    const storage = createInMemoryMcpServerConfigStorage();
    const [record] = addMcpServerFromPreset(storage, preset);
    expect(requiredSecretNames(record!.config).length).toBeGreaterThan(0);
    const vars = record!.config.transport === 'stdio' ? record!.config.env : record!.config.headers;
    for (const v of vars) {
      if ('secret' in v) expect((v as { value?: unknown }).value).toBeUndefined();
    }
  });

  it('removeMcpServerConfig removes by name and is a no-op for an unknown name', () => {
    const storage = createInMemoryMcpServerConfigStorage();
    addMcpServerConfig(storage, manualConfig);
    expect(removeMcpServerConfig(storage, 'does-not-exist')).toEqual([
      { config: manualConfig, enabled: true },
    ]);
    expect(removeMcpServerConfig(storage, manualConfig.name)).toEqual([]);
  });

  it('setMcpServerEnabled toggles enabled without altering the declared config', () => {
    const storage = createInMemoryMcpServerConfigStorage();
    addMcpServerConfig(storage, manualConfig);
    const disabled = setMcpServerEnabled(storage, manualConfig.name, false);
    expect(disabled).toEqual([{ config: manualConfig, enabled: false }]);
    const reenabled = setMcpServerEnabled(storage, manualConfig.name, true);
    expect(reenabled).toEqual([{ config: manualConfig, enabled: true }]);
  });

  it('createLocalStorageMcpServerConfigStorage persists across a fresh storage handle for the same project (localStorage-like round trip)', () => {
    const memory = new Map<string, string>();
    const fakeLocalStorage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const first = createLocalStorageMcpServerConfigStorage(
      '/home/user/project-a',
      fakeLocalStorage,
    );
    addMcpServerConfig(first, manualConfig);

    const second = createLocalStorageMcpServerConfigStorage(
      '/home/user/project-a',
      fakeLocalStorage,
    );
    expect(second.get()).toEqual([{ config: manualConfig, enabled: true }]);
  });

  it('createLocalStorageMcpServerConfigStorage scopes storage per project path', () => {
    const memory = new Map<string, string>();
    const fakeLocalStorage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const projectA = createLocalStorageMcpServerConfigStorage(
      '/home/user/project-a',
      fakeLocalStorage,
    );
    addMcpServerConfig(projectA, manualConfig);

    const projectB = createLocalStorageMcpServerConfigStorage(
      '/home/user/project-b',
      fakeLocalStorage,
    );
    expect(projectB.get()).toEqual([]);
  });

  it('createLocalStorageMcpServerConfigStorage degrades a corrupted stored value to an empty list rather than throwing', () => {
    const memory = new Map<string, string>();
    memory.set('loombox:mcp-servers:/home/user/project-a', 'not json{{{');
    const fakeLocalStorage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const storage = createLocalStorageMcpServerConfigStorage(
      '/home/user/project-a',
      fakeLocalStorage,
    );
    expect(storage.get()).toEqual([]);
  });
});
