import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentProfileError, AgentProfileStore } from './agent-profile-store';
import type { AgentProfile } from './agent-profile';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'loombox-agent-profile-store-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const askFirst: AgentProfile = {
  id: 'prof_ask',
  name: 'Ask First',
  deniedToolKinds: ['execute', 'delete'],
  deniedToolNamePatterns: [],
  deniedMcpServers: [],
};

describe('AgentProfileStore', () => {
  it('list() is [] for a node with nothing saved yet', () => {
    const store = new AgentProfileStore({ stateDir });
    expect(store.list()).toEqual([]);
  });

  it('get() is undefined for an unknown id — never throws', () => {
    const store = new AgentProfileStore({ stateDir });
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('saveAll() persists the full catalog, readable by a fresh store instance (survives a node restart)', () => {
    new AgentProfileStore({ stateDir }).saveAll([askFirst]);
    const reloaded = new AgentProfileStore({ stateDir });
    expect(reloaded.list()).toEqual([askFirst]);
    expect(reloaded.get('prof_ask')).toEqual(askFirst);
  });

  it('saveAll() fully replaces the catalog, never merges — a second call without the first profile drops it', () => {
    const store = new AgentProfileStore({ stateDir });
    store.saveAll([askFirst]);
    const minimal: AgentProfile = {
      id: 'prof_min',
      name: 'Minimal',
      deniedToolKinds: ['execute', 'edit', 'delete', 'move', 'fetch'],
      deniedToolNamePatterns: [],
      deniedMcpServers: [],
    };
    store.saveAll([minimal]);
    expect(store.list()).toEqual([minimal]);
    expect(store.get('prof_ask')).toBeUndefined();
  });

  it('throws AgentProfileError on a corrupt file rather than returning a partial catalog', () => {
    const store = new AgentProfileStore({ stateDir });
    store.saveAll([askFirst]);
    writeFileSync(path.join(stateDir, 'agent-profiles.json'), '{not json');
    expect(() => store.list()).toThrow(AgentProfileError);
  });
});
