/**
 * Per-project `TrackerMode`, client-side (SPEC §7.10; issue #209, made
 * node-backed by issue #631).
 *
 * **"No default silently assumed" (issue #209's actual acceptance
 * criterion) is still the whole point of this module.** Every storage this
 * file builds returns `TrackerMode | undefined`, never `TrackerMode` alone:
 * `undefined` means "this project has never had a mode chosen" (or its
 * stored value no longer re-validates against `@loombox/protocol`'s
 * `trackerMode` schema — treated the same as unset, never repaired into a
 * guess), and it is a distinct state from the explicit, persisted
 * `{ kind: 'native' }` a user can also choose. `get()` never falls back to
 * `{ kind: 'native' }` on either an absent key or a corrupted one — a
 * consumer that needs a concrete mode to proceed MUST branch on `undefined`
 * itself and prompt the user to choose, exactly as issue #212's own
 * acceptance criterion already describes.
 *
 * **Issue #631's gap, and why this file changed.** `TrackerMode` used to be
 * persisted ONLY in `localStorage` — `createLocalStorageTrackerModeStorage`
 * below, unchanged since #209 — which made a project's choice per BROWSER,
 * not per project (SPEC §7.10: a project chooses "once", not once per
 * device), and structurally invisible to the node
 * (`NodeDaemon.readTrackerSnapshotForBridge` read the native tracker store
 * unconditionally because the native store was the only thing it had). The
 * node is now the source of truth (`packages/node/src/tracker-mode-store.ts`),
 * synced over `tracker_mode_get/set_request` (`RelayClient.getTrackerMode`/
 * `setTrackerMode`). {@link createRelayTrackerModeStorage} is what real
 * callers (`TrackerPage.svelte`) construct now; the local-storage/in-memory
 * constructors survive unchanged as {@link createRelayTrackerModeStorage}'s
 * own one-shot migration source and as `TrackerConfigPanel.svelte`'s test
 * seam (`createInMemoryTrackerModeStorage`) — that component only ever
 * calls `get()`/`set()` and never needed to change.
 *
 * **The loading state is a third, real state — never collapsed into
 * "never chosen".** A sync `get()` backed by an async node round trip has
 * three states, not two: not-yet-known, never-chosen, and chosen. Before
 * the initial `tracker_mode_get_request` round trip resolves,
 * {@link RelayTrackerModeStorage.get} would have nothing better to return
 * than `undefined` — but `undefined` is ALSO what "never chosen" means, and
 * collapsing "I don't know yet" onto that is the exact guess issue #209
 * exists to prevent, one layer up. So `get()`/`set()`'s synchronous
 * `TrackerModeStorage` shape is preserved for the existing `set()`-then-
 * display callers, but {@link RelayTrackerModeStorage} ALSO implements
 * Svelte's `Readable<TrackerModeState>` store contract, whose `status`
 * carries the real three-way state a `subscribe`d caller (`TrackerPage.svelte`)
 * MUST render on: `'loading'` — render neither the setup step nor the
 * board, `'error'` — a real connectivity failure, `'loaded'` — `mode` is now
 * trustworthy, `undefined` genuinely means never chosen.
 */

import { get, writable, type Readable } from 'svelte/store';
import { safeParseTrackerMode, type TrackerMode } from '@loombox/protocol';

export interface TrackerModeStorage {
  get(): TrackerMode | undefined;
  set(mode: TrackerMode): void;
}

function storageKey(projectPath: string): string {
  return `loombox:tracker-mode:${projectPath}`;
}

/** The real, `window.localStorage`-backed storage (browser + jsdom), keyed per project path. Absent, unparsable, or schema-invalid stored data all degrade to `undefined` rather than throwing or coercing to a default. */
export function createLocalStorageTrackerModeStorage(
  projectPath: string,
  storage: Storage = globalThis.localStorage,
): TrackerModeStorage {
  const key = storageKey(projectPath);
  return {
    get() {
      const raw = storage.getItem(key);
      if (!raw) return undefined;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return undefined;
      }
      const result = safeParseTrackerMode(parsedJson);
      return result.success ? result.data : undefined;
    },
    set(mode) {
      storage.setItem(key, JSON.stringify(mode));
    },
  };
}

/** An in-memory `TrackerModeStorage` — SSR (no `localStorage`) and hermetic tests. Starts unset, exactly like a project that has never had a mode chosen. */
export function createInMemoryTrackerModeStorage(): TrackerModeStorage {
  let current: TrackerMode | undefined;
  return {
    get: () => current,
    set: (mode) => {
      current = mode;
    },
  };
}

/*
 * ---------------------------------------------------------------------------
 * Node-backed storage (issue #631)
 * ---------------------------------------------------------------------------
 */

