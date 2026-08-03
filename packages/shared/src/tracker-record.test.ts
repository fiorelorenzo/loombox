import { describe, expect, it } from 'vitest';
import {
  BUG_TRACKER_TYPE,
  buildTrackerIndex,
  buildTrackerTypeRegistry,
  EPIC_TRACKER_TYPE,
  filterByAssignee,
  groupByWorkflowStatus,
  resolveRoleValue,
  sortByPriority,
  TASK_TRACKER_TYPE,
  UNRESOLVED_WORKFLOW_STATUS,
  type TrackerRecord,
  type TrackerTypeDefinition,
} from './tracker-record';

/** A project-defined custom type (issue #210's "own `roles` mapping" example) — every role points at a deliberately different `fields` key than the built-ins, so a test passing only because it happens to reuse `fields.title`/`fields.status`/etc. would fail here. */
const CUSTOM_FEATURE_REQUEST_TYPE: TrackerTypeDefinition = {
  id: 'feature-request',
  label: 'Feature Request',
  builtin: false,
  roles: { title: 'summary', workflowStatus: 'stage', priority: 'urgency', assignee: 'owner' },
};

function makeSystem(): TrackerRecord['system'] {
  return {
    authorId: 'author-1',
    linkedCommitSha: [],
    linkedPullRequests: [],
    linkedSessionIds: [],
    activity: [],
    comments: [],
  };
}

function makeRecord(
  type: TrackerTypeDefinition,
  id: string,
  roleValues: { status?: string; priority?: string; assignee?: string },
): TrackerRecord {
  const fields: Record<string, unknown> = {};
  if (type.roles.title !== undefined) fields[type.roles.title] = `Title for ${id}`;
  if (type.roles.workflowStatus !== undefined && roleValues.status !== undefined) {
    fields[type.roles.workflowStatus] = roleValues.status;
  }
  if (type.roles.priority !== undefined && roleValues.priority !== undefined) {
    fields[type.roles.priority] = roleValues.priority;
  }
  if (type.roles.assignee !== undefined && roleValues.assignee !== undefined) {
    fields[type.roles.assignee] = roleValues.assignee;
  }
  return {
    id,
    primaryType: type.id,
    typeTags: [],
    issueNumber: Number(id.replace(/\D/g, '')) || 1,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    fields,
    system: makeSystem(),
  };
}

describe('resolveRoleValue', () => {
  it("resolves through a type's own roles mapping and returns undefined for an unmapped role or unknown primaryType", () => {
    const registry = buildTrackerTypeRegistry([CUSTOM_FEATURE_REQUEST_TYPE]);
    const task = makeRecord(TASK_TRACKER_TYPE, 'r1', { status: 'todo' });
    expect(resolveRoleValue(task, registry, 'workflowStatus')).toBe('todo');

    const typeless: TrackerRecord = { ...task, primaryType: 'not-a-registered-type' };
    expect(resolveRoleValue(typeless, registry, 'workflowStatus')).toBeUndefined();

    const noPriorityRole: TrackerTypeDefinition = {
      id: 'note',
      label: 'Note',
      builtin: false,
      roles: {},
    };
    const noteRecord = makeRecord(noPriorityRole, 'r2', { priority: 'p0' });
    const noteRegistry = buildTrackerTypeRegistry([noPriorityRole]);
    expect(resolveRoleValue(noteRecord, noteRegistry, 'priority')).toBeUndefined();
  });
});

/**
 * Issue #210's central acceptance criterion: kanban grouping, priority
 * sort, and assignee filter all work identically for a built-in type and a
 * project-defined custom type, driven entirely through `roles` — one test
 * body, run against both. `CUSTOM_FEATURE_REQUEST_TYPE` above maps every
 * role to a field key that shares no name with `TASK_TRACKER_TYPE`'s, so
 * this can only pass if the query helpers genuinely read through `roles`
 * rather than a hardcoded `fields.status`/`fields.assignee`.
 */
