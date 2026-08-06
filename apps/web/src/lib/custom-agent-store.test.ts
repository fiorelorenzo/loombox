import { describe, expect, it } from 'vitest';
import { customAgentRecordV1, type CustomAgentRecordV1 } from '@loombox/protocol';
import { AGENT_CATALOGUE, StaleAgentCatalogueEntryError } from '@loombox/providers-core/browser';
import type { AgentCatalogueEntry } from '@loombox/providers-core/browser';
import {
  addCustomAgent,
  addCustomAgentFromCatalogueEntry,
  createInMemoryCustomAgentStorage,
  createLocalStorageCustomAgentStorage,
  CustomAgentStoreError,
  removeCustomAgent,
} from './custom-agent-store';

const manualRecord: CustomAgentRecordV1 = customAgentRecordV1.parse({
  name: 'My internal agent',
  command: 'omp',
  args: ['acp'],
  env: { FOO: 'bar' },
});

function fakeLocalStorage(memory = new Map<string, string>()): Storage {
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe('custom-agent-store (issue #748)', () => {
  it('starts empty', () => {
    const storage = createInMemoryCustomAgentStorage();
    expect(storage.get()).toEqual([]);
  });

  it('addCustomAgent adds a manually entered record', () => {
    const storage = createInMemoryCustomAgentStorage();
    const result = addCustomAgent(storage, manualRecord);
    expect(result).toEqual([manualRecord]);
    expect(storage.get()).toEqual([manualRecord]);
  });

  it('addCustomAgent defaults args to [] and leaves env undefined when omitted, exactly like the schema itself', () => {
    const storage = createInMemoryCustomAgentStorage();
    const record = customAgentRecordV1.parse({ name: 'bare', command: 'omp' });
    addCustomAgent(storage, record);
    expect(storage.get()).toEqual([{ name: 'bare', command: 'omp', args: [] }]);
  });

  it('addCustomAgent rejects a duplicate name', () => {
    const storage = createInMemoryCustomAgentStorage();
    addCustomAgent(storage, manualRecord);
    expect(() => addCustomAgent(storage, manualRecord)).toThrow(/duplicate/i);
  });

  it('addCustomAgent allows two records sharing the same command with different names (a project may run one binary several ways)', () => {
    const storage = createInMemoryCustomAgentStorage();
    addCustomAgent(storage, manualRecord);
    const second = customAgentRecordV1.parse({
      name: 'Verbose variant',
      command: 'omp',
      args: ['acp', '--verbose'],
    });
    const result = addCustomAgent(storage, second);
    expect(result).toEqual([manualRecord, second]);
  });

  it('removeCustomAgent removes by name and is a no-op for an unknown name', () => {
    const storage = createInMemoryCustomAgentStorage();
    addCustomAgent(storage, manualRecord);
    expect(removeCustomAgent(storage, 'does-not-exist')).toEqual([manualRecord]);
    expect(removeCustomAgent(storage, manualRecord.name)).toEqual([]);
  });

  it('createLocalStorageCustomAgentStorage persists across a fresh storage handle for the same project (localStorage-like round trip)', () => {
    const memory = new Map<string, string>();
    const storage = fakeLocalStorage(memory);

    const first = createLocalStorageCustomAgentStorage('/home/user/project-a', storage);
    addCustomAgent(first, manualRecord);

    const second = createLocalStorageCustomAgentStorage('/home/user/project-a', storage);
    expect(second.get()).toEqual([manualRecord]);
  });

  it('createLocalStorageCustomAgentStorage scopes storage per project path', () => {
    const storage = fakeLocalStorage();

    const projectA = createLocalStorageCustomAgentStorage('/home/user/project-a', storage);
    addCustomAgent(projectA, manualRecord);

    const projectB = createLocalStorageCustomAgentStorage('/home/user/project-b', storage);
    expect(projectB.get()).toEqual([]);
  });

  it('createLocalStorageCustomAgentStorage degrades a corrupted stored value to an empty list rather than throwing', () => {
    const memory = new Map<string, string>();
    memory.set('loombox:custom-agents:/home/user/project-a', 'not json{{{');
    const storage = createLocalStorageCustomAgentStorage(
      '/home/user/project-a',
      fakeLocalStorage(memory),
    );
    expect(storage.get()).toEqual([]);
  });

  it('createLocalStorageCustomAgentStorage skips a single corrupted entry (missing required command) rather than dropping the whole list', () => {
    const memory = new Map<string, string>();
    memory.set(
      'loombox:custom-agents:/home/user/project-a',
      JSON.stringify([{ name: 'valid', command: 'omp', args: [] }, { name: 'missing command' }]),
    );
    const storage = createLocalStorageCustomAgentStorage(
      '/home/user/project-a',
      fakeLocalStorage(memory),
    );
    expect(storage.get()).toEqual([{ name: 'valid', command: 'omp', args: [] }]);
  });
});

describe('addCustomAgentFromCatalogueEntry (issue #749)', () => {
  it('adds a catalogue entry with the exact same shape addCustomAgent would produce for the equivalent manual entry', () => {
    const entry = AGENT_CATALOGUE.find((e) => e.id === 'gemini-cli')!;

    const viaCatalogue = createInMemoryCustomAgentStorage();
    addCustomAgentFromCatalogueEntry(viaCatalogue, entry);

    const viaManual = createInMemoryCustomAgentStorage();
    addCustomAgent(viaManual, customAgentRecordV1.parse(entry.config));

    expect(viaCatalogue.get()).toEqual(viaManual.get());
    expect(viaCatalogue.get()).toEqual([
      { name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
    ]);
  });

  it('rejects a catalogue pick that collides with an existing custom agent name, same as a manual add would', () => {
    const storage = createInMemoryCustomAgentStorage();
    const entry = AGENT_CATALOGUE.find((e) => e.id === 'qwen-code')!;
    addCustomAgentFromCatalogueEntry(storage, entry);

    expect(() => addCustomAgentFromCatalogueEntry(storage, entry)).toThrow(CustomAgentStoreError);
    expect(storage.get()).toHaveLength(1);
  });

  it("propagates StaleAgentCatalogueEntryError for a stale entry without touching storage — the loud runtime half of issue #749's upkeep requirement", () => {
    const storage = createInMemoryCustomAgentStorage();
    const staleEntry: AgentCatalogueEntry = {
      id: 'ancient-agent',
      description: 'An agent whose verification lapsed.',
      config: customAgentRecordV1.parse({ name: 'Ancient Agent', command: 'ancient' }),
      verification: {
        against: 'ancient-agent@1.0.0',
        verifiedOn: '2020-01-01',
        sourceUrl: 'https://example.com/ancient-agent/docs',
        staleAfterDays: 180,
      },
    };

    expect(() => addCustomAgentFromCatalogueEntry(storage, staleEntry)).toThrow(
      StaleAgentCatalogueEntryError,
    );
    expect(storage.get()).toEqual([]);
  });
});
