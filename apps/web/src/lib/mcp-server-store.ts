/**
 * Per-project MCP server config, client-side (SPEC.md §7.7; issue #188).
 * Scoped to this device's local storage for this wave, same rationale and
 * same injectable-storage pattern as `notification-preferences.ts`: the
 * relay-backed, account-wide sync of this config is out of scope here, and
 * every real browser API this module touches (`localStorage`) is a
 * constructor parameter with a real-browser default, so it's unit-testable
 * in the `node` vitest environment without jsdom.
 *
 * This module is a thin CRUD layer over `@loombox/providers-core`'s
 * `McpServerConfig`/`McpServerConfigRecord` data model — it does no
 * validation of its own beyond what `parseMcpServerConfig` already does,
 * and `addMcpServerFromPreset` is the one place issue #188 actually lives:
 * it calls `instantiateMcpPreset` and then the exact same `addMcpServerConfig`
 * a manual "add server" form calls, so a preset can never take a different
 * path through this store than a hand-entered one.
 *
 * Secret handling: a server's `env`/`headers` can name a required secret
 * (`McpServerVarDecl`'s `{ name, secret }` arm) but this store never holds
 * a secret *value* — resolving a secret into the value an ACP session
 * actually uses is a node-local concern (`McpSecretGrantStore`,
 * `resolveMcpServerConfigs`, both in `@loombox/providers-core`), out of
 * scope for this client-side config surface. `requiredSecretNames` below
 * is only for the UI to show which secrets a given server still needs
 * granted somewhere downstream — it never pre-fills or fabricates a value.
 */

import {
  McpServerConfigError,
  parseMcpServerConfig,
  requiredSecrets,
  type McpServerConfig,
  type McpServerConfigRecord,
} from '@loombox/providers-core';
import type { McpServerPreset } from '@loombox/providers-core';
import { instantiateMcpPreset } from '@loombox/providers-core';

export interface McpServerConfigStorage {
  get(): McpServerConfigRecord[];
  set(records: McpServerConfigRecord[]): void;
}

function storageKey(projectPath: string): string {
  return `loombox:mcp-servers:${projectPath}`;
}

/** Re-validates one raw stored record, or returns `undefined` for a corrupted entry (skipped, not thrown — a corrupted single record should degrade, never break the whole list). */
function parseStoredRecord(raw: unknown): McpServerConfigRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as { config?: unknown; enabled?: unknown };
  try {
    const config = parseMcpServerConfig(candidate.config);
    return { config, enabled: Boolean(candidate.enabled) };
  } catch {
    return undefined;
  }
}

/** The real, `window.localStorage`-backed storage (browser + jsdom), keyed per project path. Malformed/absent stored JSON degrades to an empty list rather than throwing. */
export function createLocalStorageMcpServerConfigStorage(
  projectPath: string,
  storage: Storage = globalThis.localStorage,
): McpServerConfigStorage {
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
          .filter((record): record is McpServerConfigRecord => record !== undefined);
      } catch {
        return [];
      }
    },
    set(records) {
      storage.setItem(key, JSON.stringify(records));
    },
  };
}

/** An in-memory `McpServerConfigStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryMcpServerConfigStorage(): McpServerConfigStorage {
  let current: McpServerConfigRecord[] = [];
  return {
    get: () => current,
    set: (records) => {
      current = records;
    },
  };
}

/**
 * Adds a new server config record (enabled by default), the one path both
 * a manual "add server" form and `addMcpServerFromPreset` call. Throws
 * `McpServerConfigError` if a server with the same name already exists —
 * the same duplicate-name rule `parseMcpServerConfigList` enforces on a
 * whole list.
 */
export function addMcpServerConfig(
  storage: McpServerConfigStorage,
  config: McpServerConfig,
): McpServerConfigRecord[] {
  const current = storage.get();
  if (current.some((record) => record.config.name === config.name)) {
    throw new McpServerConfigError(`MCP server config: duplicate MCP server name "${config.name}"`);
  }
  const next = [...current, { config, enabled: true }];
  storage.set(next);
  return next;
}

/**
 * Quick-add (issue #188): expands `preset` into a plain `McpServerConfig`
 * via `instantiateMcpPreset` and adds it through `addMcpServerConfig` —
 * the identical path a manually entered server takes. There is no
 * preset-specific branch here; this function exists only so a caller
 * doesn't have to remember to call `instantiateMcpPreset` itself.
 */
export function addMcpServerFromPreset(
  storage: McpServerConfigStorage,
  preset: McpServerPreset,
): McpServerConfigRecord[] {
  return addMcpServerConfig(storage, instantiateMcpPreset(preset));
}

/** Removes a server config record by name. A no-op if no server with that name exists. */
export function removeMcpServerConfig(
  storage: McpServerConfigStorage,
  name: string,
): McpServerConfigRecord[] {
  const next = storage.get().filter((record) => record.config.name !== name);
  storage.set(next);
  return next;
}

/** Enables or disables a server config record by name, without altering its declared config. A no-op if no server with that name exists. */
export function setMcpServerEnabled(
  storage: McpServerConfigStorage,
  name: string,
  enabled: boolean,
): McpServerConfigRecord[] {
  const next = storage
    .get()
    .map((record) => (record.config.name === name ? { ...record, enabled } : record));
  storage.set(next);
  return next;
}

/** The distinct required-secret names a server config declares — for the UI to surface "needs a secret" (never a value; see module doc). */
export function requiredSecretNames(config: McpServerConfig): string[] {
  return requiredSecrets(config);
}
