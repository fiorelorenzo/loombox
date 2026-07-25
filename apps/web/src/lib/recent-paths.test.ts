// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { addRecentPath, clearRecentPaths, loadRecentPaths, MAX_RECENT_PATHS } from './recent-paths';

beforeEach(() => {
  localStorage.clear();
});

describe('recent-paths (directory picker quick-pick list, issue #474)', () => {
  it('starts empty for a scope that has never recorded anything', () => {
    expect(loadRecentPaths('node_1:local')).toEqual([]);
  });

  it('records a path and lists it back, most-recent-first', () => {
    addRecentPath('node_1:local', '/home/dev/project-a');
    const next = addRecentPath('node_1:local', '/home/dev/project-b');
    expect(next).toEqual(['/home/dev/project-b', '/home/dev/project-a']);
    expect(loadRecentPaths('node_1:local')).toEqual(next);
  });

  it('moves an already-recorded path to the front instead of duplicating it', () => {
    addRecentPath('node_1:local', '/home/dev/project-a');
    addRecentPath('node_1:local', '/home/dev/project-b');
    const next = addRecentPath('node_1:local', '/home/dev/project-a');
    expect(next).toEqual(['/home/dev/project-a', '/home/dev/project-b']);
  });

  it('is a no-op for a blank path', () => {
    addRecentPath('node_1:local', '/home/dev/project-a');
    const next = addRecentPath('node_1:local', '   ');
    expect(next).toEqual(['/home/dev/project-a']);
  });

  it(`caps at ${MAX_RECENT_PATHS} entries, dropping the oldest`, () => {
    for (let i = 0; i < MAX_RECENT_PATHS + 3; i += 1) {
      addRecentPath('node_1:local', `/home/dev/project-${i}`);
    }
    const list = loadRecentPaths('node_1:local');
    expect(list).toHaveLength(MAX_RECENT_PATHS);
    expect(list[0]).toBe(`/home/dev/project-${MAX_RECENT_PATHS + 2}`);
    expect(list).not.toContain('/home/dev/project-0');
  });

  it("scopes entries per key — a different node/target never sees another scope's recent paths", () => {
    addRecentPath('node_1:local', '/home/dev/project-a');
    addRecentPath('node_2:ssh_devbox', '/home/dev/other-project');
    expect(loadRecentPaths('node_1:local')).toEqual(['/home/dev/project-a']);
    expect(loadRecentPaths('node_2:ssh_devbox')).toEqual(['/home/dev/other-project']);
  });

  it('clearRecentPaths empties a scope without touching others', () => {
    addRecentPath('node_1:local', '/home/dev/project-a');
    addRecentPath('node_2:ssh_devbox', '/home/dev/other-project');
    clearRecentPaths('node_1:local');
    expect(loadRecentPaths('node_1:local')).toEqual([]);
    expect(loadRecentPaths('node_2:ssh_devbox')).toEqual(['/home/dev/other-project']);
  });

  it('tolerates corrupt/garbage storage, defaulting to empty rather than throwing', () => {
    localStorage.setItem('loombox:recent-paths:node_1:local', 'not json{{{');
    expect(loadRecentPaths('node_1:local')).toEqual([]);

    localStorage.setItem('loombox:recent-paths:node_1:local', JSON.stringify({ not: 'an array' }));
    expect(loadRecentPaths('node_1:local')).toEqual([]);

    localStorage.setItem(
      'loombox:recent-paths:node_1:local',
      JSON.stringify(['/ok/path', 42, null]),
    );
    expect(loadRecentPaths('node_1:local')).toEqual(['/ok/path']);
  });
});
