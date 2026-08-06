import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CiWatchStore, CiWatchStoreError } from './ci-watch-store';
import type { CiWatchEntry } from './ci-check-watcher';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-ci-watch-store-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function entry(overrides: Partial<CiWatchEntry> = {}): CiWatchEntry {
  return {
    owner: 'fiorelorenzo',
    repo: 'loombox',
    ref: 'loombox/session-1',
    prNumber: 42,
    prUrl: 'https://github.com/fiorelorenzo/loombox/pull/42',
    projectPath: '/proj',
    ...overrides,
  };
}

describe('CiWatchStore (SPEC §7.14; issue #239)', () => {
  it('returns undefined for a session with no saved watch', () => {
    const store = new CiWatchStore({ stateDir });
    expect(store.get('sess-missing')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('round-trips a saved entry', () => {
    const store = new CiWatchStore({ stateDir });
    store.set('sess-1', entry());
    expect(store.get('sess-1')).toEqual(entry());
  });

  it('persists across a fresh store instance pointed at the same stateDir (survives a restart)', () => {
    const first = new CiWatchStore({ stateDir });
    first.set('sess-1', entry());

    const second = new CiWatchStore({ stateDir });
    expect(second.get('sess-1')).toEqual(entry());
  });

  it('list() returns every saved entry tagged with its own sessionId', () => {
    const store = new CiWatchStore({ stateDir });
    store.set('sess-1', entry({ ref: 'branch-1' }));
    store.set('sess-2', entry({ ref: 'branch-2' }));

    const records = store.list().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(records).toEqual([
      { sessionId: 'sess-1', ...entry({ ref: 'branch-1' }) },
      { sessionId: 'sess-2', ...entry({ ref: 'branch-2' }) },
    ]);
  });

  it('set() replaces an existing entry for the same session rather than merging it', () => {
    const store = new CiWatchStore({ stateDir });
    store.set('sess-1', entry({ prNumber: 1 }));
    store.set('sess-1', entry({ prNumber: 2 }));
    expect(store.get('sess-1')?.prNumber).toBe(2);
    expect(store.list()).toHaveLength(1);
  });

  it('remove() forgets a session and is a no-op for one that was never saved', () => {
    const store = new CiWatchStore({ stateDir });
    store.set('sess-1', entry());
    store.remove('sess-1');
    expect(store.get('sess-1')).toBeUndefined();
    expect(() => store.remove('sess-never-saved')).not.toThrow();
  });

  it('throws CiWatchStoreError on a corrupt JSON file', async () => {
    await writeFile(path.join(stateDir, 'ci-check-watches.json'), '{not json', 'utf8');
    const store = new CiWatchStore({ stateDir });
    expect(() => store.get('sess-1')).toThrow(CiWatchStoreError);
  });

  it('throws CiWatchStoreError on a saved entry missing a required field', async () => {
    await writeFile(
      path.join(stateDir, 'ci-check-watches.json'),
      JSON.stringify({ v: 1, sessions: { 'sess-1': { owner: 'a' } } }),
      'utf8',
    );
    const store = new CiWatchStore({ stateDir });
    expect(() => store.get('sess-1')).toThrow(CiWatchStoreError);
  });
});
