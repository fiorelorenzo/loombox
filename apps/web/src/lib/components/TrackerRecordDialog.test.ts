// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackerRecordV1, TrackerTypeDefinitionV1 } from '@loombox/protocol';
import TrackerRecordDialog, { type TrackerRecordClient } from './TrackerRecordDialog.svelte';

afterEach(() => cleanup());

/**
 * Custom types are the distinguishing feature of issue #212 — this suite
 * proves the create/edit form is genuinely role-driven from the UI side,
 * not just at the wire/protocol layer (`tracker-records.test.ts` already
 * covers the pure helpers): a type mapping only SOME of the four roles
 * renders only those fields, and switching Type re-renders the form from
 * the newly selected type's own `roles`, never a `primaryType`-keyed
 * branch anywhere in this component.
 */

const TASK_TYPE: TrackerTypeDefinitionV1 = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

/** A project-defined custom type that maps only two of the four roles — every role points at a deliberately different `fields` key than `TASK_TYPE`, so a passing assertion can't be an accident of reused key names. */
const CUSTOM_PARTIAL_TYPE: TrackerTypeDefinitionV1 = {
  id: 'feature-request',
  label: 'Feature Request',
  builtin: false,
  roles: { title: 'summary', workflowStatus: 'stage' },
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

function fakeClient(overrides: Partial<TrackerRecordClient> = {}): TrackerRecordClient {
  return {
    createTrackerRecord: vi.fn(async (input) => ({
      id: 'created-1',
      primaryType: input.primaryType,
      typeTags: input.typeTags ?? [],
      issueNumber: 1,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      fields: input.fields,
      system: makeSystem(),
    })),
    updateTrackerRecord: vi.fn(async (id, patch) => ({
      id,
      primaryType: 'task',
      typeTags: [],
      issueNumber: 1,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      fields: patch.fields ?? {},
      system: makeSystem(),
    })),
    ...overrides,
  };
}

describe('TrackerRecordDialog (SPEC §7.10; issue #212) — role-driven create/edit form', () => {
  it('renders only the fields the initially-selected type maps, in create mode', () => {
    render(TrackerRecordDialog, {
      props: {
        open: true,
        client: fakeClient(),
        types: [TASK_TYPE],
        record: undefined,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      },
    });
    expect(screen.getByTestId('tracker-record-title')).toBeTruthy();
    expect(screen.getByTestId('tracker-record-workflowStatus')).toBeTruthy();
    expect(screen.getByTestId('tracker-record-priority')).toBeTruthy();
    expect(screen.getByTestId('tracker-record-assignee')).toBeTruthy();
  });

  it('a custom type mapping only title/workflowStatus renders ONLY those two fields — no priority/assignee field, and no code branch on primaryType', () => {
    render(TrackerRecordDialog, {
      props: {
        open: true,
        client: fakeClient(),
        types: [CUSTOM_PARTIAL_TYPE],
        record: undefined,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      },
    });
    expect(screen.getByTestId('tracker-record-title')).toBeTruthy();
    expect(screen.getByTestId('tracker-record-workflowStatus')).toBeTruthy();
    expect(screen.queryByTestId('tracker-record-priority')).toBeNull();
    expect(screen.queryByTestId('tracker-record-assignee')).toBeNull();
  });

  it('switching the Type field from a built-in to a custom type re-renders which fields show, purely by looking up the new type\u2019s own roles', async () => {
    render(TrackerRecordDialog, {
      props: {
        open: true,
        client: fakeClient(),
        types: [TASK_TYPE, CUSTOM_PARTIAL_TYPE],
        record: undefined,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      },
    });
    // Starts on the first type (Task): all four fields present.
    expect(screen.getByTestId('tracker-record-priority')).toBeTruthy();
    expect(screen.getByTestId('tracker-record-assignee')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('tracker-record-type-trigger'));
    await fireEvent.click(screen.getByTestId('tracker-record-type-option-feature-request'));

    expect(screen.getByTestId('tracker-record-title')).toBeTruthy();
    expect(screen.getByTestId('tracker-record-workflowStatus')).toBeTruthy();
    expect(screen.queryByTestId('tracker-record-priority')).toBeNull();
    expect(screen.queryByTestId('tracker-record-assignee')).toBeNull();
  });

  it('submitting a create for a custom type builds `fields` from that type\u2019s own role->field-key mapping and calls client.createTrackerRecord, never local-only state', async () => {
    const client = fakeClient();
    render(TrackerRecordDialog, {
      props: {
        open: true,
        client,
        types: [CUSTOM_PARTIAL_TYPE],
        record: undefined,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      },
    });

    await fireEvent.input(screen.getByTestId('tracker-record-title'), {
      target: { value: 'Ship dark mode' },
    });
    await fireEvent.input(screen.getByTestId('tracker-record-workflowStatus'), {
      target: { value: 'in-review' },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(client.createTrackerRecord).toHaveBeenCalledWith({
      primaryType: 'feature-request',
      fields: { summary: 'Ship dark mode', stage: 'in-review' },
    });
  });

  it('edit mode pre-fills each visible field from the record\u2019s own fields, resolved through its type\u2019s roles', () => {
    const record: TrackerRecordV1 = {
      id: 'rec-1',
      primaryType: 'feature-request',
      typeTags: [],
      issueNumber: 7,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      fields: { summary: 'Dark mode', stage: 'todo' },
      system: makeSystem(),
    };
    render(TrackerRecordDialog, {
      props: {
        open: true,
        client: fakeClient(),
        types: [CUSTOM_PARTIAL_TYPE],
        record,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      },
    });
    expect((screen.getByTestId('tracker-record-title') as HTMLInputElement).value).toBe(
      'Dark mode',
    );
    expect((screen.getByTestId('tracker-record-workflowStatus') as HTMLInputElement).value).toBe(
      'todo',
    );
  });

  it('submitting an edit patches through client.updateTrackerRecord with the edited fields merged onto the record\u2019s existing ones', async () => {
    const client = fakeClient();
    const record: TrackerRecordV1 = {
      id: 'rec-1',
      primaryType: 'feature-request',
      typeTags: [],
      issueNumber: 7,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      fields: { summary: 'Dark mode', stage: 'todo', extra: 'kept' },
      system: makeSystem(),
    };
    render(TrackerRecordDialog, {
      props: {
        open: true,
        client,
        types: [CUSTOM_PARTIAL_TYPE],
        record,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      },
    });

    await fireEvent.input(screen.getByTestId('tracker-record-workflowStatus'), {
      target: { value: 'done' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(client.updateTrackerRecord).toHaveBeenCalledWith('rec-1', {
      fields: { summary: 'Dark mode', stage: 'done', extra: 'kept' },
    });
  });
});
