/**
 * Project-scoped config-option overrides — decision D4-3 of the Zed-parity
 * review (`docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §4,
 * issue #753): "a project-scoped override beats the account-wide
 * last-used value when both exist". Same per-agent, per-category value
 * shape `config-option-defaults.ts` remembers account-wide
 * (`RememberedConfigOptionValues`), but keyed per project path, paired
 * with the project's own MCP config, which is already stored this way
 * (`mcp-server-store.ts:44`) — same injectable-storage convention, same
 * per-project `localStorage` key shape, same real/in-memory factory pair.
 *
 * Pure CRUD, no resolution logic of its own: `resolveConfigOptionDefaults`
 * (`config-option-resolution.ts`) is what actually makes an override here
 * beat the account-wide value for the same category, and what drops one
 * the agent no longer offers rather than sending it (issue #718) — same
 * split `mcp-server-store.ts` draws between storage and
 * `McpServerConfigPanel.svelte`'s own consuming logic.
 *
 * Unlike the account-wide defaults, which are rewritten on every live
 * config-option change (`rememberConfigOptionValues`), a project override
 * only ever changes through `setConfigOptionOverride`/
 * `clearConfigOptionOverride` — `ConfigBar`'s explicit "pin to
 * project"/"unpin" action. It is deliberately a pin, not an ambient side
 * effect of picking a value while working in that project: pinning is
 * the one place D4-3's whole "two places to look" cost is opted into on
 * purpose, not incurred by accident.
 */

import type { RememberedConfigOptionValues } from './config-option-defaults';

export type { RememberedConfigOptionValues };

export interface ConfigOptionOverrideStorage {
  get(): Record<string /* providerId */, RememberedConfigOptionValues>;
  set(value: Record<string, RememberedConfigOptionValues>): void;
}

function storageKey(projectPath: string): string {
  return `loombox:config-option-overrides:${projectPath}`;
}

function isRememberedConfigOptionValues(value: unknown): value is RememberedConfigOptionValues {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/** Re-validates a raw parsed blob into `{providerId: {category: optionId}}`, dropping any provider entry that isn't a flat string map rather than discarding the whole store. */
function parseStoredOverrides(raw: unknown): Record<string, RememberedConfigOptionValues> {
  if (typeof raw !== 'object' || raw === null) return {};
  const result: Record<string, RememberedConfigOptionValues> = {};
  for (const [providerId, values] of Object.entries(raw as Record<string, unknown>)) {
    if (isRememberedConfigOptionValues(values)) result[providerId] = values;
  }
  return result;
}

/** The real, `window.localStorage`-backed storage (browser + jsdom), keyed per project path. Malformed/absent stored JSON degrades to no overrides rather than throwing. */
export function createLocalStorageConfigOptionOverrideStorage(
  projectPath: string,
  storage: Storage = globalThis.localStorage,
): ConfigOptionOverrideStorage {
  const key = storageKey(projectPath);
  return {
    get() {
      const raw = storage.getItem(key);
      if (!raw) return {};
      try {
        return parseStoredOverrides(JSON.parse(raw) as unknown);
      } catch {
        return {};
      }
    },
    set(value) {
      storage.setItem(key, JSON.stringify(value));
    },
  };
}

/** An in-memory `ConfigOptionOverrideStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryConfigOptionOverrideStorage(): ConfigOptionOverrideStorage {
  let current: Record<string, RememberedConfigOptionValues> = {};
  return {
    get: () => current,
    set: (value) => {
      current = value;
    },
  };
}

/** `providerId`'s project override, `{}` if none is pinned yet. */
export function configOptionOverridesFor(
  storage: ConfigOptionOverrideStorage,
  providerId: string,
): RememberedConfigOptionValues {
  return storage.get()[providerId] ?? {};
}

/** Pins `category`'s value as `providerId`'s project override — `ConfigBar`'s explicit "pin to project" action (see the file doc comment for why this is opt-in, not automatic). */
export function setConfigOptionOverride(
  storage: ConfigOptionOverrideStorage,
  providerId: string,
  category: string,
  optionId: string,
): void {
  const all = storage.get();
  const forProvider = { ...(all[providerId] ?? {}), [category]: optionId };
  storage.set({ ...all, [providerId]: forProvider });
}

/** Clears `category`'s project override for `providerId`, falling back to the account default or the agent's own. A no-op if nothing was pinned for that category. */
export function clearConfigOptionOverride(
  storage: ConfigOptionOverrideStorage,
  providerId: string,
  category: string,
): void {
  const all = storage.get();
  const forProvider = { ...(all[providerId] ?? {}) };
  if (!(category in forProvider)) return;
  delete forProvider[category];
  storage.set({ ...all, [providerId]: forProvider });
}
