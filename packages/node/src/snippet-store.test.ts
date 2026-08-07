import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SnippetV1 } from '@loombox/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnippetError, SnippetStore } from './snippet-store';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'loombox-snippet-store-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const standupPrompt: SnippetV1 = {
  id: 'snip_standup',
  name: 'Daily standup',
  text: 'Summarize what changed since the last standup and flag anything blocked.',
};

describe('SnippetStore', () => {
  it('list() is [] for a node with nothing saved yet', () => {
    const store = new SnippetStore({ stateDir });
    expect(store.list()).toEqual([]);
  });

  it('get() is undefined for an unknown id — never throws', () => {
    const store = new SnippetStore({ stateDir });
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('saveAll() persists the full catalog, readable by a fresh store instance (survives a node restart)', () => {
    new SnippetStore({ stateDir }).saveAll([standupPrompt]);
    const reloaded = new SnippetStore({ stateDir });
    expect(reloaded.list()).toEqual([standupPrompt]);
    expect(reloaded.get('snip_standup')).toEqual(standupPrompt);
  });

  it('saveAll() fully replaces the catalog, never merges — a second call without the first snippet drops it', () => {
    const store = new SnippetStore({ stateDir });
    store.saveAll([standupPrompt]);
    const retroPrompt: SnippetV1 = {
      id: 'snip_retro',
      name: 'Retro notes',
      text: "What went well, what didn't, one action item.",
    };
    store.saveAll([retroPrompt]);
    expect(store.list()).toEqual([retroPrompt]);
    expect(store.get('snip_standup')).toBeUndefined();
  });

  it("preserves a snippet body's exact whitespace across a restart", () => {
    const withNewlines: SnippetV1 = {
      id: 'snip_multi',
      name: 'Multi-line',
      text: 'Line one.\n\n  Indented line two.\n',
    };
    new SnippetStore({ stateDir }).saveAll([withNewlines]);
    expect(new SnippetStore({ stateDir }).get('snip_multi')?.text).toBe(withNewlines.text);
  });

  it('throws SnippetError on a corrupt file rather than returning a partial catalog', () => {
    const store = new SnippetStore({ stateDir });
    store.saveAll([standupPrompt]);
    writeFileSync(path.join(stateDir, 'snippets.json'), '{not json');
    expect(() => store.list()).toThrow(SnippetError);
  });

  it('throws SnippetError on a snippet that fails schema validation (e.g. a blank id)', () => {
    writeFileSync(
      path.join(stateDir, 'snippets.json'),
      JSON.stringify({ v: 1, snippets: [{ id: '', name: 'x', text: 'y' }] }),
    );
    const store = new SnippetStore({ stateDir });
    expect(() => store.list()).toThrow(SnippetError);
  });
});
