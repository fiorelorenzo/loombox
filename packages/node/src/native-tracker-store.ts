/* ---------------------------------------------------------------------
 * Node-side persistence for loombox's native tracker data model
 * (`@loombox/shared`'s `TrackerRecord`/`TrackerTypeDefinition`; SPEC
 * §7.10 "Native mode"; issue #210, building on #209's `TrackerMode`).
 *
 * **Storage choice, made deliberately.** This package has no SQL
 * dependency anywhere: every existing store (`SessionStore`,
 * `McpConfigStore`, `SshTargetStore`, `NodeIdentityStore`,
 * `DeviceTokenFileStore`) is a single JSON file under
 * `defaultNodeStateDir()`, re-read then rewritten whole per mutation. The
 * one SQL engine in this monorepo, `better-sqlite3`, appears only as an
 * in-memory Postgres stand-in for `@loombox/relay`'s Better Auth tables
 * (`packages/relay/src/auth.test.ts`, `apps/web/src/lib/auth-store.test.ts`)
 * — never as a real runtime dependency, and the relay's actual database is
 * a genuinely different thing: Postgres backs the RELAY's multi-tenant,
 * team-visible board, while a native tracker is per-operator data that
 * lives and dies with one node (SPEC §7.10: "no `syncStatus`/team-sync
 * columns... per-operator, not multi-user collaborative" — there is no
 * second writer to coordinate). Introducing a new SQL engine on the node
 * for a per-operator, single-writer table would add real surface (a new
 * native dependency, a migration story, a query layer) to buy relational
 * query planning this data doesn't need — a project's tracker items are at
 * most a few thousand rows, not a dataset outgrowing an in-process array.
 * So this follows the node's own established idiom exactly, and still
 * gets the "indexed columns" acceptance criterion the non-SQL way
 * `@loombox/shared`'s `TrackerIndex` doc comment describes: `id`/
 * `primaryType`/`typeTags`/`issueNumber`/`archived` sit outside the
 * `fields`/`system` blobs as real object properties, never buried JSON
 * keys, and `buildTrackerIndex` rebuilds O(1) lookup/bucket maps over them
 * on every read — the JSON-file equivalent of a `CREATE INDEX`, at the
 * same "recompute derived state per read" cost this store already pays.
 *
 * One file, keyed by `projectPath` (mirroring `McpConfigStore`'s
 * `projects: Record<string, ...>` shape exactly, for the same reason: a
 * node has no other project-id concept at this layer). Each project owns
 * its own `customTypes` list, `nextIssueNumber` sequence, and `records`
 * array; the three built-in types (Task/Bug/Epic, `@loombox/shared`'s
 * `BUILTIN_TRACKER_TYPES`) are always available and never persisted.
 * --------------------------------------------------------------------- */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildTrackerIndex,
  buildTrackerTypeRegistry,
  BUILTIN_TRACKER_TYPES,
  TRACKER_ROLES,
  type TrackerActivityEntry,
  type TrackerComment,
  type TrackerIndex,
  type TrackerRecord,
  type TrackerRole,
  type TrackerSystem,
  type TrackerTypeDefinition,
  type TrackerTypeRegistry,
} from '@loombox/shared';

import { loadJsonFile } from './json-store';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

const NATIVE_TRACKER_FILE_NAME = 'native-tracker.json';
const NATIVE_TRACKER_SCHEMA_VERSION = 1;

interface ProjectTrackerDataV1 {
  customTypes: TrackerTypeDefinition[];
  nextIssueNumber: number;
  records: TrackerRecord[];
}

interface NativeTrackerFileV1 {
  v: 1;
  projects: Record<string, ProjectTrackerDataV1>;
}

const EMPTY_PROJECT_DATA: Readonly<ProjectTrackerDataV1> = Object.freeze({
  customTypes: [],
  nextIssueNumber: 1,
  records: [],
});

