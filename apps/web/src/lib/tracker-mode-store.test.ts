import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { TrackerMode } from '@loombox/protocol';
import {
  createInMemoryTrackerModeStorage,
  createLocalStorageTrackerModeStorage,
  createRelayTrackerModeStorage,
  type RelayTrackerModeStorage,
  type TrackerModeClient,
  type TrackerModeState,
} from './tracker-mode-store';

const nativeMode = { kind: 'native' } satisfies TrackerMode;
const githubMode = {
  kind: 'live',
  provider: 'github',
  connectionId: 'conn_1',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
} satisfies TrackerMode;
const jiraMode = {
  kind: 'live',
  provider: 'jira',
  connectionId: 'conn_2',
  target: { cloudId: 'abc-123', projectKey: 'LB' },
} satisfies TrackerMode;

function fakeLocalStorage(): Storage {
  const memory = new Map<string, string>();
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe('tracker-mode-store (issue #209)', () => {
  it('starts unset — no default silently assumed', () => {
    const storage = createInMemoryTrackerModeStorage();
    expect(storage.get()).toBeUndefined();
  });

  it('in-memory storage round-trips native mode', () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set(nativeMode);
    expect(storage.get()).toEqual(nativeMode);
  });

  it('in-memory storage round-trips a live GitHub mode', () => {
    const storage = createInMemoryTrackerModeStorage();
    storage.set(githubMode);
    expect(storage.get()).toEqual(githubMode);
  });

  it('createLocalStorageTrackerModeStorage persists across a fresh storage handle for the same project (localStorage-like round trip)', () => {
    const backing = fakeLocalStorage();

    const first = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    first.set(jiraMode);

    const second = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    expect(second.get()).toEqual(jiraMode);
  });

  it('createLocalStorageTrackerModeStorage returns undefined for a project that has never had a mode set', () => {
    const backing = fakeLocalStorage();
    const storage = createLocalStorageTrackerModeStorage('/home/user/never-configured', backing);
    expect(storage.get()).toBeUndefined();
  });

  it('createLocalStorageTrackerModeStorage scopes storage per project path', () => {
    const backing = fakeLocalStorage();

    const projectA = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    projectA.set(nativeMode);

    const projectB = createLocalStorageTrackerModeStorage('/home/user/project-b', backing);
    expect(projectB.get()).toBeUndefined();
  });

  it('degrades unparsable stored JSON to undefined rather than throwing or defaulting to native', () => {
    const backing = fakeLocalStorage();
    backing.setItem('loombox:tracker-mode:/home/user/project-a', 'not json{{{');

    const storage = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    expect(storage.get()).toBeUndefined();
  });

  it('degrades a schema-invalid stored value to undefined rather than coercing it to native', () => {
    const backing = fakeLocalStorage();
    backing.setItem(
      'loombox:tracker-mode:/home/user/project-a',
      JSON.stringify({
        kind: 'live',
        provider: 'jira',
        connectionId: 'c1',
        target: { owner: 'a', repo: 'b' },
      }),
    );

    const storage = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    expect(storage.get()).toBeUndefined();
  });

  it('overwriting a stored mode replaces it, not merges it', () => {
    const backing = fakeLocalStorage();
    const storage = createLocalStorageTrackerModeStorage('/home/user/project-a', backing);
    storage.set(githubMode);
    storage.set(nativeMode);
    expect(storage.get()).toEqual(nativeMode);
  });
});

const PROJECT_PATH = '/home/user/project-a';
const NODE_ID = 'node-1';

/** A fake `TrackerModeClient` backed by an in-memory map keyed only by `projectPath` — simulates one node's own `TrackerModeStore` shared across every `createRelayTrackerModeStorage` instance constructed against it, which is exactly what "another device" means at this layer (a fresh storage instance talking to the same node). */
function fakeTrackerModeClient(seed: Record<string, TrackerMode> = {}): TrackerModeClient {
  const saved = new Map(Object.entries(seed));
  return {
    getTrackerMode: async (_nodeId, projectPath) => saved.get(projectPath),
    setTrackerMode: async (_nodeId, projectPath, mode) => {
      saved.set(projectPath, mode);
      return mode;
    },
  };
}

function rejectingTrackerModeClient(message: string): TrackerModeClient {
  return {
    getTrackerMode: async () => {
      throw new Error(message);
    },
    setTrackerMode: async () => {
      throw new Error(message);
    },
  };
}

/** Awaits the FIRST `TrackerModeState` a `RelayTrackerModeStorage` emits AFTER the synchronous `'loading'` value every subscriber's own first callback always sees (Svelte's store contract replays the current value synchronously on `subscribe`, and construction always sets `'loading'` before any `await` — real events, not a timer) — i.e. the settled result of whichever load/reload/set is already in flight. */
function waitForNextState(storage: RelayTrackerModeStorage): Promise<TrackerModeState> {
  const { promise, resolve } = Promise.withResolvers<TrackerModeState>();
  let skippedInitial = false;
  const unsubscribe = storage.subscribe((state) => {
    if (!skippedInitial) {
      skippedInitial = true;
      return;
    }
    unsubscribe();
    resolve(state);
  });
  return promise;
}

