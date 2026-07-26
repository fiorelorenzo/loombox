import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryProjectStorage,
  createProjectStore,
  projectKey,
  projectNameFromPath,
  sessionProjectKey,
  type ProjectSessionRef,
} from './projects';

function session(nodeId: string, targetId: string, projectPath: string): ProjectSessionRef {
  return { nodeId, targetId, projectPath };
}

describe('project identity', () => {
  it('treats the same path on two targets as two different projects', () => {
    const here = { nodeId: 'n1', targetId: 'local', path: '/srv/app' };
    const there = { nodeId: 'n1', targetId: 'ssh:build', path: '/srv/app' };
    expect(projectKey(here)).not.toEqual(projectKey(there));
  });

  it('agrees with the key derived from a session, so a session always files under its project', () => {
    expect(projectKey({ nodeId: 'n1', targetId: 'local', path: '/srv/app' })).toEqual(
      sessionProjectKey(session('n1', 'local', '/srv/app')),
    );
  });
});

describe('projectNameFromPath', () => {
  it('names a project after its last segment', () => {
    expect(projectNameFromPath('/home/dev/Progetti/loombox')).toBe('loombox');
  });

  it('ignores a trailing slash rather than producing a blank label', () => {
    expect(projectNameFromPath('/home/dev/loombox/')).toBe('loombox');
  });

  it('never returns an empty string, which would render an unclickable row', () => {
    expect(projectNameFromPath('/')).not.toBe('');
    expect(projectNameFromPath('')).not.toBe('');
  });
});

describe('createProjectStore', () => {
  it('registers a folder and defaults its name to the basename', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const created = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    expect(created.name).toBe('app');
    expect(get(store)).toHaveLength(1);
  });

  it('honours an explicit name over the basename', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    expect(
      store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app', name: 'Prod API' }).name,
    ).toBe('Prod API');
  });

  it('adding the same folder twice is a no-op, not a duplicate row', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const first = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    const second = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    expect(second.id).toBe(first.id);
    expect(get(store)).toHaveLength(1);
  });

  it('re-adding an adopted project fills in the git flag adoption could not know', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    store.adoptFromSessions([session('n1', 'local', '/srv/app')]);
    expect(get(store)[0].isGitRepo).toBeUndefined();

    store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app', isGitRepo: true });
    expect(get(store)).toHaveLength(1);
    expect(get(store)[0].isGitRepo).toBe(true);
  });

  it('persists through the injected storage so a reload sees the same projects', () => {
    const storage = createInMemoryProjectStorage();
    createProjectStore(storage).add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    expect(get(createProjectStore(storage))).toHaveLength(1);
  });

  it('sorts by name case-insensitively, so the sidebar order is not insertion order', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    store.add({ nodeId: 'n1', targetId: 'local', path: '/a/zebra' });
    store.add({ nodeId: 'n1', targetId: 'local', path: '/a/Apple' });
    expect(get(store).map((p) => p.name)).toEqual(['Apple', 'zebra']);
  });

  it('renames, and refuses a blank name that would render an unclickable row', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const created = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    store.rename(created.id, 'Renamed');
    expect(get(store)[0].name).toBe('Renamed');
    store.rename(created.id, '   ');
    expect(get(store)[0].name).toBe('Renamed');
  });

  it('records what the directory listing reported about the folder being a repo', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const created = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    store.setGitRepo(created.id, false);
    expect(get(store)[0].isGitRepo).toBe(false);
  });

  it('removing forgets the entry only', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const created = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    store.remove(created.id);
    expect(get(store)).toHaveLength(0);
  });
});

describe('adoptFromSessions', () => {
  it('registers a project for every distinct triple, so no session is orphaned', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    store.adoptFromSessions([
      session('n1', 'local', '/srv/app'),
      session('n1', 'local', '/srv/app'),
      session('n1', 'ssh:build', '/srv/app'),
      session('n1', 'local', '/srv/other'),
    ]);
    expect(
      get(store)
        .map((p) => p.path)
        .sort(),
    ).toEqual(['/srv/app', '/srv/app', '/srv/other']);
    expect(get(store)).toHaveLength(3);
  });

  it('is idempotent, so it can run on every session-list update', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const sessions = [session('n1', 'local', '/srv/app')];
    store.adoptFromSessions(sessions);
    store.adoptFromSessions(sessions);
    store.adoptFromSessions(sessions);
    expect(get(store)).toHaveLength(1);
  });

  it('never renames a project the user has already named', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const created = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    store.rename(created.id, 'Prod API');
    store.adoptFromSessions([session('n1', 'local', '/srv/app')]);
    expect(get(store)).toHaveLength(1);
    expect(get(store)[0].name).toBe('Prod API');
  });

  it('brings a removed project back while its sessions still exist', () => {
    const store = createProjectStore(createInMemoryProjectStorage());
    const created = store.add({ nodeId: 'n1', targetId: 'local', path: '/srv/app' });
    store.remove(created.id);
    store.adoptFromSessions([session('n1', 'local', '/srv/app')]);
    expect(get(store)).toHaveLength(1);
  });
});