/** Thrown for a corrupt on-disk file, an unknown tracker type, or an operation naming a record/project this store doesn't have — names the offending part, never returns a partially-valid result (mirrors `McpConfigError`/`SessionStoreError`'s contract). */
export class NativeTrackerStoreError extends Error {
  constructor(message: string) {
    super(`native tracker store: ${message}`);
    this.name = 'NativeTrackerStoreError';
  }
}

function validateStringArray(raw: unknown, context: string): string[] {
  if (!Array.isArray(raw)) throw new NativeTrackerStoreError(`${context}: must be an array`);
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new NativeTrackerStoreError(`${context}[${index}]: must be a string`);
    }
    return entry;
  });
}

function validateActivityEntry(raw: unknown, context: string): TrackerActivityEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  const entry = raw as Partial<TrackerActivityEntry>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "id" must be a non-empty string`);
  }
  if (typeof entry.at !== 'number')
    throw new NativeTrackerStoreError(`${context}: "at" must be a number`);
  if (typeof entry.kind !== 'string' || entry.kind.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "kind" must be a non-empty string`);
  }
  if (
    entry.detail !== undefined &&
    (typeof entry.detail !== 'object' || entry.detail === null || Array.isArray(entry.detail))
  ) {
    throw new NativeTrackerStoreError(`${context}: "detail" must be an object when present`);
  }
  return { id: entry.id, at: entry.at, kind: entry.kind, detail: entry.detail };
}

function validateComment(raw: unknown, context: string): TrackerComment {
  if (typeof raw !== 'object' || raw === null) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  const comment = raw as Partial<TrackerComment>;
  if (typeof comment.id !== 'string' || comment.id.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "id" must be a non-empty string`);
  }
  if (typeof comment.authorId !== 'string' || comment.authorId.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "authorId" must be a non-empty string`);
  }
  if (typeof comment.body !== 'string')
    throw new NativeTrackerStoreError(`${context}: "body" must be a string`);
  if (typeof comment.createdAt !== 'number') {
    throw new NativeTrackerStoreError(`${context}: "createdAt" must be a number`);
  }
  return {
    id: comment.id,
    authorId: comment.authorId,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

/** No `syncStatus`/team-sync field is read off `raw` here, matching `TrackerSystem`'s shape exactly — an on-disk file carrying one is silently dropped rather than round-tripped, the same way an unknown extra key on any validated record here is. */
function validateSystem(raw: unknown, context: string): TrackerSystem {
  if (typeof raw !== 'object' || raw === null) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  const system = raw as Partial<TrackerSystem>;
  if (typeof system.authorId !== 'string' || system.authorId.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "authorId" must be a non-empty string`);
  }
  if (!Array.isArray(system.activity))
    throw new NativeTrackerStoreError(`${context}: "activity" must be an array`);
  if (!Array.isArray(system.comments))
    throw new NativeTrackerStoreError(`${context}: "comments" must be an array`);
  return {
    authorId: system.authorId,
    linkedCommitSha: validateStringArray(system.linkedCommitSha, `${context}."linkedCommitSha"`),
    linkedPullRequests: validateStringArray(
      system.linkedPullRequests,
      `${context}."linkedPullRequests"`,
    ),
    linkedSessionIds: validateStringArray(system.linkedSessionIds, `${context}."linkedSessionIds"`),
    activity: system.activity.map((entry, index) =>
      validateActivityEntry(entry, `${context}.activity[${index}]`),
    ),
    comments: system.comments.map((entry, index) =>
      validateComment(entry, `${context}.comments[${index}]`),
    ),
  };
}

function validateFields(raw: unknown, context: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  return raw as Record<string, unknown>;
}

function validateRecord(raw: unknown, context: string): TrackerRecord {
  if (typeof raw !== 'object' || raw === null) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  const record = raw as Partial<TrackerRecord>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "id" must be a non-empty string`);
  }
  if (typeof record.primaryType !== 'string' || record.primaryType.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "primaryType" must be a non-empty string`);
  }
  if (typeof record.issueNumber !== 'number') {
    throw new NativeTrackerStoreError(`${context}: "issueNumber" must be a number`);
  }
  if (typeof record.archived !== 'boolean') {
    throw new NativeTrackerStoreError(`${context}: "archived" must be a boolean`);
  }
  if (typeof record.createdAt !== 'number') {
    throw new NativeTrackerStoreError(`${context}: "createdAt" must be a number`);
  }
  if (typeof record.updatedAt !== 'number') {
    throw new NativeTrackerStoreError(`${context}: "updatedAt" must be a number`);
  }
  return {
    id: record.id,
    primaryType: record.primaryType,
    typeTags: validateStringArray(record.typeTags, `${context}."typeTags"`),
    issueNumber: record.issueNumber,
    archived: record.archived,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    fields: validateFields(record.fields, `${context}."fields"`),
    system: validateSystem(record.system, `${context}."system"`),
  };
}

function validateRoles(raw: unknown, context: string): Partial<Record<TrackerRole, string>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  const roles: Partial<Record<TrackerRole, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(TRACKER_ROLES as readonly string[]).includes(key)) {
      throw new NativeTrackerStoreError(`${context}: unknown role "${key}"`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new NativeTrackerStoreError(`${context}."${key}": must be a non-empty string`);
    }
    roles[key as TrackerRole] = value;
  }
  return roles;
}

function validateCustomType(raw: unknown, context: string): TrackerTypeDefinition {
  if (typeof raw !== 'object' || raw === null) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  const type = raw as Partial<TrackerTypeDefinition>;
  if (typeof type.id !== 'string' || type.id.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "id" must be a non-empty string`);
  }
  if (typeof type.label !== 'string' || type.label.length === 0) {
    throw new NativeTrackerStoreError(`${context}: "label" must be a non-empty string`);
  }
  if (type.builtin !== false) {
    throw new NativeTrackerStoreError(
      `${context}: "builtin" must be false for a persisted custom type`,
    );
  }
  return {
    id: type.id,
    label: type.label,
    builtin: false,
    roles: validateRoles(type.roles, `${context}."roles"`),
  };
}