describe.each<{ name: string; type: TrackerTypeDefinition }>([
  { name: 'built-in Task', type: TASK_TRACKER_TYPE },
  { name: 'project-defined custom type', type: CUSTOM_FEATURE_REQUEST_TYPE },
])('kanban grouping, priority sort, and assignee filter — $name', ({ type }) => {
  it('produce identical results driven through the roles mapping', () => {
    const registry = buildTrackerTypeRegistry(type.builtin ? [] : [type]);
    const records = [
      makeRecord(type, 'r1', { status: 'todo', priority: 'p1', assignee: 'alice' }),
      makeRecord(type, 'r2', { status: 'in_progress', priority: 'p0', assignee: 'bob' }),
      makeRecord(type, 'r3', { status: 'todo', priority: 'p2', assignee: 'alice' }),
      makeRecord(type, 'r4', { assignee: 'alice' }), // no status/priority set at all
    ];

    const groups = groupByWorkflowStatus(records, registry);
    expect([...groups.keys()].sort()).toEqual(
      ['in_progress', 'todo', UNRESOLVED_WORKFLOW_STATUS].sort(),
    );
    expect(groups.get('todo')?.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(groups.get('in_progress')?.map((r) => r.id)).toEqual(['r2']);
    expect(groups.get(UNRESOLVED_WORKFLOW_STATUS)?.map((r) => r.id)).toEqual(['r4']);

    const sorted = sortByPriority(records, registry, ['p0', 'p1', 'p2']);
    expect(sorted.map((r) => r.id)).toEqual(['r2', 'r1', 'r3', 'r4']);

    const aliceItems = filterByAssignee(records, registry, 'alice');
    expect(aliceItems.map((r) => r.id)).toEqual(['r1', 'r3', 'r4']);

    const carolItems = filterByAssignee(records, registry, 'carol');
    expect(carolItems).toEqual([]);
  });
});

describe('buildTrackerIndex', () => {
  it('indexes by id, issueNumber, primaryType, and typeTags, and partitions active/archived', () => {
    const task = {
      ...makeRecord(TASK_TRACKER_TYPE, 't1', {}),
      issueNumber: 1,
      typeTags: ['urgent', 'backend'],
    };
    const bug = {
      ...makeRecord(BUG_TRACKER_TYPE, 'b1', {}),
      issueNumber: 2,
      archived: true,
      typeTags: ['urgent'],
    };
    const epic = { ...makeRecord(EPIC_TRACKER_TYPE, 'e1', {}), issueNumber: 3 };
    const index = buildTrackerIndex([task, bug, epic]);

    expect(index.byId.get('t1')).toBe(task);
    expect(index.byIssueNumber.get(task.issueNumber)).toBe(task);
    expect(index.byPrimaryType.get('task')).toEqual([task]);
    expect(index.byPrimaryType.get('bug')).toEqual([bug]);
    expect(index.byTypeTag.get('urgent')).toEqual([task, bug]);
    expect(index.byTypeTag.get('backend')).toEqual([task]);
    expect(index.active.map((r) => r.id)).toEqual(['t1', 'e1']);
    expect(index.archived.map((r) => r.id)).toEqual(['b1']);
  });
});

/**
 * Issue #210 acceptance: "No `syncStatus`/team-sync columns are present".
 * `tracker-record.ts` also carries a compile-time guard (`AssertNever<...>`
 * over `ForbiddenSyncKeys`) that fails `tsc` outright if either type ever
 * gains one of these keys; this is the runtime half, checking a real
 * constructed record and its JSON-serialized form (what actually reaches
 * disk through `NativeTrackerStore`) rather than the type declaration.
 */
describe('no sync columns', () => {
  const FORBIDDEN_KEYS = [
    'syncStatus',
    'syncedAt',
    'lastSyncedAt',
    'remoteSyncState',
    'teamSyncStatus',
    'conflictState',
  ];

  it('never appear on a constructed TrackerRecord or its system object', () => {
    const record = makeRecord(TASK_TRACKER_TYPE, 'r1', {
      status: 'todo',
      priority: 'p1',
      assignee: 'alice',
    });
    for (const key of FORBIDDEN_KEYS) {
      expect(Object.keys(record)).not.toContain(key);
      expect(Object.keys(record.system)).not.toContain(key);
    }
  });

  it('never appear after a JSON round trip (the actual persisted shape)', () => {
    const record = makeRecord(TASK_TRACKER_TYPE, 'r1', {
      status: 'todo',
      priority: 'p1',
      assignee: 'alice',
    });
    const persisted = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    for (const key of FORBIDDEN_KEYS) {
      expect(Object.keys(persisted)).not.toContain(key);
    }
  });
});
