import { describe, expect, it, vi } from 'vitest';
import type { TrackerBackend, TrackerBinding, TrackerListPage } from '@loombox/shared';
import {
  TrackerConnectivityWatcher,
  type TrackerConnectivityTarget,
} from './tracker-connectivity-watcher';
import { GithubTrackerRequestError } from './github-tracker-backend';

const binding: TrackerBinding = {
  connectionId: 'github:github.com:1',
  target: { owner: 'o', repo: 'r' },
};

function fakeBackend(list: (binding: TrackerBinding) => Promise<TrackerListPage>): TrackerBackend {
  return {
    id: 'github',
    capabilities: {
      comments: true,
      transitions: true,
      boards: false,
      sprints: false,
      labels: true,
      milestones: true,
      customFields: false,
    },
    listBindings: () => Promise.resolve([]),
    list,
    get: () => Promise.reject(new Error('not used')),
    create: () => Promise.reject(new Error('not used')),
    update: () => Promise.reject(new Error('not used')),
  };
}

describe('TrackerConnectivityWatcher (issue #219) — no real network, every backend call stubbed', () => {
  it('reports reachable for a successful poll, even with zero items (reachable-and-empty is never confused with unreachable)', async () => {
    const target: TrackerConnectivityTarget = {
      ok: true,
      provider: 'github',
      backend: fakeBackend(() => Promise.resolve({ items: [] })),
      binding,
    };
    const watcher = new TrackerConnectivityWatcher({
      resolveTarget: () => Promise.resolve(target),
      now: () => 1000,
    });
    watcher.watch('/proj');
    await watcher.pollNow();
    expect(watcher.latestFor('/proj')).toEqual({
      state: 'reachable',
      provider: 'github',
      updatedAt: 1000,
    });
  });

  it('reports unreachable when the backend call throws a transient error', async () => {
    const target: TrackerConnectivityTarget = {
      ok: true,
      provider: 'github',
      backend: fakeBackend(() =>
        Promise.reject(new GithubTrackerRequestError(500, 'https://api.github.com/x')),
      ),
      binding,
    };
    const watcher = new TrackerConnectivityWatcher({
      resolveTarget: () => Promise.resolve(target),
      now: () => 2000,
    });
    watcher.watch('/proj');
    await watcher.pollNow();
    expect(watcher.latestFor('/proj')).toEqual({
      state: 'unreachable',
      provider: 'github',
      updatedAt: 2000,
    });
  });

  it('reports authFailed when the backend call is rejected on credential grounds', async () => {
    const target: TrackerConnectivityTarget = {
      ok: true,
      provider: 'github',
      backend: fakeBackend(() =>
        Promise.reject(new GithubTrackerRequestError(401, 'https://api.github.com/x')),
      ),
      binding,
    };
    const watcher = new TrackerConnectivityWatcher({
      resolveTarget: () => Promise.resolve(target),
      now: () => 3000,
    });
    watcher.watch('/proj');
    await watcher.pollNow();
    expect(watcher.latestFor('/proj')).toEqual({
      state: 'authFailed',
      provider: 'github',
      updatedAt: 3000,
    });
  });

  it('reports authFailed when resolveTrackerBackend itself failed to compose a backend at all (no credential to even try)', async () => {
    const watcher = new TrackerConnectivityWatcher({
      resolveTarget: () => Promise.resolve({ ok: false, provider: 'jira' }),
      now: () => 4000,
    });
    watcher.watch('/proj-jira');
    await watcher.pollNow();
    expect(watcher.latestFor('/proj-jira')).toEqual({
      state: 'authFailed',
      provider: 'jira',
      updatedAt: 4000,
    });
  });

  it('fires onUpdate on every pass, whatever the resulting state — recovery is observable, not just failure', async () => {
    let shouldFail = true;
    const target: TrackerConnectivityTarget = {
      ok: true,
      provider: 'github',
      backend: fakeBackend(() =>
        shouldFail
          ? Promise.reject(new GithubTrackerRequestError(500, 'https://api.github.com/x'))
          : Promise.resolve({ items: [] }),
      ),
      binding,
    };
    const onUpdate = vi.fn();
    const watcher = new TrackerConnectivityWatcher({
      resolveTarget: () => Promise.resolve(target),
      now: () => 5000,
      onUpdate,
    });
    watcher.watch('/proj');
    await watcher.pollNow();
    expect(onUpdate).toHaveBeenLastCalledWith('/proj', {
      state: 'unreachable',
      provider: 'github',
      updatedAt: 5000,
    });

    shouldFail = false;
    await watcher.pollNow();
    expect(onUpdate).toHaveBeenLastCalledWith('/proj', {
      state: 'reachable',
      provider: 'github',
      updatedAt: 5000,
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('unwatch forgets the last reading and stops firing onUpdate for a project mid-poll', async () => {
    const { promise: pollPromise, resolve: resolvePoll } = Promise.withResolvers<TrackerListPage>();
    const target: TrackerConnectivityTarget = {
      ok: true,
      provider: 'github',
      backend: fakeBackend(() => pollPromise),
      binding,
    };
    const onUpdate = vi.fn();
    const watcher = new TrackerConnectivityWatcher({
      resolveTarget: () => Promise.resolve(target),
      onUpdate,
    });
    watcher.watch('/proj');
    const pending = watcher.pollNow();
    watcher.unwatch('/proj');
    resolvePoll({ items: [] });
    await pending;
    expect(onUpdate).not.toHaveBeenCalled();
    expect(watcher.latestFor('/proj')).toBeUndefined();
  });

  it('polls one project at a time without duplicating calls across two watched projects', async () => {
    const calls: string[] = [];
    const watcher = new TrackerConnectivityWatcher({
      resolveTarget: (projectPath) => {
        calls.push(projectPath);
        return Promise.resolve({
          ok: true,
          provider: 'github',
          backend: fakeBackend(() => Promise.resolve({ items: [] })),
          binding,
        });
      },
    });
    watcher.watch('/proj-a');
    watcher.watch('/proj-b');
    await watcher.pollNow();
    expect(calls.sort()).toEqual(['/proj-a', '/proj-b']);
  });
});
