/**
 * loombox's own local ticketing data model — the storage shape a `native`
 * `TrackerMode` project persists on the node (SPEC §7.10 "Native mode";
 * issue #210, building on #209's `TrackerMode`/`TrackerBackend`).
 *
 * The shape is the point, not a flat row: a `fields` bag holds every piece
 * of business data with no privileged field names, a `system` object holds
 * everything loombox itself tracks about the record (author, linked
 * commits/PRs/sessions, activity, comments — SPEC §7.10's PR-linkage note
 * at lines 525-528 names `system.linkedPullRequests`/`system.linkedCommitSha`
 * exactly, so this module keeps those names), and a handful of real,
 * queryable columns (`id`, `primaryType`, `typeTags`, `issueNumber`,
 * `archived`, `createdAt`, `updatedAt`) sit outside both blobs. That split
 * is what lets a kanban board, priority sort, or assignee filter work
 * identically whether `primaryType` names a built-in Task/Bug/Epic or a
 * project-defined custom type — every one of those operations reads a
 * record's `title`/`workflowStatus`/`priority`/`assignee` through its own
 * type's `roles` mapping (`TrackerTypeDefinition.roles`), never a hardcoded
 * `fields.title`/`fields.status` key. {@link resolveRoleValue} is the one
 * indirection every role-driven read goes through; {@link
 * groupByWorkflowStatus}, {@link sortByPriority}, and {@link
 * filterByAssignee} below are its three concrete consumers.
 *
 * Deliberately absent: any `syncStatus`/team-sync column. SPEC §7.10 is
 * explicit that the native tracker is per-operator, not multi-user
 * collaborative — there is no background sync to have a status for. See
 * this file's own test for the compile-time and runtime checks that keep
 * it that way.
 *
 * Storage (the JSON-file `NativeTrackerStore`, on the node where this data
 * actually lives) is `@loombox/node`'s concern, not this package's — this
 * module is the pure, storage-agnostic data model plus the role-driven
 * query helpers, exactly the layer `@loombox/shared`'s existing
 * `tracker-backend.ts` (the live-mode extension point) sits at.
 */

/** One indirection a `TrackerTypeDefinition.roles` mapping can name — the "title/workflowStatus/priority/assignee/..." list issue #210 calls out. Extend this list (never a per-role special case elsewhere) if a future issue needs another role. */
export type TrackerRole = 'title' | 'workflowStatus' | 'priority' | 'assignee';

export const TRACKER_ROLES: readonly TrackerRole[] = [
  'title',
  'workflowStatus',
  'priority',
  'assignee',
];

/**
 * One tracker item "type" — built-in (Task/Bug/Epic) or project-defined
 * custom — and the `roles` mapping that lets generic code (this module's
 * query helpers, a future kanban board/MCP tool) resolve a role to a
 * concrete `fields` key without knowing which kind of type it's looking
 * at. A role absent from `roles` simply doesn't resolve for that type
 * (e.g. a type with no `assignee` role never matches an assignee filter).
 */
export interface TrackerTypeDefinition {
  /** The value a record's `primaryType` column names to select this type. Unique within a project's type set (built-ins plus its own custom types). */
  readonly id: string;
  readonly label: string;
  /** `true` for the three shipped types below; `false` for a project-defined custom type. */
  readonly builtin: boolean;
  /** Role name -> the `fields` key that holds it for records of this type. */
  readonly roles: Partial<Record<TrackerRole, string>>;
}

export const TASK_TRACKER_TYPE: TrackerTypeDefinition = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