function validateProjectData(raw: unknown, context: string): ProjectTrackerDataV1 {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new NativeTrackerStoreError(`${context}: must be an object`);
  }
  const data = raw as { customTypes?: unknown; nextIssueNumber?: unknown; records?: unknown };
  if (typeof data.nextIssueNumber !== 'number') {
    throw new NativeTrackerStoreError(`${context}: "nextIssueNumber" must be a number`);
  }
  if (!Array.isArray(data.customTypes)) {
    throw new NativeTrackerStoreError(`${context}: "customTypes" must be an array`);
  }
  if (!Array.isArray(data.records)) {
    throw new NativeTrackerStoreError(`${context}: "records" must be an array`);
  }
  return {
    customTypes: data.customTypes.map((entry, index) =>
      validateCustomType(entry, `${context}.customTypes[${index}]`),
    ),
    nextIssueNumber: data.nextIssueNumber,
    records: data.records.map((entry, index) =>
      validateRecord(entry, `${context}.records[${index}]`),
    ),
  };
}

function validateFile(parsed: unknown, filePath: string): NativeTrackerFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new NativeTrackerStoreError(`file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { projects?: unknown };
  const projects: Record<string, ProjectTrackerDataV1> = {};
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new NativeTrackerStoreError(`file "${filePath}": "projects" must be an object`);
    }
    for (const [projectPath, data] of Object.entries(obj.projects)) {
      projects[projectPath] = validateProjectData(data, `${filePath} (project "${projectPath}")`);
    }
  }
  return { v: NATIVE_TRACKER_SCHEMA_VERSION, projects };
}

/** `"owner/repo#number"` (the convention every caller of {@link NativeTrackerStore.linkPullRequest} — see issue #241's `native-tracker-pr-link.ts` — formats a ref as) parses out to `"owner/repo"`; anything not shaped that way (a caller free to link an arbitrary string) has no prefix at all. */
const PR_REF_PATTERN = /^(.*)#(\d+)$/;

/**
 * Upserts `ref` into `existing` for {@link NativeTrackerStore.linkPullRequest}:
 * an exact repeat of a ref already linked is a no-op (re-running the same
 * `pr_open_request` twice — `gh pr create` is itself idempotent and
 * returns the same URL — must not grow the list), and a ref sharing
 * another entry's `owner/repo` prefix but a different PR number (a PR
 * reopened under a new number after the old one closed, or a session's
 * second attempt after abandoning its first) *replaces* that entry in
 * place rather than appending beside it — one native tracker item is
 * expected to carry at most one currently-relevant PR per repo, not an
 * ever-growing history. A ref for a different repo (or one that doesn't
 * parse as `owner/repo#number` at all) is unrelated to every existing
 * entry and is simply appended. Exported standalone so its exact output
 * shape can be asserted directly, not just inferred from a store call.
 */
export function upsertPullRequestRef(existing: readonly string[], ref: string): string[] {
  if (existing.includes(ref)) return [...existing];
  const prefix = PR_REF_PATTERN.exec(ref)?.[1];
  const kept =
    prefix === undefined
      ? existing
      : existing.filter((entry) => PR_REF_PATTERN.exec(entry)?.[1] !== prefix);
  return [...kept, ref];
}

export interface CreateTrackerRecordInput {
  readonly primaryType: string;
  readonly typeTags?: string[];
  readonly fields: Record<string, unknown>;
  readonly authorId: string;
}

export interface UpdateTrackerRecordInput {
  readonly primaryType?: string;
  readonly typeTags?: string[];
  readonly fields?: Record<string, unknown>;
  readonly archived?: boolean;
}

export interface ListTrackerRecordsFilter {
  readonly primaryType?: string;
  readonly typeTag?: string;
  /** `false` (the default) excludes archived records — the common "board" query. `true` includes both. */
  readonly includeArchived?: boolean;
}

export interface NativeTrackerStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists a project's native tracker items (see this module's doc
 * comment for the storage shape/rationale). Every mutating method
 * re-reads then rewrites the whole file, matching every other store in
 * this package.
 */
