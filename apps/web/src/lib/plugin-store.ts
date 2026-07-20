/**
 * Per-project agent plugin/extension config, client-side (SPEC.md §7.7;
 * issue #191). Same shape and rationale as `mcp-server-store.ts`, but a
 * genuinely separate store, keyed under its own `localStorage` key and
 * operating on `@loombox/providers-core`'s `PluginConfig`/
 * `PluginConfigRecord` types — never the MCP-server ones. This is what
 * keeps the plugin list "viewable/addable/removable independently of the
 * MCP-server list" (issue #191's first acceptance bullet) true on the web
 * client, not just in the provider package: there is no shared map, no
 * shared storage key, and no code path that reads or writes both lists at
 * once.
 *
 * See `@loombox/providers-core`'s `plugin-config.ts` module doc for what a
 * "plugin" concretely means (or doesn't yet) for Claude Code/Codex at v1 —
 * this module is purely the client-side CRUD/storage layer over that data
 * model, same as `mcp-server-store.ts` is for MCP servers.
 */

import {
  PluginConfigError,
  parsePluginConfig,
  type PluginConfig,
  type PluginConfigRecord,
} from '@loombox/providers-core';

export interface PluginConfigStorage {
  get(): PluginConfigRecord[];
  set(records: PluginConfigRecord[]): void;
}

function storageKey(projectPath: string): string {
  return `loombox:plugins:${projectPath}`;
}

function parseStoredRecord(raw: unknown): PluginConfigRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as { config?: unknown; enabled?: unknown };
  try {
    const config = parsePluginConfig(candidate.config);
    return { config, enabled: Boolean(candidate.enabled) };
  } catch {
    return undefined;
  }
}

/** The real, `window.localStorage`-backed storage (browser + jsdom), keyed per project path. Malformed/absent stored JSON degrades to an empty list rather than throwing. */
export function createLocalStoragePluginConfigStorage(
  projectPath: string,
  storage: Storage = globalThis.localStorage,
): PluginConfigStorage {
  const key = storageKey(projectPath);
  return {
    get() {
      const raw = storage.getItem(key);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((entry) => parseStoredRecord(entry))
          .filter((record): record is PluginConfigRecord => record !== undefined);
      } catch {
        return [];
      }
    },
    set(records) {
      storage.setItem(key, JSON.stringify(records));
    },
  };
}

/** An in-memory `PluginConfigStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryPluginConfigStorage(): PluginConfigStorage {
  let current: PluginConfigRecord[] = [];
  return {
    get: () => current,
    set: (records) => {
      current = records;
    },
  };
}

/** Adds a new plugin config record (enabled by default). Throws `PluginConfigError` if a plugin with the same name already exists. */
export function addPluginConfig(
  storage: PluginConfigStorage,
  config: PluginConfig,
): PluginConfigRecord[] {
  const current = storage.get();
  if (current.some((record) => record.config.name === config.name)) {
    throw new PluginConfigError(`Plugin config: duplicate plugin name "${config.name}"`);
  }
  const next = [...current, { config, enabled: true }];
  storage.set(next);
  return next;
}

/** Removes a plugin config record by name. A no-op if no plugin with that name exists. */
export function removePluginConfig(
  storage: PluginConfigStorage,
  name: string,
): PluginConfigRecord[] {
  const next = storage.get().filter((record) => record.config.name !== name);
  storage.set(next);
  return next;
}

/** Enables or disables a plugin config record by name, without altering its declared config. A no-op if no plugin with that name exists. */
export function setPluginEnabled(
  storage: PluginConfigStorage,
  name: string,
  enabled: boolean,
): PluginConfigRecord[] {
  const next = storage
    .get()
    .map((record) => (record.config.name === name ? { ...record, enabled } : record));
  storage.set(next);
  return next;
}
