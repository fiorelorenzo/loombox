import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NativeTrackerStore } from './native-tracker-store';
import {
  createTrackerMcpTools,
  TrackerMcpToolError,
  type TrackerGetToolOutput,
  type TrackerListToolOutput,
  type TrackerMcpTool,
  type TrackerRecordToolOutput,
} from './tracker-mcp-tools';

let stateDir: string;
let store: NativeTrackerStore;

const PROJECT_A = '/home/dev/projects/loombox-demo';
const PROJECT_B = '/home/dev/projects/other-project';

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-tracker-mcp-tools-test-'));
  store = new NativeTrackerStore({ stateDir });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** Finds a tool by name out of the array `createTrackerMcpTools` returns, typed to the caller's expected input/output. */
function toolFor<TInput, TOutput>(
  tools: readonly TrackerMcpTool[],
  name: string,
): TrackerMcpTool<TInput, TOutput> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool named "${name}"`);
  return tool as TrackerMcpTool<TInput, TOutput>;
}

function toolsFor(projectPath: string, overrides: { authorId?: string; sessionId?: string } = {}) {
  return createTrackerMcpTools({
    store,
    projectPath,
    authorId: overrides.authorId ?? 'author-1',
    sessionId: overrides.sessionId ?? 'session-1',
  });
}

describe('createTrackerMcpTools', () => {
  it('registers exactly the five tools SPEC §7.10 names', () => {
    const tools = toolsFor(PROJECT_A);
    expect(tools.map((tool) => tool.name)).toEqual([
      'tracker_list',
      'tracker_get',
      'tracker_create',
      'tracker_update',
      'tracker_link_session',
    ]);
  });

  describe('tracker_create', () => {
    it('creates a record, stamping system.authorId from context, never from input', async () => {
      const tools = toolsFor(PROJECT_A, { authorId: 'agent-session-author' });
      const create = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_create');
      const { record } = await create.execute({
        primaryType: 'task',
        fields: { title: 'Ship it', status: 'todo' },
      });
      expect(record.primaryType).toBe('task');
      expect(record.fields).toEqual({ title: 'Ship it', status: 'todo' });
      expect(record.system.authorId).toBe('agent-session-author');
      expect(store.get(PROJECT_A, record.id)).toEqual(record);
    });

    it('rejects an authorId supplied in input — the schema has no such field', async () => {
      const tools = toolsFor(PROJECT_A);
      const create = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_create');
      await expect(
        create.execute({ primaryType: 'task', fields: {}, authorId: 'spoofed' }),
      ).rejects.toThrow(TrackerMcpToolError);
    });

    it('rejects a missing primaryType', async () => {
      const tools = toolsFor(PROJECT_A);
      const create = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_create');
      await expect(create.execute({ fields: {} })).rejects.toThrow(TrackerMcpToolError);
    });

    it('wraps an unknown primaryType as a TrackerMcpToolError naming the tool', async () => {
      const tools = toolsFor(PROJECT_A);
      const create = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_create');
      await expect(create.execute({ primaryType: 'not-a-type', fields: {} })).rejects.toMatchObject(
        { tool: 'tracker_create' },
      );
    });
  });

  describe('tracker_get', () => {
    it('fetches by id', async () => {
      const created = store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      const tools = toolsFor(PROJECT_A);
      const get = toolFor<unknown, TrackerGetToolOutput>(tools, 'tracker_get');
      const { record } = await get.execute({ id: created.id });
      expect(record).toEqual(created);
    });

    it('fetches by issueNumber', async () => {
      const created = store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      const tools = toolsFor(PROJECT_A);
      const get = toolFor<unknown, TrackerGetToolOutput>(tools, 'tracker_get');
      const { record } = await get.execute({ issueNumber: created.issueNumber });
      expect(record).toEqual(created);
    });

    it('returns record: null for a missing id, rather than throwing', async () => {
      const tools = toolsFor(PROJECT_A);
      const get = toolFor<unknown, TrackerGetToolOutput>(tools, 'tracker_get');
      await expect(get.execute({ id: 'nope' })).resolves.toEqual({ record: null });
    });

    it('rejects both id and issueNumber given together', async () => {
      const tools = toolsFor(PROJECT_A);
      const get = toolFor<unknown, TrackerGetToolOutput>(tools, 'tracker_get');
      await expect(get.execute({ id: 'x', issueNumber: 1 })).rejects.toThrow(TrackerMcpToolError);
    });

    it('rejects neither id nor issueNumber given', async () => {
      const tools = toolsFor(PROJECT_A);
      const get = toolFor<unknown, TrackerGetToolOutput>(tools, 'tracker_get');
      await expect(get.execute({})).rejects.toThrow(TrackerMcpToolError);
    });
  });

  describe('tracker_update', () => {
    it('patches fields and leaves system untouched', async () => {
      const created = store.create(PROJECT_A, {
        primaryType: 'task',
        fields: { title: 'Old' },
        authorId: 'a',
      });
      const tools = toolsFor(PROJECT_A);
      const update = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_update');
      const { record } = await update.execute({ id: created.id, fields: { title: 'New' } });
      expect(record.fields).toEqual({ title: 'New' });
      expect(record.system).toEqual(created.system);
    });

    it('wraps a nonexistent id as a TrackerMcpToolError naming the tool', async () => {
      const tools = toolsFor(PROJECT_A);
      const update = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_update');
      await expect(update.execute({ id: 'nope', archived: true })).rejects.toMatchObject({
        tool: 'tracker_update',
      });
    });
  });

  describe('tracker_link_session', () => {
    it("links the context's sessionId — the schema has no sessionId field for a caller to set", async () => {
      const created = store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      const tools = toolsFor(PROJECT_A, { sessionId: 'session-abc' });
      const linkSession = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_link_session');
      const { record } = await linkSession.execute({ id: created.id });
      expect(record.system.linkedSessionIds).toEqual(['session-abc']);
    });

    it('rejects a sessionId supplied in input outright (strict schema) rather than silently ignoring the spoof attempt', async () => {
      const created = store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      const tools = toolsFor(PROJECT_A, { sessionId: 'session-abc' });
      const linkSession = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_link_session');
      await expect(linkSession.execute({ id: created.id, sessionId: 'spoofed' })).rejects.toThrow(
        TrackerMcpToolError,
      );
      expect(store.get(PROJECT_A, created.id)?.system.linkedSessionIds).toEqual([]);
    });

    it('wraps a nonexistent id as a TrackerMcpToolError', async () => {
      const tools = toolsFor(PROJECT_A);
      const linkSession = toolFor<unknown, TrackerRecordToolOutput>(tools, 'tracker_link_session');
      await expect(linkSession.execute({ id: 'nope' })).rejects.toThrow(TrackerMcpToolError);
    });
  });

  describe('tracker_list', () => {
    it('lists only this project\u2019s active records by default', async () => {
      store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      const archived = store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      store.update(PROJECT_A, archived.id, { archived: true });
      const tools = toolsFor(PROJECT_A);
      const list = toolFor<unknown, TrackerListToolOutput>(tools, 'tracker_list');
      const { records } = await list.execute({});
      expect(records).toHaveLength(1);
    });

    it('includeArchived: true returns both', async () => {
      store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      const archived = store.create(PROJECT_A, { primaryType: 'task', fields: {}, authorId: 'a' });
      store.update(PROJECT_A, archived.id, { archived: true });
      const tools = toolsFor(PROJECT_A);
      const list = toolFor<unknown, TrackerListToolOutput>(tools, 'tracker_list');
      const { records } = await list.execute({ includeArchived: true });
      expect(records).toHaveLength(2);
    });

    it('rejects an unknown top-level input field (strict schema)', async () => {
      const tools = toolsFor(PROJECT_A);
      const list = toolFor<unknown, TrackerListToolOutput>(tools, 'tracker_list');
      await expect(list.execute({ bogus: true })).rejects.toThrow(TrackerMcpToolError);
    });
  });

  describe('cross-project scoping (issue #211 acceptance: impossible, not just checked)', () => {
    it('tracker_get in project B cannot see a record created in project A', async () => {
      const recordA = store.create(PROJECT_A, {
        primaryType: 'task',
        fields: { title: 'A-only' },
        authorId: 'a',
      });
      const toolsB = toolsFor(PROJECT_B);
      const get = toolFor<unknown, TrackerGetToolOutput>(toolsB, 'tracker_get');
      await expect(get.execute({ id: recordA.id })).resolves.toEqual({ record: null });
      await expect(get.execute({ issueNumber: recordA.issueNumber })).resolves.toEqual({
        record: null,
      });
    });

    it('tracker_list in project B never includes project A\u2019s records', async () => {
      store.create(PROJECT_A, { primaryType: 'task', fields: { title: 'A-only' }, authorId: 'a' });
      const recordB = store.create(PROJECT_B, {
        primaryType: 'task',
        fields: { title: 'B-only' },
        authorId: 'b',
      });
      const toolsB = toolsFor(PROJECT_B);
      const list = toolFor<unknown, TrackerListToolOutput>(toolsB, 'tracker_list');
      const { records } = await list.execute({ includeArchived: true });
      expect(records.map((record) => record.id)).toEqual([recordB.id]);
    });

    it('tracker_update in project B cannot mutate a record that only exists in project A', async () => {
      const recordA = store.create(PROJECT_A, {
        primaryType: 'task',
        fields: { title: 'A-only' },
        authorId: 'a',
      });
      const toolsB = toolsFor(PROJECT_B);
      const update = toolFor<unknown, TrackerRecordToolOutput>(toolsB, 'tracker_update');
      await expect(
        update.execute({ id: recordA.id, fields: { title: 'hijacked' } }),
      ).rejects.toThrow(TrackerMcpToolError);
      // The record in project A is untouched.
      expect(store.get(PROJECT_A, recordA.id)?.fields).toEqual({ title: 'A-only' });
    });

    it('tracker_link_session in project B cannot link a record that only exists in project A', async () => {
      const recordA = store.create(PROJECT_A, {
        primaryType: 'task',
        fields: {},
        authorId: 'a',
      });
      const toolsB = toolsFor(PROJECT_B, { sessionId: 'session-b' });
      const linkSession = toolFor<unknown, TrackerRecordToolOutput>(toolsB, 'tracker_link_session');
      await expect(linkSession.execute({ id: recordA.id })).rejects.toThrow(TrackerMcpToolError);
      expect(store.get(PROJECT_A, recordA.id)?.system.linkedSessionIds).toEqual([]);
    });

    it('tracker_create in project B is invisible to project A\u2019s tracker_list', async () => {
      const toolsA = toolsFor(PROJECT_A);
      const toolsB = toolsFor(PROJECT_B);
      const createB = toolFor<unknown, TrackerRecordToolOutput>(toolsB, 'tracker_create');
      await createB.execute({ primaryType: 'task', fields: { title: 'B-only' } });
      const listA = toolFor<unknown, TrackerListToolOutput>(toolsA, 'tracker_list');
      const { records } = await listA.execute({});
      expect(records).toHaveLength(0);
    });

    it('a projectPath field in tool input is rejected outright — the schemas have no such field to spoof', async () => {
      const tools = toolsFor(PROJECT_A);
      const list = toolFor<unknown, TrackerListToolOutput>(tools, 'tracker_list');
      await expect(list.execute({ projectPath: PROJECT_B })).rejects.toThrow(TrackerMcpToolError);
    });
  });
});
