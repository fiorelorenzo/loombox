/**
 * Remembers the last-used config-option value per category, per agent
 * (provider id), across sessions — decision D4-2/D4-3 of the Zed-parity
 * review (`docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §4,
 * issue #753). `ConfigOptionStore` (`config-options.ts`) keeps exactly one
 * option list per LIVE session, dropped the moment it closes — there is no
 * persistence layer between sessions today, so every session starts back
 * at the agent's own defaults even when the same agent was just asked for
 * "Opus, high effort" five sessions in a row. This module is that
 * persistence layer's account-wide half.
 *
 * Scoped to this device's local storage, one un-parameterized key holding
 * every provider's remembered values together — the design doc's own
 * words: "written the way `accent.ts` already writes a single
 * account-scoped preference (the same pattern v8's B2-1 picked for the
 * thought-collapse toggle)". That is deliberately the OPPOSITE scope from
 * `config-option-overrides.ts`'s project-scoped override (D4-3), which
 * layers on top and wins when both exist — see
 * `config-option-resolution.ts`'s `resolveConfigOptionDefaults`. Unlike
 * `accent.ts` itself (a Svelte `writable` applied once at app boot), this
 * is a plain injectable-storage module in `mcp-server-store.ts`'s shape:
 * it is read from a session-creation code path
 * (`+page.svelte`'s `applyRememberedConfigOptions`) and written from a
 * live config-option change, neither of which is "apply once at startup."
 *
 * A value remembered here for a category the agent no longer offers is
 * still returned as-is by `rememberedConfigOptionsFor` — this module does
 * no catalog-aware filtering of its own. It is
 * `config-option-resolution.ts`'s `resolveConfigOptionDefaults` that
 * checks the CURRENT catalog's `choices` and drops anything unrecognized
 * before it would ever reach `RelayClient.setConfigOption` (issue #718:
 * the agent rejects an unsupported value, so one must never be sent).
 */

export type RememberedConfigOptionValues = Record<string /* category */, string /* optionId */>;

export interface ConfigOptionDefaultsStorage {
  get(): Record<string /* providerId */, RememberedConfigOptionValues>;
  set(value: Record<string, RememberedConfigOptionValues>): void;
}

const STORAGE_KEY = 'loombox:config-option-defaults';

function isRememberedConfigOptionValues(value: unknown): value is RememberedConfigOptionValues {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/** Re-validates a raw parsed blob into `{providerId: {category: optionId}}`, dropping any provider entry that isn't a flat string map rather than discarding the whole store — one corrupted provider should degrade, never take every other agent's remembered values with it. */
function parseStoredDefaults(raw: unknown): Record<string, RememberedConfigOptionValues> {
  if (typeof raw !== 'object' || raw === null) return {};
  const result: Record<string, RememberedConfigOptionValues> = {};
  for (const [providerId, values] of Object.entries(raw as Record<string, unknown>)) {
    if (isRememberedConfigOptionValues(values)) result[providerId] = values;
  }
  return result;
}

/** The real, `window.localStorage`-backed storage (browser + jsdom). Malformed/absent stored JSON degrades to "nothing remembered yet" rather than throwing. */
export function createLocalStorageConfigOptionDefaultsStorage(
  storage: Storage = globalThis.localStorage,
): ConfigOptionDefaultsStorage {
  return {
    get() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return {};
      try {
        return parseStoredDefaults(JSON.parse(raw) as unknown);
      } catch {
        return {};
      }
    },
    set(value) {
      storage.setItem(STORAGE_KEY, JSON.stringify(value));
    },
  };
}

/** An in-memory `ConfigOptionDefaultsStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryConfigOptionDefaultsStorage(): ConfigOptionDefaultsStorage {
  let current: Record<string, RememberedConfigOptionValues> = {};
  return {
    get: () => current,
    set: (value) => {
      current = value;
    },
  };
}

/** `providerId`'s remembered values, `{}` if none are stored yet. */
export function rememberedConfigOptionsFor(
  storage: ConfigOptionDefaultsStorage,
  providerId: string,
): RememberedConfigOptionValues {
  return storage.get()[providerId] ?? {};
}

/**
 * Records the CURRENT selection of every category in `options` as
 * `providerId`'s new last-used values, one merged write rather than one
 * per category. Called every time a session's live config-option catalog
 * changes (`+page.svelte`'s `selectSession`), so "last used" always
 * mirrors whatever this agent is actually configured with right now — a
 * freshly reopened old session re-becomes the account's own "last used"
 * simply by being looked at again, the same way Zed's own
 * `default_config_options` tracks whichever thread you last touched. A
 * category with no `current` selection yet is skipped, never written as
 * `undefined`.
 */
export function rememberConfigOptionValues(
  storage: ConfigOptionDefaultsStorage,
  providerId: string,
  options: readonly { category: string; current: string | undefined }[],
): void {
  const defined = options.filter(
    (option): option is { category: string; current: string } => option.current !== undefined,
  );
  if (defined.length === 0) return;
  const all = storage.get();
  const forProvider = { ...(all[providerId] ?? {}) };
  for (const option of defined) forProvider[option.category] = option.current;
  storage.set({ ...all, [providerId]: forProvider });
}
