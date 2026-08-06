/**
 * Per-project declared env-var injection, client-side (SPEC.md §7.17, §8;
 * issue #258). Scoped to this device's local storage, same rationale and
 * same injectable-storage pattern `mcp-server-store.ts` already uses for
 * its own per-project list: the relay-backed, account-wide sync of this
 * config is out of scope here, and the one real browser API this module
 * touches (`localStorage`) is a constructor parameter with a real-browser
 * default, so it's unit-testable in the `node` vitest environment without
 * jsdom.
 *
 * This module is a thin CRUD layer over `@loombox/providers-core`'s
 * `ProjectEnvVarDecl` — it does no validation of its own beyond what
 * `parseProjectEnvVarDecl` already does. Unlike `mcp-server-store.ts`'s
 * `McpServerConfigRecord` (config + enabled), a declared env var has no
 * separate enable/disable state: it either names an env var the agent
 * process should get, or it's removed outright.
 *
 * Secret handling: a decl can name a required secret
 * (`ProjectEnvVarDecl`'s `{ name, secret }` arm) but this store never
 * holds a secret *value* — resolving a secret into the value the spawned
 * agent process actually gets is a node-local concern
 * (`NodeProjectEnvManager`, `@loombox/node`), out of scope for this
 * client-side config surface. `requiredSecretName` below is only for the
 * UI to show which secret a given decl still needs granted downstream —
 * it never pre-fills or fabricates a value.
 */

import {
  ProjectEnvDeclError,
  parseProjectEnvVarDecl,
  type ProjectEnvVarDecl,
} from '@loombox/providers-core/browser';

export interface ProjectEnvDeclStorage {
  get(): ProjectEnvVarDecl[];
  set(decls: ProjectEnvVarDecl[]): void;
}

function storageKey(projectPath: string): string {
  return `loombox:project-env:${projectPath}`;
}

/** Re-validates one raw stored decl, or returns `undefined` for a corrupted entry (skipped, not thrown — a corrupted single entry should degrade, never break the whole list). */
function parseStoredDecl(raw: unknown): ProjectEnvVarDecl | undefined {
  try {
    return parseProjectEnvVarDecl(raw);
  } catch {
    return undefined;
  }
}

/** The real, `window.localStorage`-backed storage (browser + jsdom), keyed per project path. Malformed/absent stored JSON degrades to an empty list rather than throwing. */
export function createLocalStorageProjectEnvStorage(
  projectPath: string,
  storage: Storage = globalThis.localStorage,
): ProjectEnvDeclStorage {
  const key = storageKey(projectPath);
  return {
    get() {
      const raw = storage.getItem(key);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((entry) => parseStoredDecl(entry))
          .filter((decl): decl is ProjectEnvVarDecl => decl !== undefined);
      } catch {
        return [];
      }
    },
    set(decls) {
      storage.setItem(key, JSON.stringify(decls));
    },
  };
}

/** An in-memory `ProjectEnvDeclStorage` — SSR (no `localStorage`) and hermetic tests. */
export function createInMemoryProjectEnvStorage(): ProjectEnvDeclStorage {
  let current: ProjectEnvVarDecl[] = [];
  return {
    get: () => current,
    set: (decls) => {
      current = decls;
    },
  };
}

/**
 * Adds a new declared env var. Throws `ProjectEnvDeclError` if a decl with
 * the same `name` already exists — the same duplicate-name rule
 * `parseProjectEnvVarDeclList` enforces on a whole list.
 */
export function addProjectEnvVarDecl(
  storage: ProjectEnvDeclStorage,
  decl: ProjectEnvVarDecl,
): ProjectEnvVarDecl[] {
  const current = storage.get();
  if (current.some((existing) => existing.name === decl.name)) {
    throw new ProjectEnvDeclError(`Project env var decl: duplicate env var name "${decl.name}"`);
  }
  const next = [...current, decl];
  storage.set(next);
  return next;
}

/** Removes a declared env var by name. A no-op if no decl with that name exists. */
export function removeProjectEnvVarDecl(
  storage: ProjectEnvDeclStorage,
  name: string,
): ProjectEnvVarDecl[] {
  const next = storage.get().filter((decl) => decl.name !== name);
  storage.set(next);
  return next;
}

/** The secret name a decl requires, or `undefined` for a literal-value decl — for the UI to surface "needs a secret" (never a value; see module doc). */
export function requiredSecretName(decl: ProjectEnvVarDecl): string | undefined {
  return 'secret' in decl ? decl.secret : undefined;
}
