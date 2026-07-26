/**
 * The project registry (IA v4 design spec §4.2; SPEC §6's "**Project** — any
 * folder, local or remote ... It does **not** have to be a git repository").
 *
 * Until this module existed a project was only ever the `projectPath` string
 * inside a session's encrypted envelope, which meant a project could not exist
 * before its first session — so the working folder had to be re-picked on every
 * single creation, and the sidebar could only group by target. This registry is
 * what makes "pick the folder once, then spawn sessions into it" possible, and
 * what the sidebar's project tree is built from.
 *
 * Client-side, scoped to this device, with the storage injected as a
 * constructor parameter and a real-browser default — the same convention as
 * `recent-paths.ts`, `mcp-server-store.ts` and `plugin-store.ts`, all of which
 * hold per-project state and all of which defer relay-backed account-wide sync
 * the same way. That deferral is deliberate here too and is filed separately;
 * {@link ProjectStore.adoptFromSessions} is what keeps a brand-new device from
 * looking empty in the meantime, since every project that has sessions
 * re-registers itself from the session list.
 *
 * Nothing in here crosses the wire. The relay never learns a project exists:
 * only `session_create`'s encrypted envelope carries a `projectPath`, exactly
 * as before (SPEC §8).
 */

import { writable, type Readable } from 'svelte/store';

/** A folder on one target that sessions are created into. */
export interface Project {
  /** Stable client-side id. Never sent anywhere; the wire still identifies a project by its `(nodeId, targetId, path)` triple. */
  id: string;
  /** Display name. Defaults to the path's basename at registration and is renameable afterwards, because two checkouts of the same repo on different hosts should not both read `loombox`. */
  name: string;
  nodeId: string;
  targetId: string;
  /** Absolute path on that target's filesystem. */
  path: string;
  /**
   * Whether `path` is inside a git work tree, learned from the directory
   * picker's `gitRepo` flag. `undefined` means "not established yet" — an
   * adopted project (see {@link ProjectStore.adoptFromSessions}) has never
   * been browsed to, and a node older than the flag never reports it. Callers
   * must treat `undefined` as unknown rather than as `false`: SPEC §7.1's
   * worktree choice is offered only on a confirmed `true`.
   */
  isGitRepo?: boolean;
  createdAt: number;
}

/** The minimal session shape this module needs — structurally satisfied by `ClientSessionMeta`, imported nowhere so this module stays testable without the relay client. */
export interface ProjectSessionRef {
  nodeId: string;
  targetId: string;
  projectPath: string;
}

/** Persistence seam, mirroring `AmkStorage`/`PluginConfigStorage`: the real implementation is `localStorage`, tests pass an in-memory one. */
export interface ProjectStorage {
  get(): Project[];
  set(projects: Project[]): void;
}

export const PROJECTS_STORAGE_KEY = 'loombox:projects';

/**
 * The identity of a project. The same path on two different targets is two
 * different projects (`/srv/app` on your laptop and on a build server share
 * nothing), which is also why the registry can never be keyed by path alone.
 */
export function projectKey(project: Pick<Project, 'nodeId' | 'targetId' | 'path'>): string {
  return `${project.nodeId}:${project.targetId}:${project.path}`;
}

/** The same key computed from a session, so a session can be filed under its project without the two ever disagreeing about the format. */
export function sessionProjectKey(session: ProjectSessionRef): string {
  return `${session.nodeId}:${session.targetId}:${session.projectPath}`;
}

/**
 * The last path segment, used as a project's default name. Tolerates a
 * trailing slash and a bare root (`/` names itself rather than producing an
 * empty label, which would render as an unclickable blank row).
 */
export function projectNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return path === '' ? 'Project' : path;
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return segment === '' ? trimmed : segment;
}

function isProject(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.nodeId === 'string' &&
    typeof candidate.targetId === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.createdAt === 'number' &&
    (candidate.isGitRepo === undefined || typeof candidate.isGitRepo === 'boolean')
  );
}

/** The real, `window.localStorage`-backed storage. Safe to construct during SSR: every method degrades to a no-op rather than throwing. */
export function createLocalStorageProjectStorage(): ProjectStorage {
  return {
    get(): Project[] {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (!raw) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Drops malformed entries rather than the whole list: one corrupt
        // record should cost you one project, not every project you have.
        return parsed.filter(isProject);
      } catch {
        return [];
      }
    },
    set(projects: Project[]): void {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
    },
  };
}

