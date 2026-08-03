import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_TRACKER_TYPES,
  filterByAssignee,
  groupByWorkflowStatus,
  sortByPriority,
  TASK_TRACKER_TYPE,
  type TrackerTypeDefinition,
} from '@loombox/shared';

import { NativeTrackerStore, NativeTrackerStoreError } from './native-tracker-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-native-tracker-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const PROJECT = '/home/dev/projects/loombox-demo';

/** A project-defined custom type — every role maps to a `fields` key distinct from the built-ins', so a test that only accidentally reuses `fields.status`/`fields.assignee` fails here. */
const FEATURE_REQUEST_TYPE: TrackerTypeDefinition = {
  id: 'feature-request',
  label: 'Feature Request',
  builtin: false,
  roles: { title: 'summary', workflowStatus: 'stage', priority: 'urgency', assignee: 'owner' },
};

describe('NativeTrackerStore', () => {
  describe('types', () => {
    it('listTypes() starts with only the three built-ins for a project with no custom types', () => {
      const store = new NativeTrackerStore({ stateDir });
      expect(store.listTypes(PROJECT)).toEqual(BUILTIN_TRACKER_TYPES);
    });

    it('defineType() registers a custom type alongside the built-ins, scoped per project', () => {
      const store = new NativeTrackerStore({ stateDir });
      store.defineType(PROJECT, FEATURE_REQUEST_TYPE);
      expect(store.listTypes(PROJECT)).toEqual([...BUILTIN_TRACKER_TYPES, FEATURE_REQUEST_TYPE]);
      expect(store.listTypes('/other/project')).toEqual(BUILTIN_TRACKER_TYPES);
    });

    it('defineType() replaces an existing custom type with the same id', () => {
      const store = new NativeTrackerStore({ stateDir });
      store.defineType(PROJECT, FEATURE_REQUEST_TYPE);
      const revised = { ...FEATURE_REQUEST_TYPE, label: 'Feature Request (revised)' };
      store.defineType(PROJECT, revised);
      const types = store.listTypes(PROJECT);
      expect(types).toHaveLength(4);
      expect(types.at(-1)).toEqual(revised);
    });

    it('defineType() rejects an id colliding with a built-in type', () => {
      const store = new NativeTrackerStore({ stateDir });
      expect(() => store.defineType(PROJECT, { ...FEATURE_REQUEST_TYPE, id: 'task' })).toThrow(
        NativeTrackerStoreError,
      );
    });

    it('defineType() rejects builtin: true', () => {
      const store = new NativeTrackerStore({ stateDir });
      expect(() => store.defineType(PROJECT, { ...FEATURE_REQUEST_TYPE, builtin: true })).toThrow(
        NativeTrackerStoreError,
      );
    });
  });

  describe('create() / get()', () => {
    it('round-trips a built-in Task record: assigns id, issueNumber, timestamps, and a seeded system', () => {
      const store = new NativeTrackerStore({ stateDir });
      const record = store.create(PROJECT, {
        primaryType: 'task',
        fields: { title: 'Ship it', status: 'todo', priority: 'p1', assignee: 'alice' },
        authorId: 'author-1',
      });
      expect(record.id).toBeTruthy();
      expect(record.primaryType).toBe('task');
      expect(record.issueNumber).toBe(1);
      expect(record.archived).toBe(false);
      expect(record.typeTags).toEqual([]);
      expect(record.fields).toEqual({
        title: 'Ship it',
        status: 'todo',
        priority: 'p1',
        assignee: 'alice',
      });
      expect(record.system.authorId).toBe('author-1');
      expect(record.system.activity).toHaveLength(1);
      expect(record.system.activity[0]?.kind).toBe('created');

      expect(store.get(PROJECT, record.id)).toEqual(record);
    });

    it('round-trips a project-defined custom type record identically', () => {
      const store = new NativeTrackerStore({ stateDir });
      store.defineType(PROJECT, FEATURE_REQUEST_TYPE);
      const record = store.create(PROJECT, {
        primaryType: 'feature-request',
        typeTags: ['growth'],
        fields: { summary: 'Dark mode', stage: 'todo', urgency: 'p1', owner: 'alice' },
        authorId: 'author-1',
      });
      expect(record.primaryType).toBe('feature-request');
      expect(record.typeTags).toEqual(['growth']);
      expect(store.get(PROJECT, record.id)).toEqual(record);
    });

    it('assigns sequential issueNumbers per project, independent of type', () => {
      const store = new NativeTrackerStore({ stateDir });
      store.defineType(PROJECT, FEATURE_REQUEST_TYPE);
      const a = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
      const b = store.create(PROJECT, {
        primaryType: 'feature-request',
        fields: {},
        authorId: 'a',
      });
      const c = store.create('/other/project', { primaryType: 'task', fields: {}, authorId: 'a' });
      expect([a.issueNumber, b.issueNumber]).toEqual([1, 2]);
      expect(c.issueNumber).toBe(1); // a different project's sequence starts over
    });

    it('rejects an unknown primaryType', () => {
      const store = new NativeTrackerStore({ stateDir });
      expect(() =>
        store.create(PROJECT, { primaryType: 'not-a-type', fields: {}, authorId: 'a' }),
      ).toThrow(NativeTrackerStoreError);
    });

    it('get() returns undefined for a missing id', () => {
      const store = new NativeTrackerStore({ stateDir });
      expect(store.get(PROJECT, 'nope')).toBeUndefined();
    });
  });

  describe('update()', () => {
    it('patches fields/typeTags/archived and bumps updatedAt, leaving system untouched', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1000);
        const store = new NativeTrackerStore({ stateDir });
        const created = store.create(PROJECT, {
          primaryType: 'task',
          fields: { title: 'Ship it', status: 'todo' },
          authorId: 'author-1',
        });
        vi.setSystemTime(2000);
        const updated = store.update(PROJECT, created.id, {
          fields: { title: 'Ship it', status: 'in_progress' },
          typeTags: ['urgent'],
          archived: true,
        });
        expect(updated.fields.status).toBe('in_progress');
        expect(updated.typeTags).toEqual(['urgent']);
        expect(updated.archived).toBe(true);
        expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
        expect(updated.system).toEqual(created.system);
        expect(updated.createdAt).toBe(created.createdAt);
        expect(updated.issueNumber).toBe(created.issueNumber);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws for an unknown record id', () => {
      const store = new NativeTrackerStore({ stateDir });
      expect(() => store.update(PROJECT, 'nope', { archived: true })).toThrow(
        NativeTrackerStoreError,
      );
    });
  });

  describe('system mutation: linkSession() / linkCommit() / linkPullRequest() / addComment()', () => {
    it('append to the right system list and record matching activity', () => {
      const store = new NativeTrackerStore({ stateDir });
      const created = store.create(PROJECT, {
        primaryType: 'task',
        fields: {},
        authorId: 'author-1',
      });

      const withSession = store.linkSession(PROJECT, created.id, 'session-1');
      expect(withSession.system.linkedSessionIds).toEqual(['session-1']);

      const withCommit = store.linkCommit(PROJECT, created.id, 'abc123');
      expect(withCommit.system.linkedCommitSha).toEqual(['abc123']);

      const withPr = store.linkPullRequest(PROJECT, created.id, 'fiorelorenzo/loombox#42');
      expect(withPr.system.linkedPullRequests).toEqual(['fiorelorenzo/loombox#42']);

      const withComment = store.addComment(PROJECT, created.id, 'author-1', 'looks good');
      expect(withComment.system.comments).toHaveLength(1);
      expect(withComment.system.comments[0]?.body).toBe('looks good');

      // every link/comment also landed on the same record, cumulatively
      const final = store.get(PROJECT, created.id)!;
      expect(final.system.linkedSessionIds).toEqual(['session-1']);
      expect(final.system.linkedCommitSha).toEqual(['abc123']);
      expect(final.system.linkedPullRequests).toEqual(['fiorelorenzo/loombox#42']);
      expect(final.system.comments).toHaveLength(1);
      // created + 4 system mutations
      expect(final.system.activity.map((entry) => entry.kind)).toEqual([
        'created',
        'session_linked',
        'commit_linked',
        'pull_request_linked',
      ]);
    });
  });

  describe('list()', () => {
    it('excludes archived records by default and includes them with includeArchived: true', () => {
      const store = new NativeTrackerStore({ stateDir });
      const active = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
      const archived = store.create(PROJECT, { primaryType: 'bug', fields: {}, authorId: 'a' });
      store.update(PROJECT, archived.id, { archived: true });

      expect(store.list(PROJECT).map((r) => r.id)).toEqual([active.id]);
      expect(
        store
          .list(PROJECT, { includeArchived: true })
          .map((r) => r.id)
          .sort(),
      ).toEqual([active.id, archived.id].sort());
    });

    it('filters by primaryType and typeTag', () => {
      const store = new NativeTrackerStore({ stateDir });
      const task = store.create(PROJECT, {
        primaryType: 'task',
        typeTags: ['backend'],
        fields: {},
        authorId: 'a',
      });
      store.create(PROJECT, {
        primaryType: 'bug',
        typeTags: ['backend'],
        fields: {},
        authorId: 'a',
      });

      expect(store.list(PROJECT, { primaryType: 'task' }).map((r) => r.id)).toEqual([task.id]);
      expect(
        store
          .list(PROJECT, { typeTag: 'backend' })
          .map((r) => r.id)
          .sort(),
      ).toHaveLength(2);
    });
  });

  describe('index()', () => {
    it('reflects the same real, queryable columns list() and get() use — id/primaryType/typeTags/issueNumber/archived', () => {
      const store = new NativeTrackerStore({ stateDir });
      const record = store.create(PROJECT, {
        primaryType: 'task',
        typeTags: ['urgent'],
        fields: {},
        authorId: 'a',
      });
      const index = store.index(PROJECT);
      expect(index.byId.get(record.id)).toEqual(record);
      expect(index.byIssueNumber.get(record.issueNumber)).toEqual(record);
      expect(index.byPrimaryType.get('task')).toEqual([record]);
      expect(index.byTypeTag.get('urgent')).toEqual([record]);
      expect(index.active).toEqual([record]);
      expect(index.archived).toEqual([]);
    });
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir)', () => {
    const first = new NativeTrackerStore({ stateDir });
    first.defineType(PROJECT, FEATURE_REQUEST_TYPE);
    const record = first.create(PROJECT, {
      primaryType: 'feature-request',
      fields: { summary: 'Dark mode' },
      authorId: 'author-1',
    });

    const second = new NativeTrackerStore({ stateDir });
    expect(second.get(PROJECT, record.id)).toEqual(record);
    expect(second.listTypes(PROJECT)).toEqual([...BUILTIN_TRACKER_TYPES, FEATURE_REQUEST_TYPE]);
  });

  /**
   * Issue #210's central acceptance criterion, exercised through the real
   * storage layer rather than hand-built fixtures: a kanban grouping, a
   * priority sort, and an assignee filter — `@loombox/shared`'s
   * `groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee` — driven by
   * `store.typeRegistry()` + `store.list()`, produce the same shape of
   * result for a built-in Task and a project-defined custom type. One test
   * body, run against both.
   */
  describe.each<{
    name: string;
    type: TrackerTypeDefinition;
    fieldsFor: (args: TicketArgs) => Record<string, unknown>;
  }>([
    {
      name: 'built-in Task',
      type: TASK_TRACKER_TYPE,
      fieldsFor: ({ status, priority, assignee }) => ({ status, priority, assignee }),
    },
    {
      name: 'project-defined custom type',
      type: FEATURE_REQUEST_TYPE,
      fieldsFor: ({ status, priority, assignee }) => ({
        stage: status,
        urgency: priority,
        owner: assignee,
      }),
    },
  ])('kanban/priority/assignee through the real store — $name', ({ type, fieldsFor }) => {
    it('group, sort, and filter identically once wired through typeRegistry() + list()', () => {
      const store = new NativeTrackerStore({ stateDir });
      if (!type.builtin) store.defineType(PROJECT, type);
      store.create(PROJECT, {
        primaryType: type.id,
        fields: fieldsFor({ status: 'todo', priority: 'p1', assignee: 'alice' }),
        authorId: 'a',
      });
      store.create(PROJECT, {
        primaryType: type.id,
        fields: fieldsFor({ status: 'in_progress', priority: 'p0', assignee: 'bob' }),
        authorId: 'a',
      });
      store.create(PROJECT, {
        primaryType: type.id,
        fields: fieldsFor({ status: 'todo', priority: 'p2', assignee: 'alice' }),
        authorId: 'a',
      });

      const registry = store.typeRegistry(PROJECT);
      const records = store.list(PROJECT);

      const groups = groupByWorkflowStatus(records, registry);
      expect(groups.get('todo')).toHaveLength(2);
      expect(groups.get('in_progress')).toHaveLength(1);

      const sorted = sortByPriority(records, registry, ['p0', 'p1', 'p2']);
      expect(sorted.map((r) => r.fields[type.roles.priority!])).toEqual(['p0', 'p1', 'p2']);

      const aliceItems = filterByAssignee(records, registry, 'alice');
      expect(aliceItems).toHaveLength(2);
    });
  });

  describe('no sync columns', () => {
    const FORBIDDEN_KEYS = [
      'syncStatus',
      'syncedAt',
      'lastSyncedAt',
      'remoteSyncState',
      'teamSyncStatus',
      'conflictState',
    ];

    it('never appear on disk, checked against the raw persisted JSON of a fully-populated record', async () => {
      const store = new NativeTrackerStore({ stateDir });
      const record = store.create(PROJECT, {
        primaryType: 'task',
        typeTags: ['urgent'],
        fields: { title: 'Ship it', status: 'todo', priority: 'p1', assignee: 'alice' },
        authorId: 'author-1',
      });
      store.linkSession(PROJECT, record.id, 'session-1');
      store.linkCommit(PROJECT, record.id, 'abc123');
      store.linkPullRequest(PROJECT, record.id, 'fiorelorenzo/loombox#42');
      store.addComment(PROJECT, record.id, 'author-1', 'looks good');

      const raw = await readFile(path.join(stateDir, 'native-tracker.json'), 'utf8');
      const lowerRaw = raw.toLowerCase();
      for (const key of FORBIDDEN_KEYS) {
        expect(lowerRaw).not.toContain(key.toLowerCase());
      }
    });
  });

  describe('on-disk validation', () => {
    it('throws NativeTrackerStoreError for a file that is not valid JSON', async () => {
      await writeFile(path.join(stateDir, 'native-tracker.json'), 'not json', 'utf8');
      const store = new NativeTrackerStore({ stateDir });
      expect(() => store.get(PROJECT, 'anything')).toThrow(NativeTrackerStoreError);
    });

    it('throws NativeTrackerStoreError for a record missing a required field', async () => {
      const file = {
        v: 1,
        projects: {
          [PROJECT]: {
            customTypes: [],
            nextIssueNumber: 2,
            records: [{ id: 'r1', primaryType: 'task' /* missing issueNumber, archived, etc. */ }],
          },
        },
      };
      await writeFile(path.join(stateDir, 'native-tracker.json'), JSON.stringify(file), 'utf8');
      const store = new NativeTrackerStore({ stateDir });
      expect(() => store.list(PROJECT)).toThrow(NativeTrackerStoreError);
    });
  });
});

interface TicketArgs {
  status: string;
  priority: string;
  assignee: string;
}
