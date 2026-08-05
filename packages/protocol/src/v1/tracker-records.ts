import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';
import { trackerBackendResolutionErrorV1 } from './tracker';

/**
 * The native tracker's wire contract (SPEC §7.10 "Native mode"; issue #212,
 * building on #210's `@loombox/shared/tracker-record.ts` data model and
 * #211's MCP tool contract). This package never imports `@loombox/shared`
 * — `apps/web` does not depend on it either (it only ever needs
 * `@loombox/providers-core/browser`'s client-safe surface, per
 * `AGENTS.md`'s "never the barrel" note), so exactly like `fs.ts`'s own
 * doc comment, this module is the one validated source of truth for the
 * wire shape, imported directly by both `@loombox/node` (which seals it,
 * converting from `@loombox/shared`'s `TrackerRecord`/`TrackerTypeDefinition`
 * at the boundary — the two shapes are field-for-field identical today,
 * so that conversion is exactly `trackerRecordV1.parse(record)`) and
 * `apps/web` (which opens it and renders from it directly).
 *
 * A project's tracker data is exactly as private as a directory listing
 * (SPEC §8's metadata boundary): every payload below travels only inside
 * an `encryptedEnvelope`, sealed/opened under the session's derived key,
 * and the four wire messages carry only clear ROUTING metadata
 * (`sessionId`/`targetId`/`requestId`) — mirrors `fs.ts` exactly, down to
 * routing through an existing session's owning node rather than a
 * standalone per-project channel (no such channel exists yet; see that
 * file's doc comment for why `sessionId` is the address).
 *
 * `resolveRoleValue`/`buildTrackerTypeRegistry`/`groupByWorkflowStatus`/
 * `sortByPriority`/`filterByAssignee` below are a deliberate, narrow port
 * of `@loombox/shared/tracker-record.ts`'s identically-named functions,
 * operating on this file's own wire types instead of `@loombox/shared`'s
 * storage-layer ones — the layering `apps/web` needs to render a kanban
 * board and a sorted/filtered list generically, with "no per-type UI
 * code" (issue #212's acceptance), without importing a node-adjacent
 * package it has never depended on. Keep both copies' *behavior*
 * identical (they are exercised by near-identical test suites); a
 * divergence here is a bug, not a place to hand-roll something new.
 */

/** One indirection a `TrackerTypeDefinitionV1.roles` mapping can name — mirrors `@loombox/shared`'s `TrackerRole` exactly. */
export const trackerRoleV1 = z.enum(['title', 'workflowStatus', 'priority', 'assignee']);
export type TrackerRoleV1 = z.infer<typeof trackerRoleV1>;

/** The ordered role list generic role-driven UI (a record's create/edit form, in particular) iterates — mirrors `@loombox/shared`'s `TRACKER_ROLES` exactly. Rendering this list once, keyed by role rather than by type, is what "no per-type UI code" (issue #212's acceptance) means in practice: a form that loops over these four roles renders a different set of fields per type only because each type's `roles` mapping has a different subset present, never because the form branches on `primaryType`. */
export const TRACKER_ROLES: readonly TrackerRoleV1[] = [
  'title',
  'workflowStatus',
  'priority',
  'assignee',
];

/** Built-in or project-defined tracker item type — mirrors `@loombox/shared`'s `TrackerTypeDefinition` field-for-field. */
export const trackerTypeDefinitionV1 = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  builtin: z.boolean(),
  /** Role name -> the `fields` key that holds it for records of this type. A plain string-keyed record already tolerates any subset of `TrackerRoleV1`'s members being present — no `.partial()` needed. */
  roles: z.record(trackerRoleV1, z.string().min(1)),
});
export type TrackerTypeDefinitionV1 = z.infer<typeof trackerTypeDefinitionV1>;

/** A project's resolved type set, keyed by `id` — the lookup every role-driven helper below takes. */
export type TrackerTypeRegistryV1 = ReadonlyMap<string, TrackerTypeDefinitionV1>;

/** Builds a {@link TrackerTypeRegistryV1} from a `tracker_snapshot_response`'s `types` list. */
export function buildTrackerTypeRegistryV1(
  types: readonly TrackerTypeDefinitionV1[],
): TrackerTypeRegistryV1 {
  return new Map(types.map((type) => [type.id, type]));
}