/** An in-memory storage for tests and for any caller that explicitly does not want persistence. */
export function createInMemoryProjectStorage(initial: Project[] = []): ProjectStorage {
  let projects = [...initial];
  return {
    get: () => [...projects],
    set: (next) => {
      projects = [...next];
    },
  };
}

/** What {@link ProjectStore.add} needs; `id`/`createdAt` are generated and `name` defaults to the path's basename. */
export interface NewProject {
  name?: string;
  nodeId: string;
  targetId: string;
  path: string;
  isGitRepo?: boolean;
}

export interface ProjectStore extends Readable<Project[]> {
  /**
   * Registers a folder, or returns the existing entry when its
   * {@link projectKey} is already known — adding the same folder twice is a
   * no-op rather than a duplicate row, since the picker makes it easy to
   * re-select something you already have. An `isGitRepo` on a repeat call is
   * still applied, so re-browsing to an adopted project fills in what adoption
   * could not know.
   */
  add(project: NewProject): Project;
  rename(id: string, name: string): void;
  /** Forgets the registry entry only. Sessions are untouched, and any project with surviving sessions comes back on the next {@link adoptFromSessions}. */
  remove(id: string): void;
  /** Records what the directory listing reported about `path` being a git work tree. */
  setGitRepo(id: string, isGitRepo: boolean): void;
  /**
   * Registers a project for every `(nodeId, targetId, projectPath)` triple in
   * `sessions` that has no entry yet. This is what stops sessions from ever
   * appearing orphaned: an install upgrading from the pre-registry build, or a
   * second device that has never added anything, both show a populated tree on
   * first load. Never removes and never renames — idempotent, so it can run on
   * every session-list update.
   */
  adoptFromSessions(sessions: readonly ProjectSessionRef[]): void;
}

function newId(): string {
  // `crypto.randomUUID` is missing in older Safari and in some test
  // environments; this id is purely local, so a timestamp+random fallback is
  // an honest substitute rather than a security-relevant one.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Builds the registry over `storage` (a real `localStorage` one by default).
 * Sorted by name, case-insensitively, so the sidebar's project order is stable
 * across reloads and does not depend on the order folders happened to be added.
 */
export function createProjectStore(
  storage: ProjectStorage = createLocalStorageProjectStorage(),
): ProjectStore {
  const sort = (projects: Project[]): Project[] =>
    [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const store = writable<Project[]>(sort(storage.get()));
  let current: Project[] = [];
  store.subscribe((value) => (current = value));

  function commit(next: Project[]): void {
    const sorted = sort(next);
    storage.set(sorted);
    store.set(sorted);
  }

  return {
    subscribe: store.subscribe,

    add(project: NewProject): Project {
      const key = projectKey(project);
      const existing = current.find((entry) => projectKey(entry) === key);
      if (existing) {
        if (project.isGitRepo !== undefined && existing.isGitRepo !== project.isGitRepo) {
          const updated = { ...existing, isGitRepo: project.isGitRepo };
          commit(current.map((entry) => (entry.id === existing.id ? updated : entry)));
          return updated;
        }
        return existing;
      }
      const created: Project = {
        id: newId(),
        name: project.name?.trim() || projectNameFromPath(project.path),
        nodeId: project.nodeId,
        targetId: project.targetId,
        path: project.path,
        isGitRepo: project.isGitRepo,
        createdAt: Date.now(),
      };
      commit([...current, created]);
      return created;
    },

    rename(id: string, name: string): void {
      const trimmed = name.trim();
      if (trimmed === '') return; // a blank name would render an unclickable row
      commit(current.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)));
    },

    remove(id: string): void {
      commit(current.filter((entry) => entry.id !== id));
    },

    setGitRepo(id: string, isGitRepo: boolean): void {
      commit(current.map((entry) => (entry.id === id ? { ...entry, isGitRepo } : entry)));
    },

    adoptFromSessions(sessions: readonly ProjectSessionRef[]): void {
      const known = new Set(current.map(projectKey));
      const adopted: Project[] = [];
      for (const session of sessions) {
        const key = sessionProjectKey(session);
        if (known.has(key)) continue;
        known.add(key);
        adopted.push({
          id: newId(),
          name: projectNameFromPath(session.projectPath),
          nodeId: session.nodeId,
          targetId: session.targetId,
          path: session.projectPath,
          createdAt: Date.now(),
        });
      }
      if (adopted.length > 0) commit([...current, ...adopted]);
    },
  };
}