export class NativeTrackerStore {
  private readonly filePath: string;

  constructor(options: NativeTrackerStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, NATIVE_TRACKER_FILE_NAME);
  }

  /** Built-in types plus `projectPath`'s own custom types. */
  listTypes(projectPath: string): TrackerTypeDefinition[] {
    return [...BUILTIN_TRACKER_TYPES, ...this.projectData(projectPath).customTypes];
  }

  /** `projectPath`'s full type registry (built-ins plus custom), the shape every role-driven helper in `@loombox/shared` (`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`) takes. */
  typeRegistry(projectPath: string): TrackerTypeRegistry {
    return buildTrackerTypeRegistry(this.projectData(projectPath).customTypes);
  }

  /**
   * Registers (or replaces, by `id`) a project-defined custom tracker
   * type. Throws {@link NativeTrackerStoreError} if `type.id` collides
   * with a built-in type's id, or if `type.builtin` isn't `false`.
   */
  defineType(projectPath: string, type: TrackerTypeDefinition): TrackerTypeDefinition {
    if (type.builtin) {
      throw new NativeTrackerStoreError(
        `cannot define "${type.id}": custom types must set builtin: false`,
      );
    }
    if (BUILTIN_TRACKER_TYPES.some((builtin) => builtin.id === type.id)) {
      throw new NativeTrackerStoreError(`"${type.id}" collides with a built-in tracker type id`);
    }
    const file = this.readFile();
    const data = file.projects[projectPath] ?? { ...EMPTY_PROJECT_DATA };
    const persisted: TrackerTypeDefinition = {
      id: type.id,
      label: type.label,
      builtin: false,
      roles: { ...type.roles },
    };
    data.customTypes = [
      ...data.customTypes.filter((existing) => existing.id !== type.id),
      persisted,
    ];
    file.projects[projectPath] = data;
    this.writeFile(file);
    return persisted;
  }

  /** The in-memory secondary indexes over `projectPath`'s current records — see `@loombox/shared`'s `TrackerIndex` doc comment for why this is the non-SQL "genuinely indexed" answer. */
  index(projectPath: string): TrackerIndex {
    return buildTrackerIndex(this.projectData(projectPath).records);
  }

  get(projectPath: string, id: string): TrackerRecord | undefined {
    return this.index(projectPath).byId.get(id);
  }

  getByIssueNumber(projectPath: string, issueNumber: number): TrackerRecord | undefined {
    return this.index(projectPath).byIssueNumber.get(issueNumber);
  }

  /** Lists `projectPath`'s records, narrowed by `filter`. Excludes archived records unless `filter.includeArchived` is `true`. */
  list(projectPath: string, filter: ListTrackerRecordsFilter = {}): TrackerRecord[] {
    const index = this.index(projectPath);
    let records = filter.includeArchived ? [...index.active, ...index.archived] : [...index.active];
    if (filter.primaryType !== undefined) {
      const matching = new Set(index.byPrimaryType.get(filter.primaryType) ?? []);
      records = records.filter((record) => matching.has(record));
    }
    if (filter.typeTag !== undefined) {
      const matching = new Set(index.byTypeTag.get(filter.typeTag) ?? []);
      records = records.filter((record) => matching.has(record));
    }
    return records;
  }

  /**
   * Creates a record: assigns `id`, the project's next `issueNumber`,
   * `archived: false`, both timestamps, and a `system` seeded from
   * `input.authorId` with a `created` activity entry. Throws {@link
   * NativeTrackerStoreError} if `input.primaryType` isn't a built-in or a
   * type already registered via {@link defineType}.
   */
  create(projectPath: string, input: CreateTrackerRecordInput): TrackerRecord {
    const file = this.readFile();
    const data = file.projects[projectPath] ?? { ...EMPTY_PROJECT_DATA };
    this.assertKnownType(data.customTypes, input.primaryType, projectPath);
    const now = Date.now();
    const record: TrackerRecord = {
      id: randomUUID(),
      primaryType: input.primaryType,
      typeTags: input.typeTags ? [...input.typeTags] : [],
      issueNumber: data.nextIssueNumber,
      archived: false,
      createdAt: now,
      updatedAt: now,
      fields: { ...input.fields },
      system: {
        authorId: input.authorId,
        linkedCommitSha: [],
        linkedPullRequests: [],
        linkedSessionIds: [],
        activity: [{ id: randomUUID(), at: now, kind: 'created' }],
        comments: [],
      },
    };
    data.records = [...data.records, record];
    data.nextIssueNumber = data.nextIssueNumber + 1;
    file.projects[projectPath] = data;
    this.writeFile(file);
    return record;
  }

  /**
   * Applies a business-data patch (`primaryType`/`typeTags`/`fields`/
   * `archived`) to an existing record; omitted fields are left as-is. Use
   * {@link linkSession}/{@link linkCommit}/{@link linkPullRequest}/{@link
   * addComment} to mutate `system` instead — this method never touches it
   * beyond bumping `updatedAt`.
   */
  update(projectPath: string, id: string, patch: UpdateTrackerRecordInput): TrackerRecord {
    if (patch.primaryType !== undefined) {
      const data = this.projectData(projectPath);
      this.assertKnownType(data.customTypes, patch.primaryType, projectPath);
    }
    return this.replaceRecord(projectPath, id, (current) => ({
      ...current,
      primaryType: patch.primaryType ?? current.primaryType,
      typeTags: patch.typeTags ? [...patch.typeTags] : current.typeTags,
      fields: patch.fields ? { ...patch.fields } : current.fields,
      archived: patch.archived ?? current.archived,
      updatedAt: Date.now(),
    }));
  }

  linkSession(projectPath: string, id: string, sessionId: string): TrackerRecord {
    return this.mutateSystem(projectPath, id, (system) => ({
      ...system,
      linkedSessionIds: [...system.linkedSessionIds, sessionId],
      activity: [
        ...system.activity,
        { id: randomUUID(), at: Date.now(), kind: 'session_linked', detail: { sessionId } },
      ],
    }));
  }

  linkCommit(projectPath: string, id: string, sha: string): TrackerRecord {
    return this.mutateSystem(projectPath, id, (system) => ({
      ...system,
      linkedCommitSha: [...system.linkedCommitSha, sha],
      activity: [
        ...system.activity,
        { id: randomUUID(), at: Date.now(), kind: 'commit_linked', detail: { sha } },
      ],
    }));
  }

  /**
   * Links `ref` (by convention `"owner/repo#number"`, e.g. from issue
   * #241's `native-tracker-pr-link.ts`) onto `id`'s `system.linkedPullRequests`
   * via {@link upsertPullRequestRef} — re-linking the exact same ref is a
   * silent no-op (no duplicate entry, no extra activity), and linking a
   * different PR number for the same `owner/repo` replaces the prior
   * entry rather than appending beside it. See that function's own doc
   * comment for the reasoning.
   */
  linkPullRequest(projectPath: string, id: string, ref: string): TrackerRecord {
    return this.mutateSystem(projectPath, id, (system) => {
      if (system.linkedPullRequests.includes(ref)) return system;
      return {
        ...system,
        linkedPullRequests: upsertPullRequestRef(system.linkedPullRequests, ref),
        activity: [
          ...system.activity,
          { id: randomUUID(), at: Date.now(), kind: 'pull_request_linked', detail: { ref } },
        ],
      };
    });
  }

  addComment(projectPath: string, id: string, authorId: string, body: string): TrackerRecord {
    return this.mutateSystem(projectPath, id, (system) => ({
      ...system,
      comments: [...system.comments, { id: randomUUID(), authorId, body, createdAt: Date.now() }],
    }));
  }

  private assertKnownType(
    customTypes: readonly TrackerTypeDefinition[],
    primaryType: string,
    projectPath: string,
  ): void {
    const known =
      BUILTIN_TRACKER_TYPES.some((type) => type.id === primaryType) ||
      customTypes.some((type) => type.id === primaryType);
    if (!known) {
      throw new NativeTrackerStoreError(
        `unknown tracker type "${primaryType}" for project "${projectPath}" — call defineType first`,
      );
    }
  }

  private projectData(projectPath: string): ProjectTrackerDataV1 {
    return this.readFile().projects[projectPath] ?? { ...EMPTY_PROJECT_DATA };
  }

  private replaceRecord(
    projectPath: string,
    id: string,
    next: (current: TrackerRecord) => TrackerRecord,
  ): TrackerRecord {
    const file = this.readFile();
    const data = file.projects[projectPath];
    const index = data?.records.findIndex((record) => record.id === id) ?? -1;
    if (data === undefined || index === -1) {
      throw new NativeTrackerStoreError(`no record "${id}" in project "${projectPath}"`);
    }
    const updated = next(data.records[index]!);
    data.records = [...data.records.slice(0, index), updated, ...data.records.slice(index + 1)];
    file.projects[projectPath] = data;
    this.writeFile(file);
    return updated;
  }

  private mutateSystem(
    projectPath: string,
    id: string,
    mutate: (system: TrackerSystem) => TrackerSystem,
  ): TrackerRecord {
    return this.replaceRecord(projectPath, id, (current) => ({
      ...current,
      system: mutate(current.system),
      updatedAt: Date.now(),
    }));
  }

  private readFile(): NativeTrackerFileV1 {
    return loadJsonFile(
      this.filePath,
      { v: NATIVE_TRACKER_SCHEMA_VERSION, projects: {} },
      validateFile,
      (message) => new NativeTrackerStoreError(message),
    );
  }

  private writeFile(file: NativeTrackerFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