const trackerActivityEntryV1 = z.object({
  id: z.string().min(1),
  at: z.number().int().nonnegative(),
  kind: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const trackerCommentV1 = z.object({
  id: z.string().min(1),
  authorId: z.string().min(1),
  body: z.string(),
  createdAt: z.number().int().nonnegative(),
});

/** Mirrors `@loombox/shared`'s `TrackerSystem` field-for-field. */
export const trackerSystemV1 = z.object({
  authorId: z.string().min(1),
  linkedCommitSha: z.array(z.string()),
  linkedPullRequests: z.array(z.string()),
  linkedSessionIds: z.array(z.string()),
  activity: z.array(trackerActivityEntryV1),
  comments: z.array(trackerCommentV1),
});
export type TrackerSystemV1 = z.infer<typeof trackerSystemV1>;

/** Mirrors `@loombox/shared`'s `TrackerRecord` field-for-field. */
export const trackerRecordV1 = z.object({
  id: z.string().min(1),
  primaryType: z.string().min(1),
  typeTags: z.array(z.string()),
  issueNumber: z.number().int().nonnegative(),
  archived: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  fields: z.record(z.string(), z.unknown()),
  system: trackerSystemV1,
});
export type TrackerRecordV1 = z.infer<typeof trackerRecordV1>;

/**
 * Resolves `role` for `record` through its own type's `roles` mapping —
 * `undefined` if the type is unknown or doesn't map that role. Every
 * role-driven read (kanban grouping, priority sort, assignee filter)
 * goes through this, never a hardcoded `fields.title`/`fields.status` key
 * — mirrors `@loombox/shared`'s function of the same name exactly.
 */
export function resolveRoleValue(
  record: TrackerRecordV1,
  types: TrackerTypeRegistryV1,
  role: TrackerRoleV1,
): unknown {
  const type = types.get(record.primaryType);
  const key = type?.roles[role];
  return key === undefined ? undefined : record.fields[key];
}

/** The kanban column a record without a resolvable `workflowStatus` role value groups into. */
export const UNRESOLVED_WORKFLOW_STATUS = '(none)';

/** Kanban grouping: buckets `records` by each one's `workflowStatus` role value, resolved through its own type. Preserves each bucket's input order. */
export function groupByWorkflowStatus(
  records: readonly TrackerRecordV1[],
  types: TrackerTypeRegistryV1,
): Map<string, TrackerRecordV1[]> {
  const groups = new Map<string, TrackerRecordV1[]>();
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
 * The three workflow-category columns the kanban board renders (v7
 * decision F4-2, `2026-08-04-cockpit-v7-decisions.md` §6; issue #651,
 * superseding the plain "sort columns in workflow order" fix). Every
 * tracker's own workflow, however many raw statuses it has, collapses
 * into this fixed three-stage shape — chosen to match Jira's own
 * `statusCategory` vocabulary verbatim (`new`/`indeterminate`/`done`),
 * the one live tracker that already exposes a category as data rather
 * than a label to guess from (`@loombox/node`'s `jira-tracker-backend.ts`
 * reads it straight off `status.statusCategory.key`, no translation
 * table). GitHub's two-state `open`/`closed` (plus `state_reason`) maps
 * onto the same three ids in `github-tracker-backend.ts`.
 */
export const WORKFLOW_CATEGORIES_V1 = ['new', 'indeterminate', 'done'] as const;
export type WorkflowCategoryV1 = (typeof WORKFLOW_CATEGORIES_V1)[number];

/** Board column order + display label for each {@link WorkflowCategoryV1} — Jira's own category display names, since Jira is the one live tracker this literally mirrors. */
export const WORKFLOW_CATEGORY_COLUMNS_V1: readonly {
  readonly id: WorkflowCategoryV1;
  readonly label: string;
}[] = [
  { id: 'new', label: 'To Do' },
  { id: 'indeterminate', label: 'In Progress' },
  { id: 'done', label: 'Done' },
];

/**
 * loombox's own local status vocabulary, collapsed into the same three
 * categories a live Jira/GitHub board reads straight off the tracker.
 * Unlike those two, a native record has no external system to defer to
 * — loombox itself IS the tracker here — so this map is the single
 * place that ownership lives, never re-guessed per caller. Every
 * canonical category id round-trips through its own entry (`new` ->
 * `new`), so writing a category id back as the new status — exactly
 * what a board drag/"Move to" does, see `groupByWorkflowCategory`'s own
 * doc comment — always resolves back into the same column next render,
 * for a built-in type or a project-defined one alike. A status this
 * project has never seen before (a typo, or a custom type's own word
 * for "not started yet") still resolves deterministically rather than
 * vanishing: same `new` default an unset status already fell into.
 */
const LOCAL_STATUS_CATEGORIES_V1: Readonly<Record<string, WorkflowCategoryV1>> = {
  new: 'new',
  indeterminate: 'indeterminate',
  done: 'done',
  todo: 'new',
  'to-do': 'new',
  'to do': 'new',
  backlog: 'new',
  open: 'new',
  unstarted: 'new',
  'not started': 'new',
  'in-progress': 'indeterminate',
  in_progress: 'indeterminate',
  'in progress': 'indeterminate',
  doing: 'indeterminate',
  started: 'indeterminate',
  review: 'indeterminate',
  'in review': 'indeterminate',
  blocked: 'indeterminate',
  wip: 'indeterminate',
  closed: 'done',
  complete: 'done',
  completed: 'done',
  resolved: 'done',
  shipped: 'done',
  cancelled: 'done',
  canceled: 'done',
};

/**
 * Resolves `record`'s workflow category through its own type's
 * `workflowStatus` role, normalized (trimmed, lower-cased) and looked up
 * in {@link LOCAL_STATUS_CATEGORIES_V1}. A record with no resolvable
 * status value at all (an unmapped role, or an empty string) lands in
 * `new` — the same fallback an unrecognized non-empty status gets, one
 * rule rather than two.
 */
export function resolveWorkflowCategory(
  record: TrackerRecordV1,
  types: TrackerTypeRegistryV1,
): WorkflowCategoryV1 {
  const value = resolveRoleValue(record, types, 'workflowStatus');
  if (typeof value !== 'string' || value.length === 0) return 'new';
  return LOCAL_STATUS_CATEGORIES_V1[value.trim().toLowerCase()] ?? 'new';
}

/**
 * Kanban grouping for the board's three fixed columns (issue #651).
 * Always returns all three {@link WORKFLOW_CATEGORIES_V1} keys, in
 * workflow order, even when a category has no records — an empty
 * category still rendering its own column, and still accepting a drop,
 * is this function's own contract, not something layered on top of it
 * in the component, so nothing downstream can skip an empty bucket the
 * way the old per-status `groupByWorkflowStatus` did (a status with zero
 * records simply never appeared as a key). Preserves each bucket's
 * input order.
 */
export function groupByWorkflowCategory(
  records: readonly TrackerRecordV1[],
  types: TrackerTypeRegistryV1,
): Map<WorkflowCategoryV1, TrackerRecordV1[]> {
  const groups = new Map<WorkflowCategoryV1, TrackerRecordV1[]>(
    WORKFLOW_CATEGORIES_V1.map((category) => [category, []]),
  );
  for (const record of records) {
    groups.get(resolveWorkflowCategory(record, types))?.push(record);
  }
  return groups;
}

/**
 * Sorts `records` by each one's `priority` role value, ranked by position
 * in `order` (index 0 sorts first). A record whose resolved priority
 * isn't in `order` (including one with no resolvable priority at all)
 * sorts after every ranked record; ties break by original input order
 * (a stable sort).
 */
export function sortByPriority(
  records: readonly TrackerRecordV1[],
  types: TrackerTypeRegistryV1,
  order: readonly string[],
): TrackerRecordV1[] {
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

/** Filters `records` to those whose `assignee` role value, resolved through each record's own type, equals `assignee` exactly. */
export function filterByAssignee(
  records: readonly TrackerRecordV1[],
  types: TrackerTypeRegistryV1,
  assignee: string,
): TrackerRecordV1[] {
  return records.filter((record) => resolveRoleValue(record, types, 'assignee') === assignee);
}

// ---------------------------------------------------------------------
// tracker_snapshot_request / tracker_snapshot_response — a client asks
// the owning node for its bound session's project: every active record
// (or, with `includeArchived`, every record) plus the project's full type
// set (built-ins + custom). Mirrors `fs_list_request`/`fs_list_response`.
// ---------------------------------------------------------------------

/** The plaintext a `tracker_snapshot_request` envelope decrypts to. */
export const trackerSnapshotRequestPayloadV1 = z
  .object({
    includeArchived: z.boolean().optional(),
  })
  .strict();
export type TrackerSnapshotRequestPayloadV1 = z.infer<typeof trackerSnapshotRequestPayloadV1>;

/** The successful outcome: the bound project's records + full type set. */
export const trackerSnapshotResultV1 = z.object({
  outcome: z.literal('ok'),
  records: z.array(trackerRecordV1),
  types: z.array(trackerTypeDefinitionV1),
});
export type TrackerSnapshotResultV1 = z.infer<typeof trackerSnapshotResultV1>;

/** A failed snapshot fetch (an unreachable/asleep node, a corrupt store, ...) — carried as a payload variant, never a silent drop, so the board/list UI can show a retryable error instead of spinning forever (issue #212's acceptance). */
export const trackerSnapshotErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
  /** SPEC §7.10, issue #631: set only when this error came from `resolveTrackerBackend` failing to compose a live-mode backend — never for a native-mode store failure (corrupt file, unknown id, ...), which has no `TrackerMode` resolution to describe and stays `message`-only. See `trackerBackendResolutionErrorV1`'s own doc comment for why this is a structured union, not a second message string. */
  reason: trackerBackendResolutionErrorV1.optional(),
});
export type TrackerSnapshotErrorV1 = z.infer<typeof trackerSnapshotErrorV1>;

/** The plaintext a `tracker_snapshot_response` envelope decrypts to. */
export const trackerSnapshotResponsePayloadV1 = z.discriminatedUnion('outcome', [
  trackerSnapshotResultV1,
  trackerSnapshotErrorV1,
]);
export type TrackerSnapshotResponsePayloadV1 = z.infer<typeof trackerSnapshotResponsePayloadV1>;

/** Parses and validates a decrypted `tracker_snapshot_request` payload, throwing on an invalid one. */
export function parseTrackerSnapshotRequestPayloadV1(
  data: unknown,
): TrackerSnapshotRequestPayloadV1 {
  return trackerSnapshotRequestPayloadV1.parse(data);
}

/** Same as {@link parseTrackerSnapshotRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseTrackerSnapshotRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TrackerSnapshotRequestPayloadV1> {
  return trackerSnapshotRequestPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `tracker_snapshot_response` payload, throwing on an invalid one. */
export function parseTrackerSnapshotResponsePayloadV1(
  data: unknown,
): TrackerSnapshotResponsePayloadV1 {
  return trackerSnapshotResponsePayloadV1.parse(data);
}

/** Same as {@link parseTrackerSnapshotResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseTrackerSnapshotResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TrackerSnapshotResponsePayloadV1> {
  return trackerSnapshotResponsePayloadV1.safeParse(data);
}

/**
 * A client asks a node for one of its **projects'** tracker snapshot
 * (SPEC §7.10; issues #212, #697).
 *
 * Addressed by `nodeId` + `projectPath`, the same identity every other
 * per-project message already uses (`tracker_mode_get_request`,
 * `account_pin_get_request`) and the same one the node keys its own
 * per-project state by. It was addressed by `sessionId` until #697, which
 * made a project's tracker unreadable whenever no session happened to be
 * running for it — the node answers a session-addressed request only while
 * it holds a live `SessionBridge`, and a bridge exists only for a running
 * agent. A tracker is a property of the project and outlives every session
 * that ever reads it, so the session was never the right scope.
 *
 * `envelope` is sealed to the **project** key (`deriveProjectKey`,
 * `['project', accountId, projectPath]`) rather than a session key, which is
 * what makes a project-scoped read possible without weakening anything: both
 * a node and a client derive it locally from the AMK they already hold, so
 * the relay still sees only ciphertext.
 *
 * The old `targetId` member is gone with the same change. No tracker code
 * ever read it — it came along from the `fs_list_request` shape this pair was
 * modelled on, where the target genuinely picks which host answers.
 */
export const trackerSnapshotRequest = z.object({
  type: z.literal('tracker_snapshot_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TrackerSnapshotRequest = z.infer<typeof trackerSnapshotRequest>;

/**
 * The addressed node's reply, returned to the requesting client (issue #697's
 * `nodeId` addressing means exactly one node is asked, so there is one
 * answerer and no fan-out to filter). `requestId` still correlates it.
 *
 * The node MUST send one for every request it receives, including one it
 * cannot serve: the reply carries `trackerSnapshotErrorV1` for that. Before
 * #697 an unanswerable request was dropped in silence and the client could
 * only time out, which is the same failure #691 documents one layer up.
 */
export const trackerSnapshotResponse = z.object({
  type: z.literal('tracker_snapshot_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TrackerSnapshotResponse = z.infer<typeof trackerSnapshotResponse>;

// ---------------------------------------------------------------------
// tracker_write_request / tracker_write_response — the three writes the
// UI needs (create a record, patch one, define a custom type), folded
// into one additive pair discriminated by `op` rather than three,
// exactly the granularity tradeoff `target-lifecycle.ts`'s own doc
// comment makes explicit for its two ops: each op's request/result shape
// genuinely differs, but all three share the identical "one write, one
// ack" semantics, so one discriminated pair is the accurate shape rather
// than three near-duplicate ones.
// ---------------------------------------------------------------------

const fieldsSchema = z.record(z.string(), z.unknown());
const typeTagsSchema = z.array(z.string().min(1));

/** `op: 'create'` — mirrors `NativeTrackerStore.create`'s `CreateTrackerRecordInput` minus `authorId` (stamped by the node from its own bound account, never client-supplied — the human-UI counterpart of `tracker_create`'s "never from tool input" contract). */
const trackerWriteCreateV1 = z
  .object({
    op: z.literal('create'),
    primaryType: z.string().min(1),
    typeTags: typeTagsSchema.optional(),
    fields: fieldsSchema,
  })
  .strict();

/** `op: 'update'` — mirrors `NativeTrackerStore.update`'s `UpdateTrackerRecordInput`; omitted fields are left as-is. */
const trackerWriteUpdateV1 = z
  .object({
    op: z.literal('update'),
    id: z.string().min(1),
    primaryType: z.string().min(1).optional(),
    typeTags: typeTagsSchema.optional(),
    fields: fieldsSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();

/** `op: 'defineType'` — mirrors `NativeTrackerStore.defineType`'s input; `builtin` is never accepted here (the store always persists custom types as `builtin: false`, matching its own contract). */
const trackerWriteDefineTypeV1 = z
  .object({
    op: z.literal('defineType'),
    id: z.string().min(1),
    label: z.string().min(1),
    roles: z.record(trackerRoleV1, z.string().min(1)),
  })
  .strict();

/** The plaintext a `tracker_write_request` envelope decrypts to. */
export const trackerWriteRequestPayloadV1 = z.discriminatedUnion('op', [
  trackerWriteCreateV1,
  trackerWriteUpdateV1,
  trackerWriteDefineTypeV1,
]);
export type TrackerWriteRequestPayloadV1 = z.infer<typeof trackerWriteRequestPayloadV1>;

/** The successful outcome: the created/updated record, or the defined type — exactly one of the two is set, matching which `op` the request carried. */
export const trackerWriteResultV1 = z.object({
  outcome: z.literal('ok'),
  record: trackerRecordV1.optional(),
  typeDefinition: trackerTypeDefinitionV1.optional(),
});
export type TrackerWriteResultV1 = z.infer<typeof trackerWriteResultV1>;

/** A failed write (unknown type, no such record id, a corrupt store, ...) — carried as a payload variant, never a silent drop. */
export const trackerWriteErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
  /** Mirrors `trackerSnapshotErrorV1.reason` exactly — see that field's own doc comment. */
  reason: trackerBackendResolutionErrorV1.optional(),
});
export type TrackerWriteErrorV1 = z.infer<typeof trackerWriteErrorV1>;

/** The plaintext a `tracker_write_response` envelope decrypts to. */
export const trackerWriteResponsePayloadV1 = z.discriminatedUnion('outcome', [
  trackerWriteResultV1,
  trackerWriteErrorV1,
]);
export type TrackerWriteResponsePayloadV1 = z.infer<typeof trackerWriteResponsePayloadV1>;

/** Parses and validates a decrypted `tracker_write_request` payload, throwing on an invalid one. */
export function parseTrackerWriteRequestPayloadV1(data: unknown): TrackerWriteRequestPayloadV1 {
  return trackerWriteRequestPayloadV1.parse(data);
}

/** Same as {@link parseTrackerWriteRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseTrackerWriteRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TrackerWriteRequestPayloadV1> {
  return trackerWriteRequestPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `tracker_write_response` payload, throwing on an invalid one. */
export function parseTrackerWriteResponsePayloadV1(data: unknown): TrackerWriteResponsePayloadV1 {
  return trackerWriteResponsePayloadV1.parse(data);
}

/** Same as {@link parseTrackerWriteResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseTrackerWriteResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TrackerWriteResponsePayloadV1> {
  return trackerWriteResponsePayloadV1.safeParse(data);
}

/**
 * A client asks a node to create/update a record or define a custom type
 * against one of its projects (SPEC §7.10; issues #212, #697).
 *
 * Addressed and sealed exactly like {@link trackerSnapshotRequest} — see its
 * doc comment for why the project, not a session, is the scope. Keeping the
 * two identical is deliberate: a read and a write that disagreed about which
 * tracker they mean is the divergence `resolveTrackerDispatch` exists to
 * prevent on the node side, and it would be reintroduced here if only one of
 * them moved.
 */
export const trackerWriteRequest = z.object({
  type: z.literal('tracker_write_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TrackerWriteRequest = z.infer<typeof trackerWriteRequest>;

/** The addressed node's reply, returned to the requesting client. Same contract as {@link trackerSnapshotResponse}, including that one is always sent — `trackerWriteErrorV1` carries a refusal. */
export const trackerWriteResponse = z.object({
  type: z.literal('tracker_write_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TrackerWriteResponse = z.infer<typeof trackerWriteResponse>;