/** The narrow slice of `RelayClient` {@link createRelayTrackerModeStorage} needs — mirrors `TrackerPageClient`'s own narrow-client convention (`TrackerPage.svelte`) so a test injects a plain fake with no WebSocket/crypto machinery. `RelayClient.getTrackerMode`/`setTrackerMode` already satisfy this structurally. */
export interface TrackerModeClient {
  getTrackerMode(nodeId: string, projectPath: string): Promise<TrackerMode | undefined>;
  setTrackerMode(
    nodeId: string,
    projectPath: string,
    mode: TrackerMode,
  ): Promise<TrackerMode | undefined>;
}

/**
 * `projectPath`'s tracker mode as {@link createRelayTrackerModeStorage}
 * currently knows it — mirrors `TrackerSnapshotState`/`FileTreeDirectoryState`
 * (`relay-client.ts`) field-for-field: `status` is the real tri-state this
 * module's own doc comment describes, `mode` is the payload (present at
 * every status, `undefined` both while `'loading'` and once genuinely
 * confirmed unset), and an `'error'` keeps whichever `mode` it last had
 * rather than resetting to `undefined`, so a retry never has to
 * special-case anything.
 */
export interface TrackerModeState {
  status: 'loading' | 'loaded' | 'error';
  mode: TrackerMode | undefined;
  error?: string;
}

/** {@link createRelayTrackerModeStorage}'s return shape: the synchronous `TrackerModeStorage` contract every existing caller (`TrackerConfigPanel.svelte`) already relies on, PLUS the `Readable<TrackerModeState>` store contract a caller that must never flash "never chosen" during load (`TrackerPage.svelte`) subscribes to instead. `get()` is safe to call once `status !== 'loading'` — the exact condition a `subscribe`r already has to gate rendering on regardless. */
export interface RelayTrackerModeStorage extends TrackerModeStorage, Readable<TrackerModeState> {
  /** Re-runs the initial load (get + one-shot migration) — the same escape hatch `RelayClient.reloadTrackerSnapshot` gives a failed tracker snapshot's Retry button. */
  reload(): void;
}

/**
 * Builds a node-backed {@link RelayTrackerModeStorage} for `projectPath` on
 * `nodeId` — what `TrackerPage.svelte` actually constructs now (issue
 * #631), replacing its direct `createLocalStorageTrackerModeStorage` call.
 *
 * **One-shot migration, on the first load only, node always wins.** A mode
 * already saved in `localStorage` (from before this issue) must not be
 * silently lost, but the node is the one true answer once it has spoken:
 * - node has a mode → that mode wins outright; any local echo is cleared
 *   (a `removeItem` on an already-absent key is a harmless no-op, so this
 *   covers both "node-only" and "both saved" without a separate branch).
 * - node has none, local has a valid one → pushed up via `setTrackerMode`,
 *   then the local key is cleared — but only once the push actually
 *   succeeds; a failed push leaves the local key alone so a later retry can
 *   still migrate it, rather than losing the only copy of the user's choice.
 * - neither has one → stays `undefined`, exactly like a fresh project.
 */
export function createRelayTrackerModeStorage(
  client: TrackerModeClient,
  nodeId: string,
  projectPath: string,
  localStorage: Storage = globalThis.localStorage,
): RelayTrackerModeStorage {
  const store = writable<TrackerModeState>({ status: 'loading', mode: undefined });
  const local = createLocalStorageTrackerModeStorage(projectPath, localStorage);

  async function load(): Promise<void> {
    store.set({ status: 'loading', mode: get(store).mode });
    try {
      const nodeMode = await client.getTrackerMode(nodeId, projectPath);
      if (nodeMode !== undefined) {
        localStorage.removeItem(storageKey(projectPath));
        store.set({ status: 'loaded', mode: nodeMode });
        return;
      }
      const localMode = local.get();
      if (localMode === undefined) {
        store.set({ status: 'loaded', mode: undefined });
        return;
      }
      const migrated = await client.setTrackerMode(nodeId, projectPath, localMode);
      localStorage.removeItem(storageKey(projectPath));
      store.set({ status: 'loaded', mode: migrated ?? localMode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.set({ status: 'error', mode: get(store).mode, error: message });
    }
  }

  void load();

  return {
    subscribe: store.subscribe,
    reload: () => void load(),
    get: () => {
      const state = get(store);
      return state.status === 'loaded' ? state.mode : undefined;
    },
    set: (mode) => {
      void client.setTrackerMode(nodeId, projectPath, mode).then(
        (resolved) => store.set({ status: 'loaded', mode: resolved ?? mode }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          store.set({ status: 'error', mode: get(store).mode, error: message });
        },
      );
    },
  };
}
