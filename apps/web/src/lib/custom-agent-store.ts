/**
 * Per-project custom ACP agent definitions, client-side (D1-3,
 * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §4; issue
 * #748). Mirrors `mcp-server-store.ts`'s exact CRUD pattern and rationale —
 * same `localStorage`-keyed-per-project shape, same injectable-storage
 * constructor pair (real browser default + in-memory for SSR/tests) — since
 * this is the same class of "small, per-project, device-local config" the
 * MCP server list already is. `NewSessionDialog`'s custom-agent form reads
 * and writes through this store; `RelayClient.createSession` takes the
 * resulting `CustomAgentRecordV1` verbatim as its own `customAgent` option.
 *
 * This store does no allowlist enforcement and holds no opinion about
 * whether a given `command` will actually be permitted to run — that
 * decision is `@loombox/node`'s alone (`custom-agent.ts`'s own doc
 * comment), made fresh at every session launch. A record parses and saves
 * here regardless of whether the target node's operator has allowlisted its
 * `command`; `RelayClient.probeCustomAgent` is the separate, explicit check
 * for that, run against a specific target only when a caller asks.
 *
 * `addCustomAgentFromCatalogueEntry` (issue #749) is the curated-catalogue
 * counterpart of `mcp-server-store.ts`'s own `addMcpServerFromPreset`: it
 * calls `@loombox/providers-core`'s `instantiateAgentCatalogueEntry` and
 * then this exact same `addCustomAgent`, so a catalogue pick can never
 * take a different path through this store — or a different trust
 * posture — than a hand-typed custom agent. It surfaces
 * `StaleAgentCatalogueEntryError` unchanged for a caller to show, rather
 * than swallowing it.
 */

import {
  instantiateAgentCatalogueEntry,
  type AgentCatalogueEntry,
} from '@loombox/providers-core/browser';
import { customAgentRecordV1, type CustomAgentRecordV1 } from '@loombox/protocol';

export interface CustomAgentStorage {
  get(): CustomAgentRecordV1[];
  set(records: CustomAgentRecordV1[]): void;
}

/** Thrown by {@link addCustomAgent} for a duplicate name — the one validation this store adds beyond `customAgentRecordV1`'s own schema. */
export class CustomAgentStoreError extends Error {}

function storageKey(projectPath: string): string {
  return `loombox:custom-agents:${projectPath}`;
}

/** Re-validates one raw stored record, or returns `undefined` for a corrupted entry (skipped, not thrown — a corrupted single record should degrade, never break the whole list; mirrors `mcp-server-store.ts`'s `parseStoredRecord`). */
function parseStoredRecord(raw: unknown): CustomAgentRecordV1 | undefined {
  const result = customAgentRecordV1.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** The real, `window.localStorage`-backed storage (browser + jsdom), keyed per project path. Malformed/absent stored JSON degrades to an empty list rather than throwing. */
export function createLocalStorageCustomAgentStorage(
  projectPath: string,
  storage: Storage = globalThis.localStorage,
): CustomAgentStorage {
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
          .filter((record): record is CustomAgentRecordV1 => record !== undefined);
      } catch {
        return [];
      }
    },
    set(records) {
      storage.setItem(key, JSON.stringify(records));
    },
  };
}

/** An in-memory `CustomAgentStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryCustomAgentStorage(): CustomAgentStorage {
  let current: CustomAgentRecordV1[] = [];
  return {
    get: () => current,
    set: (records) => {
      current = records;
    },
  };
}

/**
 * Adds a new custom agent record, the one path a "define an agent" form
 * calls. Throws {@link CustomAgentStoreError} if a record with the same
 * `name` already exists — `name` is what `NewSessionDialog`'s Agent picker
 * shows and keys off, so two entries sharing one label would be
 * indistinguishable in that list, exactly the "duplicate MCP server name"
 * rule `mcp-server-store.ts`'s own `addMcpServerConfig` enforces.
 */
export function addCustomAgent(
  storage: CustomAgentStorage,
  record: CustomAgentRecordV1,
): CustomAgentRecordV1[] {
  const current = storage.get();
  if (current.some((existing) => existing.name === record.name)) {
    throw new CustomAgentStoreError(
      `custom agent config: duplicate custom agent name "${record.name}"`,
    );
  }
  const next = [...current, record];
  storage.set(next);
  return next;
}

/**
 * Quick-add (issue #749): expands `entry` into a plain `CustomAgentRecordV1`
 * via `instantiateAgentCatalogueEntry` and adds it through `addCustomAgent` —
 * the identical path a hand-typed custom agent takes, including its
 * duplicate-name rule. `instantiateAgentCatalogueEntry`'s own
 * `StaleAgentCatalogueEntryError` (an entry past its verified-against
 * window) propagates unchanged; this function adds no staleness policy of
 * its own.
 */
export function addCustomAgentFromCatalogueEntry(
  storage: CustomAgentStorage,
  entry: AgentCatalogueEntry,
): CustomAgentRecordV1[] {
  return addCustomAgent(storage, instantiateAgentCatalogueEntry(entry));
}

/** Removes a custom agent record by name. A no-op if no record with that name exists. */
export function removeCustomAgent(
  storage: CustomAgentStorage,
  name: string,
): CustomAgentRecordV1[] {
  const next = storage.get().filter((record) => record.name !== name);
  storage.set(next);
  return next;
}