export const BUG_TRACKER_TYPE: TrackerTypeDefinition = {
  id: 'bug',
  label: 'Bug',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

export const EPIC_TRACKER_TYPE: TrackerTypeDefinition = {
  id: 'epic',
  label: 'Epic',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

/** The three shipped types (SPEC §7.10). A project may add custom types alongside these; none of these ids may be reused by one (see `NativeTrackerStore.defineType`). */
export const BUILTIN_TRACKER_TYPES: readonly TrackerTypeDefinition[] = [
  TASK_TRACKER_TYPE,
  BUG_TRACKER_TYPE,
  EPIC_TRACKER_TYPE,
];

/** A project's resolved type set — built-ins plus its own custom types, keyed by `id` — the lookup every role-driven helper below takes instead of a raw list. */
export type TrackerTypeRegistry = ReadonlyMap<string, TrackerTypeDefinition>;

/** Builds a {@link TrackerTypeRegistry} from a project's custom types, always including the three built-ins. A custom type sharing a built-in's `id` overrides it in the returned map (callers that must reject that collision — `NativeTrackerStore.defineType` — check for it themselves before this point). */
export function buildTrackerTypeRegistry(
  customTypes: readonly TrackerTypeDefinition[] = [],
): TrackerTypeRegistry {
  const registry = new Map<string, TrackerTypeDefinition>();
  for (const type of BUILTIN_TRACKER_TYPES) registry.set(type.id, type);
  for (const type of customTypes) registry.set(type.id, type);
  return registry;
}

export interface TrackerActivityEntry {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly at: number;
  readonly kind: string;
  readonly detail?: Record<string, unknown>;
}

export interface TrackerComment {
  readonly id: string;
  readonly authorId: string;
  readonly body: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/**
 * Everything loombox tracks about a record that isn't business data: who
 * created it, what it's linked to, and its activity/comment history. SPEC
 * §7.10 lines 525-528 name `linkedPullRequests`/`linkedCommitSha` exactly
 * for the PR-merge write-back it describes; `linkedSessionIds` is this
 * issue's "linked ... sessions" (issue #210's body).
 */
export interface TrackerSystem {
  readonly authorId: string;
  readonly linkedCommitSha: string[];
  readonly linkedPullRequests: string[];
  readonly linkedSessionIds: string[];
  readonly activity: TrackerActivityEntry[];
  readonly comments: TrackerComment[];
}

/**
 * One loombox native tracker item. The split this whole module exists for:
 * `fields` (business data, no privileged names), `system` (see above), and
 * the rest — real, queryable columns, never buried in either blob.
 *
 * No `syncStatus`/team-sync field exists here, deliberately (see this
 * module's doc comment and its test file's compile-time + runtime guards).
 */
export interface TrackerRecord {
  readonly id: string;
  /** Which `TrackerTypeDefinition.id` governs this record's `roles`. */
  readonly primaryType: string;
  /** Free-form, multi-valued labels — independent of `primaryType`, e.g. cross-cutting search/filter tags. */
  readonly typeTags: string[];
  /** Project-scoped, sequential, human-facing ticket number (`NativeTrackerStore` assigns it; never reused within a project). */
  readonly issueNumber: number;
  readonly archived: boolean;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds. */
  readonly updatedAt: number;
  readonly fields: Record<string, unknown>;
  readonly system: TrackerSystem;
}

// ---------------------------------------------------------------------
// Compile-time "no sync columns, ever" guard (issue #210 acceptance). If a
// future edit adds any of these keys to TrackerRecord/TrackerSystem, this
// file stops type-checking — see tracker-record.test.ts for the matching
// runtime assertion against real constructed/persisted records.
// ---------------------------------------------------------------------
type ForbiddenSyncKeys =
  | 'syncStatus'
  | 'syncedAt'
  | 'lastSyncedAt'
  | 'remoteSyncState'
  | 'teamSyncStatus'
  | 'conflictState';
type AssertNever<T extends never> = T;
type _NoSyncColumnsOnRecord = AssertNever<Extract<keyof TrackerRecord, ForbiddenSyncKeys>>;
type _NoSyncColumnsOnSystem = AssertNever<Extract<keyof TrackerSystem, ForbiddenSyncKeys>>;

/**
 * Resolves `role` for `record` through its own type's `roles` mapping —
 * the one indirection every role-driven read in this module goes through.
 * Returns `undefined` if `record.primaryType` isn't in `types`, or if that
 * type has no mapping for `role`.
 */
export function resolveRoleValue(
  record: TrackerRecord,
  types: TrackerTypeRegistry,
  role: TrackerRole,
): unknown {
  const type = types.get(record.primaryType);
  const key = type?.roles[role];
  return key === undefined ? undefined : record.fields[key];
}

/** The kanban column a record without a resolvable `workflowStatus` role value groups into. */
export const UNRESOLVED_WORKFLOW_STATUS = '(none)';

/**
 * Kanban grouping: buckets `records` by each one's `workflowStatus` role
 * value, resolved through its own type — a built-in Task and a
 * project-defined custom type group identically as long as each maps a
 * `workflowStatus` role, with no special-casing of either kind (SPEC
 * §7.10; issue #210's acceptance). Preserves each bucket's input order.
 */
export function groupByWorkflowStatus(
  records: readonly TrackerRecord[],
  types: TrackerTypeRegistry,
): Map<string, TrackerRecord[]> {
  const groups = new Map<string, TrackerRecord[]>();
  for (const record of records) {
    const value = resolveRoleValue(record, types, 'workflowStatus');
    const key = typeof value === 'string' && value.length > 0 ? value : UNRESOLVED_WORKFLOW_STATUS;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

/**
 * Sorts `records` by each one's `priority` role value, resolved through
 * its own type, ranked by position in `order` (index 0 sorts first). A
 * record whose resolved priority isn't in `order` (including one with no
 * resolvable priority at all) sorts after every ranked record; ties break
 * by original input order (a stable sort).
 */
export function sortByPriority(
  records: readonly TrackerRecord[],
  types: TrackerTypeRegistry,
  order: readonly string[],
): TrackerRecord[] {
  const rank = new Map(order.map((value, index) => [value, index]));
  const unranked = order.length;
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const aValue = resolveRoleValue(a.record, types, 'priority');
      const bValue = resolveRoleValue(b.record, types, 'priority');
      const aRank = typeof aValue === 'string' ? (rank.get(aValue) ?? unranked) : unranked;
      const bRank = typeof bValue === 'string' ? (rank.get(bValue) ?? unranked) : unranked;
      return aRank !== bRank ? aRank - bRank : a.index - b.index;
    })
    .map(({ record }) => record);
}

/**
 * Filters `records` to those whose `assignee` role value, resolved
 * through each record's own type, equals `assignee` exactly.
 */
export function filterByAssignee(
  records: readonly TrackerRecord[],
  types: TrackerTypeRegistry,
  assignee: string,
): TrackerRecord[] {
  return records.filter((record) => resolveRoleValue(record, types, 'assignee') === assignee);
}

/**
 * The in-memory secondary indexes a `TrackerRecord[]` supports — the
 * "genuinely indexed" half of issue #210's acceptance for a store that
 * isn't SQL: `NativeTrackerStore` (on the node) rebuilds one of these from
 * its on-disk record array on every read, giving O(1) id/issue-number
 * lookup and O(1) bucket access by `primaryType`/tag instead of an O(n)
 * scan per query, the equivalent a `CREATE INDEX` gives a SQL column.
 */
export interface TrackerIndex {
  readonly byId: ReadonlyMap<string, TrackerRecord>;
  readonly byIssueNumber: ReadonlyMap<number, TrackerRecord>;
  readonly byPrimaryType: ReadonlyMap<string, readonly TrackerRecord[]>;
  readonly byTypeTag: ReadonlyMap<string, readonly TrackerRecord[]>;
  readonly active: readonly TrackerRecord[];
  readonly archived: readonly TrackerRecord[];
}

function pushBucket<K>(map: Map<K, TrackerRecord[]>, key: K, record: TrackerRecord): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(record);
  else map.set(key, [record]);
}

/** Builds a {@link TrackerIndex} from `records`. See that type's doc comment for why this exists. */
export function buildTrackerIndex(records: readonly TrackerRecord[]): TrackerIndex {
  const byId = new Map<string, TrackerRecord>();
  const byIssueNumber = new Map<number, TrackerRecord>();
  const byPrimaryType = new Map<string, TrackerRecord[]>();
  const byTypeTag = new Map<string, TrackerRecord[]>();
  const active: TrackerRecord[] = [];
  const archived: TrackerRecord[] = [];
  for (const record of records) {
    byId.set(record.id, record);
    byIssueNumber.set(record.issueNumber, record);
    pushBucket(byPrimaryType, record.primaryType, record);
    for (const tag of record.typeTags) pushBucket(byTypeTag, tag, record);
    (record.archived ? archived : active).push(record);
  }
  return { byId, byIssueNumber, byPrimaryType, byTypeTag, active, archived };
}