describe('createRelayTrackerModeStorage (issue #631)', () => {
  it('reports a real "loading" status before the node round trip resolves — never collapsed into "never chosen" one layer up', () => {
    const pending = Promise.withResolvers<never>();
    const client: TrackerModeClient = {
      getTrackerMode: () => pending.promise,
      setTrackerMode: () => pending.promise,
    };
    const storage = createRelayTrackerModeStorage(
      client,
      NODE_ID,
      PROJECT_PATH,
      fakeLocalStorage(),
    );
    expect(get(storage)).toEqual({ status: 'loading', mode: undefined });
    // The sync accessor still degrades safely rather than throwing, but a
    // caller MUST gate on `status` (via `subscribe`) before trusting this —
    // exactly what `TrackerPage.svelte`'s own `trackerModeStatus` does.
    expect(storage.get()).toBeUndefined();
  });

  it('node-only: a mode already saved on the node is used as-is, no migration push, local storage untouched', async () => {
    const client = fakeTrackerModeClient({ [PROJECT_PATH]: githubMode });
    const setSpy = vi.spyOn(client, 'setTrackerMode');
    const backing = fakeLocalStorage();
    const storage = createRelayTrackerModeStorage(client, NODE_ID, PROJECT_PATH, backing);

    const state = await waitForNextState(storage);
    expect(state).toEqual({ status: 'loaded', mode: githubMode });
    expect(storage.get()).toEqual(githubMode);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('local-only: a mode saved only in localStorage is pushed to the node, then the local key is cleared', async () => {
    const backing = fakeLocalStorage();
    createLocalStorageTrackerModeStorage(PROJECT_PATH, backing).set(githubMode);
    const client = fakeTrackerModeClient();

    const storage = createRelayTrackerModeStorage(client, NODE_ID, PROJECT_PATH, backing);
    const state = await waitForNextState(storage);

    expect(state).toEqual({ status: 'loaded', mode: githubMode });
    expect(createLocalStorageTrackerModeStorage(PROJECT_PATH, backing).get()).toBeUndefined();
    // The push actually reached the node, not just the local UI state.
    expect(await client.getTrackerMode(NODE_ID, PROJECT_PATH)).toEqual(githubMode);
  });

  it('both present: the node mode wins outright, no push, and the local key is still cleared', async () => {
    const backing = fakeLocalStorage();
    createLocalStorageTrackerModeStorage(PROJECT_PATH, backing).set(githubMode);
    const client = fakeTrackerModeClient({ [PROJECT_PATH]: nativeMode });
    const setSpy = vi.spyOn(client, 'setTrackerMode');

    const storage = createRelayTrackerModeStorage(client, NODE_ID, PROJECT_PATH, backing);
    const state = await waitForNextState(storage);

    expect(state).toEqual({ status: 'loaded', mode: nativeMode });
    expect(setSpy).not.toHaveBeenCalled();
    expect(createLocalStorageTrackerModeStorage(PROJECT_PATH, backing).get()).toBeUndefined();
  });

  it('neither present: stays undefined, exactly like a fresh project', async () => {
    const client = fakeTrackerModeClient();
    const storage = createRelayTrackerModeStorage(
      client,
      NODE_ID,
      PROJECT_PATH,
      fakeLocalStorage(),
    );
    const state = await waitForNextState(storage);
    expect(state).toEqual({ status: 'loaded', mode: undefined });
  });

  it('a mode set through one storage instance is visible from a fresh instance against the same node ("another device"), even with no shared local storage', async () => {
    const client = fakeTrackerModeClient();
    const deviceA = createRelayTrackerModeStorage(
      client,
      NODE_ID,
      PROJECT_PATH,
      fakeLocalStorage(),
    );
    await waitForNextState(deviceA); // initial load: nothing saved yet.

    deviceA.set(jiraMode);
    const afterSet = await waitForNextState(deviceA);
    expect(afterSet).toEqual({ status: 'loaded', mode: jiraMode });

    const deviceB = createRelayTrackerModeStorage(
      client,
      NODE_ID,
      PROJECT_PATH,
      fakeLocalStorage(),
    );
    const deviceBState = await waitForNextState(deviceB);
    expect(deviceBState).toEqual({ status: 'loaded', mode: jiraMode });
  });

  it('a failed initial load surfaces as an explicit error state, never a silent undefined/native guess presented as success', async () => {
    const client = rejectingTrackerModeClient('relay unreachable');
    const storage = createRelayTrackerModeStorage(
      client,
      NODE_ID,
      PROJECT_PATH,
      fakeLocalStorage(),
    );
    const state = await waitForNextState(storage);
    expect(state.status).toBe('error');
    expect(state.error).toContain('relay unreachable');
    expect(storage.get()).toBeUndefined();
  });

  it('a failed migration push leaves the local key intact so a later reload can still migrate it', async () => {
    const backing = fakeLocalStorage();
    createLocalStorageTrackerModeStorage(PROJECT_PATH, backing).set(githubMode);
    const client: TrackerModeClient = {
      getTrackerMode: async () => undefined,
      setTrackerMode: async () => {
        throw new Error('push failed');
      },
    };
    const storage = createRelayTrackerModeStorage(client, NODE_ID, PROJECT_PATH, backing);
    const state = await waitForNextState(storage);
    expect(state.status).toBe('error');
    expect(createLocalStorageTrackerModeStorage(PROJECT_PATH, backing).get()).toEqual(githubMode);
  });

  it('reload() re-runs the load, recovering from a prior error once the node answers', async () => {
    let shouldFail = true;
    const client: TrackerModeClient = {
      getTrackerMode: async () => {
        if (shouldFail) throw new Error('temporarily unreachable');
        return nativeMode;
      },
      setTrackerMode: async (_nodeId, _projectPath, mode) => mode,
    };
    const storage = createRelayTrackerModeStorage(
      client,
      NODE_ID,
      PROJECT_PATH,
      fakeLocalStorage(),
    );
    const errored = await waitForNextState(storage);
    expect(errored.status).toBe('error');

    shouldFail = false;
    storage.reload();
    const recovered = await waitForNextState(storage);
    expect(recovered).toEqual({ status: 'loaded', mode: nativeMode });
  });
});
