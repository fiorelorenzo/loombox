import { describe, expect, it } from 'vitest';
import {
  buildTrackerTypeRegistryV1,
  filterByAssignee,
  groupByWorkflowStatus,
  resolveRoleValue,
  safeParseTrackerSnapshotResponsePayloadV1,
  safeParseTrackerWriteRequestPayloadV1,
  safeParseTrackerWriteResponsePayloadV1,
  sortByPriority,
  trackerRecordV1,
  trackerSnapshotRequest,
  trackerSnapshotResponse,
  trackerTypeDefinitionV1,
  trackerWriteRequest,
  trackerWriteResponse,
  UNRESOLVED_WORKFLOW_STATUS,
  type TrackerRecordV1,
  type TrackerTypeDefinitionV1,
} from './tracker-records';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

const TASK_TYPE: TrackerTypeDefinitionV1 = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

/** A project-defined custom type — every role points at a deliberately different `fields` key than `TASK_TYPE`, so a test passing only because it happens to reuse `fields.status`/etc. would fail here (mirrors `@loombox/shared/tracker-record.test.ts`'s own `CUSTOM_FEATURE_REQUEST_TYPE`). */
const CUSTOM_TYPE: TrackerTypeDefinitionV1 = {
  id: 'feature-request',
  label: 'Feature Request',
  builtin: false,
  roles: { title: 'summary', workflowStatus: 'stage', priority: 'urgency', assignee: 'owner' },
};

function makeSystem(): TrackerRecordV1['system'] {
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
  type: TrackerTypeDefinitionV1,
  id: string,
  roleValues: { status?: string; priority?: string; assignee?: string },
): TrackerRecordV1 {
  const statusKey = type.roles.workflowStatus!;
  const priorityKey = type.roles.priority!;
  const assigneeKey = type.roles.assignee!;
  const fields: Record<string, unknown> = {};
  if (roleValues.status !== undefined) fields[statusKey] = roleValues.status;
  if (roleValues.priority !== undefined) fields[priorityKey] = roleValues.priority;
  if (roleValues.assignee !== undefined) fields[assigneeKey] = roleValues.assignee;
  return {
    id,
    primaryType: type.id,
    typeTags: [],
    issueNumber: 1,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    fields,
    system: makeSystem(),
  };
}

describe('trackerTypeDefinitionV1', () => {
  it('accepts a partial roles mapping', () => {
    expect(trackerTypeDefinitionV1.safeParse(CUSTOM_TYPE).success).toBe(true);
  });

  it('rejects an unknown role name', () => {
    const result = trackerTypeDefinitionV1.safeParse({
      ...CUSTOM_TYPE,
      roles: { ...CUSTOM_TYPE.roles, notARole: 'x' },
    });
    expect(result.success).toBe(false);
  });
});

describe('resolveRoleValue', () => {
  it('reads through a built-in type', () => {
    const types = buildTrackerTypeRegistryV1([TASK_TYPE]);
    const record = makeRecord(TASK_TYPE, 'r1', { status: 'todo' });
    expect(resolveRoleValue(record, types, 'workflowStatus')).toBe('todo');
  });

  it("reads through a custom type's own roles mapping", () => {
    const types = buildTrackerTypeRegistryV1([CUSTOM_TYPE]);
    const record = makeRecord(CUSTOM_TYPE, 'r1', { status: 'in-review' });
    expect(resolveRoleValue(record, types, 'workflowStatus')).toBe('in-review');
  });

  it('returns undefined for an unknown primaryType', () => {
    const types = buildTrackerTypeRegistryV1([TASK_TYPE]);
    const record = makeRecord(TASK_TYPE, 'r1', { status: 'todo' });
    expect(resolveRoleValue({ ...record, primaryType: 'ghost' }, types, 'workflowStatus')).toBe(
      undefined,
    );
  });
});

describe.each<{ name: string; type: TrackerTypeDefinitionV1 }>([
  { name: 'built-in Task', type: TASK_TYPE },
  { name: 'custom Feature Request', type: CUSTOM_TYPE },
])('kanban grouping, priority sort, and assignee filter — $name', ({ type }) => {
  const types = buildTrackerTypeRegistryV1([type]);
  const todo = makeRecord(type, 'todo-1', { status: 'todo', priority: 'high', assignee: 'ada' });
  const doing = makeRecord(type, 'doing-1', {
    status: 'doing',
    priority: 'low',
    assignee: 'lin',
  });
  const noStatus = makeRecord(type, 'none-1', { priority: 'high', assignee: 'ada' });
  const records = [todo, doing, noStatus];

  it('groups by workflowStatus, bucketing an unresolved value under UNRESOLVED_WORKFLOW_STATUS', () => {
    const groups = groupByWorkflowStatus(records, types);
    expect(groups.get('todo')).toEqual([todo]);
    expect(groups.get('doing')).toEqual([doing]);
    expect(groups.get(UNRESOLVED_WORKFLOW_STATUS)).toEqual([noStatus]);
  });

  it('sorts by priority rank, unranked/unresolved last, ties stable', () => {
    const sorted = sortByPriority(records, types, ['high', 'low']);
    expect(sorted.map((r) => r.id)).toEqual(['todo-1', 'none-1', 'doing-1']);
  });

  it('filters by exact assignee match', () => {
    expect(filterByAssignee(records, types, 'ada').map((r) => r.id)).toEqual(['todo-1', 'none-1']);
  });
});

