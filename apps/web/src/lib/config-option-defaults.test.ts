import { describe, expect, it } from 'vitest';

import {
  createInMemoryConfigOptionDefaultsStorage,
  createLocalStorageConfigOptionDefaultsStorage,
  rememberConfigOptionValues,
  rememberedConfigOptionsFor,
} from './config-option-defaults';

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

describe('rememberedConfigOptionsFor / rememberConfigOptionValues (issue #753)', () => {
  it('starts empty for a provider nothing has been remembered for yet', () => {
    const storage = createInMemoryConfigOptionDefaultsStorage();
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({});
  });

  it('remembers the current selection of every category, one merged write', () => {
    const storage = createInMemoryConfigOptionDefaultsStorage();
    rememberConfigOptionValues(storage, 'claude', [
      { category: 'model', current: 'opus' },
      { category: 'thought_level', current: 'high' },
    ]);
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({
      model: 'opus',
      thought_level: 'high',
    });
  });

  it('skips a category with no current selection rather than writing undefined', () => {
    const storage = createInMemoryConfigOptionDefaultsStorage();
    rememberConfigOptionValues(storage, 'claude', [
      { category: 'model', current: 'opus' },
      { category: 'mode', current: undefined },
    ]);
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({ model: 'opus' });
  });

  it('a later remember merges into, rather than replaces, the previously remembered categories', () => {
    const storage = createInMemoryConfigOptionDefaultsStorage();
    rememberConfigOptionValues(storage, 'claude', [{ category: 'model', current: 'sonnet' }]);
    rememberConfigOptionValues(storage, 'claude', [{ category: 'thought_level', current: 'low' }]);
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({
      model: 'sonnet',
      thought_level: 'low',
    });
  });

  it('a later remember overwrites the same category for the same provider', () => {
    const storage = createInMemoryConfigOptionDefaultsStorage();
    rememberConfigOptionValues(storage, 'claude', [{ category: 'model', current: 'sonnet' }]);
    rememberConfigOptionValues(storage, 'claude', [{ category: 'model', current: 'opus' }]);
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({ model: 'opus' });
  });

  it('keeps different providers separate', () => {
    const storage = createInMemoryConfigOptionDefaultsStorage();
    rememberConfigOptionValues(storage, 'claude', [{ category: 'model', current: 'opus' }]);
    rememberConfigOptionValues(storage, 'codex', [{ category: 'model', current: 'gpt-5' }]);
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({ model: 'opus' });
    expect(rememberedConfigOptionsFor(storage, 'codex')).toEqual({ model: 'gpt-5' });
  });

  it('a no-op call (every category undefined) never writes at all', () => {
    let writes = 0;
    const storage = createInMemoryConfigOptionDefaultsStorage();
    const set = storage.set.bind(storage);
    storage.set = (value) => {
      writes += 1;
      set(value);
    };
    rememberConfigOptionValues(storage, 'claude', [{ category: 'mode', current: undefined }]);
    expect(writes).toBe(0);
  });
});

describe('createLocalStorageConfigOptionDefaultsStorage (issue #753)', () => {
  it('defaults to nothing remembered when nothing is stored yet', () => {
    const storage = createLocalStorageConfigOptionDefaultsStorage(fakeLocalStorage());
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({});
  });

  it('persists across a fresh storage handle against the same backing storage', () => {
    const backing = fakeLocalStorage();
    const first = createLocalStorageConfigOptionDefaultsStorage(backing);
    rememberConfigOptionValues(first, 'claude', [{ category: 'model', current: 'opus' }]);
    const second = createLocalStorageConfigOptionDefaultsStorage(backing);
    expect(rememberedConfigOptionsFor(second, 'claude')).toEqual({ model: 'opus' });
  });

  it('one un-parameterized key holds every provider — not one key per provider', () => {
    const backing = fakeLocalStorage();
    const storage = createLocalStorageConfigOptionDefaultsStorage(backing);
    rememberConfigOptionValues(storage, 'claude', [{ category: 'model', current: 'opus' }]);
    rememberConfigOptionValues(storage, 'codex', [{ category: 'model', current: 'gpt-5' }]);
    expect(backing.getItem('loombox:config-option-defaults')).toBeTruthy();
    expect(JSON.parse(backing.getItem('loombox:config-option-defaults')!)).toEqual({
      claude: { model: 'opus' },
      codex: { model: 'gpt-5' },
    });
  });

  it('falls back to nothing remembered on corrupted stored JSON rather than throwing', () => {
    const backing = fakeLocalStorage();
    backing.setItem('loombox:config-option-defaults', 'not json{{{');
    const storage = createLocalStorageConfigOptionDefaultsStorage(backing);
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({});
  });

  it('drops a corrupted single provider entry rather than discarding every other provider', () => {
    const backing = fakeLocalStorage();
    backing.setItem(
      'loombox:config-option-defaults',
      JSON.stringify({ claude: { model: 'opus' }, codex: 'not-a-map' }),
    );
    const storage = createLocalStorageConfigOptionDefaultsStorage(backing);
    expect(rememberedConfigOptionsFor(storage, 'claude')).toEqual({ model: 'opus' });
    expect(rememberedConfigOptionsFor(storage, 'codex')).toEqual({});
  });
});
