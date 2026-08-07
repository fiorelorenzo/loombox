import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrackerMode } from '@loombox/protocol';

import { TrackerModeStore, TrackerModeStoreError } from './tracker-mode-store';

let stateDir: string;

const nativeMode = { kind: 'native' } satisfies TrackerMode;
const githubMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'github:github.com:1111',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
} satisfies TrackerMode;
const jiraMode = {
  kind: 'live',
  provider: 'jira',
  connectionId: 'jira:myteam.atlassian.net:5b10ac8d',
  target: { cloudId: 'cloud-1', projectKey: 'LB' },
} satisfies TrackerMode;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-tracker-mode-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('TrackerModeStore', () => {
  it('get() returns undefined for an unconfigured project, against a fresh state dir', () => {
    const store = new TrackerModeStore({ stateDir });
    expect(store.get('/proj-a')).toBeUndefined();
  });

  it('set() then get() round-trips a native mode for exactly the saved project', () => {
    const store = new TrackerModeStore({ stateDir });
    store.set('/proj-a', nativeMode);
    expect(store.get('/proj-a')).toEqual(nativeMode);
    // A different, never-saved project is unaffected.
    expect(store.get('/proj-b')).toBeUndefined();
  });

  it('set() then get() round-trips a live GitHub mode', () => {
    const store = new TrackerModeStore({ stateDir });
    store.set('/proj-a', githubMode);
    expect(store.get('/proj-a')).toEqual(githubMode);
  });

  it('set() then get() round-trips a live Jira mode', () => {
    const store = new TrackerModeStore({ stateDir });
    store.set('/proj-a', jiraMode);
    expect(store.get('/proj-a')).toEqual(jiraMode);
  });

  it('set() replaces a previously saved mode outright — there is no unset, only overwrite', () => {
    const store = new TrackerModeStore({ stateDir });
    store.set('/proj-a', githubMode);
    store.set('/proj-a', nativeMode);
    expect(store.get('/proj-a')).toEqual(nativeMode);
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir)', () => {
    const first = new TrackerModeStore({ stateDir });
    first.set('/proj-a', jiraMode);
    const reopened = new TrackerModeStore({ stateDir });
    expect(reopened.get('/proj-a')).toEqual(jiraMode);
    expect(reopened.get('/proj-never-touched')).toBeUndefined();
  });

  describe('list()', () => {
    it('returns nothing against a fresh state dir', () => {
      const store = new TrackerModeStore({ stateDir });
      expect(store.list()).toEqual([]);
    });

    it('returns every saved project paired with its mode, including native ones', () => {
      const store = new TrackerModeStore({ stateDir });
      store.set('/proj-a', githubMode);
      store.set('/proj-b', jiraMode);
      store.set('/proj-c', nativeMode);
      expect([...store.list()].sort((a, b) => a.projectPath.localeCompare(b.projectPath))).toEqual([
        { projectPath: '/proj-a', mode: githubMode },
        { projectPath: '/proj-b', mode: jiraMode },
        { projectPath: '/proj-c', mode: nativeMode },
      ]);
    });

    it('reflects the latest overwrite, not a stale earlier mode', () => {
      const store = new TrackerModeStore({ stateDir });
      store.set('/proj-a', githubMode);
      store.set('/proj-a', nativeMode);
      expect(store.list()).toEqual([{ projectPath: '/proj-a', mode: nativeMode }]);
    });

    it('silently omits a project whose on-disk value no longer validates, same degrade-to-absent discipline as get()', async () => {
      const filePath = path.join(stateDir, 'tracker-modes.json');
      await writeFile(
        filePath,
        JSON.stringify({
          v: 1,
          projects: { '/proj-good': nativeMode, '/proj-bad': { kind: 'not-a-real-kind' } },
        }),
      );
      const store = new TrackerModeStore({ stateDir });
      expect(store.list()).toEqual([{ projectPath: '/proj-good', mode: nativeMode }]);
    });
  });

  describe('on-disk validation', () => {
    it('throws TrackerModeStoreError for structurally invalid JSON', async () => {
      await writeFile(path.join(stateDir, 'tracker-modes.json'), '{not json');
      const store = new TrackerModeStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(TrackerModeStoreError);
    });

    it('throws TrackerModeStoreError when the file is not a JSON object', async () => {
      await writeFile(path.join(stateDir, 'tracker-modes.json'), '[1, 2, 3]');
      const store = new TrackerModeStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(TrackerModeStoreError);
    });

    it('an invalid stored TrackerMode value reads as absent, never as native (issue #631)', async () => {
      await writeFile(
        path.join(stateDir, 'tracker-modes.json'),
        JSON.stringify({ v: 1, projects: { '/proj-a': { kind: 'not-a-real-kind' } } }),
      );
      const store = new TrackerModeStore({ stateDir });
      expect(store.get('/proj-a')).toBeUndefined();
    });

    it('a live mode whose target shape does not match its provider reads as absent (superRefine cross-check, issue #209)', async () => {
      await writeFile(
        path.join(stateDir, 'tracker-modes.json'),
        JSON.stringify({
          v: 1,
          projects: {
            '/proj-a': {
              kind: 'live',
              provider: 'github',
              connectionId: 'github:github.com:1111',
              target: { cloudId: 'cloud-1', projectKey: 'LB' },
            },
          },
        }),
      );
      const store = new TrackerModeStore({ stateDir });
      expect(store.get('/proj-a')).toBeUndefined();
    });

    it('one project with an invalid value does not affect another, valid, project in the same file', async () => {
      await writeFile(
        path.join(stateDir, 'tracker-modes.json'),
        JSON.stringify({
          v: 1,
          projects: { '/proj-a': { kind: 'bogus' }, '/proj-b': nativeMode },
        }),
      );
      const store = new TrackerModeStore({ stateDir });
      expect(store.get('/proj-a')).toBeUndefined();
      expect(store.get('/proj-b')).toEqual(nativeMode);
    });
  });
});