describe('trackerSnapshotResponsePayloadV1', () => {
  it('parses the ok outcome with records and types', () => {
    const record = makeRecord(TASK_TYPE, 'r1', { status: 'todo' });
    const result = safeParseTrackerSnapshotResponsePayloadV1({
      outcome: 'ok',
      records: [record],
      types: [TASK_TYPE],
    });
    expect(result.success).toBe(true);
  });

  it('parses the error outcome', () => {
    const result = safeParseTrackerSnapshotResponsePayloadV1({
      outcome: 'error',
      message: 'node unreachable',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseTrackerSnapshotResponsePayloadV1({ outcome: 'pending' }).success).toBe(false);
  });
});

describe('trackerWriteRequestPayloadV1', () => {
  it('accepts a create op', () => {
    const result = safeParseTrackerWriteRequestPayloadV1({
      op: 'create',
      primaryType: 'task',
      fields: { title: 'Ship it' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an update op with only some fields patched', () => {
    const result = safeParseTrackerWriteRequestPayloadV1({
      op: 'update',
      id: 'r1',
      archived: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a defineType op', () => {
    const result = safeParseTrackerWriteRequestPayloadV1({
      op: 'defineType',
      id: 'feature-request',
      label: 'Feature Request',
      roles: { title: 'summary' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects create with an authorId field — the wire has no such input', () => {
    const result = safeParseTrackerWriteRequestPayloadV1({
      op: 'create',
      primaryType: 'task',
      fields: {},
      authorId: 'spoofed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown op', () => {
    expect(safeParseTrackerWriteRequestPayloadV1({ op: 'delete', id: 'r1' }).success).toBe(false);
  });
});

describe('trackerWriteResponsePayloadV1', () => {
  it('parses an ok outcome carrying a record', () => {
    const record = makeRecord(TASK_TYPE, 'r1', { status: 'todo' });
    expect(safeParseTrackerWriteResponsePayloadV1({ outcome: 'ok', record }).success).toBe(true);
  });

  it('parses an ok outcome carrying a typeDefinition', () => {
    expect(
      safeParseTrackerWriteResponsePayloadV1({ outcome: 'ok', typeDefinition: CUSTOM_TYPE })
        .success,
    ).toBe(true);
  });

  it('parses the error outcome', () => {
    expect(
      safeParseTrackerWriteResponsePayloadV1({ outcome: 'error', message: 'unknown type' }).success,
    ).toBe(true);
  });
});

describe('trackerRecordV1', () => {
  it('round-trips a full record', () => {
    const record = makeRecord(TASK_TYPE, 'r1', { status: 'todo', priority: 'high' });
    expect(trackerRecordV1.safeParse(record).success).toBe(true);
  });
});

describe('tracker_snapshot_request / tracker_snapshot_response (the top-level wire messages)', () => {
  it('parses a well-formed snapshot request', () => {
    const result = trackerSnapshotRequest.safeParse({
      type: 'tracker_snapshot_request',
      protocolVersion: 1,
      sessionId: 'session-1',
      targetId: 'local',
      requestId: 'req-1',
      envelope,
    });
    expect(result.success).toBe(true);
  });

  it('parses a well-formed snapshot response', () => {
    const result = trackerSnapshotResponse.safeParse({
      type: 'tracker_snapshot_response',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
    });
    expect(result.success).toBe(true);
  });
});

describe('tracker_write_request / tracker_write_response (the top-level wire messages)', () => {
  it('parses a well-formed write request', () => {
    const result = trackerWriteRequest.safeParse({
      type: 'tracker_write_request',
      protocolVersion: 1,
      sessionId: 'session-1',
      targetId: 'local',
      requestId: 'req-2',
      envelope,
    });
    expect(result.success).toBe(true);
  });

  it('parses a well-formed write response', () => {
    const result = trackerWriteResponse.safeParse({
      type: 'tracker_write_response',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-2',
      envelope,
    });
    expect(result.success).toBe(true);
  });
});
