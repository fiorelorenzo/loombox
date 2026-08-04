import {
  PROTOCOL_V1,
  type TrackerRecordV1,
  type TrackerSnapshotRequest,
  type TrackerTypeDefinitionV1,
  type TrackerWriteRequest,
} from '@loombox/protocol';
import { expect, test } from './fixtures';
import { nodeOpen, nodeSeal } from './harness/relay-harness';

/**
 * The kanban board's keyboard/menu path (issue #212's explicit acceptance:
 * "drag-and-drop, if you build it, needs a keyboard path"). Every
 * `TrackerCard` carries a "Move to" `Select` alongside the HTML5
 * drag-and-drop `TrackerBoard.svelte` wires for a desktop mouse — this
 * spec drives ONLY that select, by focus and keyboard events, never a
 * click or a drag, and proves the change reaches the real store (a real
 * `tracker_write_request` observed on the wire, not just a DOM mutation)
 * rather than local component state. Since issue #651 (v7 decision
 * F4-2) the board's columns are the three fixed workflow categories, not
 * raw statuses, so this drives rec-1 across a category boundary
 * ('todo' -> category 'new') into 'done', proving the write patches the
 * literal category id back onto the record's status field.
 */

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

const TASK_TYPE: TrackerTypeDefinitionV1 = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

test.describe('Native tracker kanban board — keyboard-operable "Move to" (issue #212)', () => {
  test('focus (not a click) reaches the Move-to control; Enter/ArrowDown/Enter sends a real tracker_write_request that patches the record\u2019s workflowStatus field, and the card visibly moves columns', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('destination-tracker').click();
    await expect(page.getByTestId('tracker-page')).toBeVisible();

    const snapshotRequest = (await loombox.node.waitFor(
      (message) => message.type === 'tracker_snapshot_request',
    )) as TrackerSnapshotRequest;

    const records: TrackerRecordV1[] = [
      {
        id: 'rec-1',
        primaryType: 'task',
        typeTags: [],
        issueNumber: 1,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        fields: { title: 'Ship dark mode', status: 'todo' },
        system: makeSystem(),
      },
      {
        id: 'rec-2',
        primaryType: 'task',
        typeTags: [],
        issueNumber: 2,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        fields: { title: 'Already shipped', status: 'done' },
        system: makeSystem(),
      },
    ];
    const snapshotEnvelope = await nodeSeal(
      loombox.session.sessionId,
      { outcome: 'ok', records, types: [TASK_TYPE] },
      loombox.session.key,
    );
    loombox.node.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: loombox.session.sessionId,
      requestId: snapshotRequest.requestId,
      envelope: snapshotEnvelope,
    });

    // Three fixed columns always exist, in workflow order — the record's
    // raw 'todo' status resolves to the 'new' category.
    await expect(page.getByTestId('tracker-board-column-new')).toBeVisible();
    const card = page.getByTestId('tracker-card-rec-1');
    await expect(card).toBeVisible();

    const moveTrigger = page.getByTestId('tracker-card-move-rec-1-trigger');
    await moveTrigger.focus();
    await expect(moveTrigger).toBeFocused();

    await page.keyboard.press('Enter'); // opens the listbox, active on the CURRENT category ('new')
    await expect(page.getByTestId('tracker-card-move-rec-1-listbox')).toBeVisible();
    // Columns are fixed workflow order (['new', 'indeterminate', 'done']),
    // never alphabetical — two ArrowDown presses from 'new' always lands
    // on 'done', regardless of a project's own status vocabulary.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter'); // commits

    const writeRequest = (await loombox.node.waitFor(
      (message) => message.type === 'tracker_write_request',
    )) as TrackerWriteRequest;
    const payload = await nodeOpen<{ op: string; id: string; fields: Record<string, unknown> }>(
      loombox.session.sessionId,
      writeRequest.envelope,
      loombox.session.key,
    );
    // The fake node never told the browser anything but the two records
    // seeded above — this request is the ONLY way the app could have
    // learned a new status, proving the keyboard path goes through
    // `RelayClient.updateTrackerRecord` (a real wire write against
    // `NativeTrackerStore`), never a locally-mutated Svelte variable. The
    // literal category id ('done'), not a synonym, is what gets written.
    expect(payload.op).toBe('update');
    expect(payload.id).toBe('rec-1');
    expect(payload.fields.status).toBe('done');

    // Reflect the write back exactly as the real node would, and confirm
    // the card actually moved columns in the DOM.
    const updatedRecord: TrackerRecordV1 = {
      ...records[0]!,
      fields: { ...records[0]!.fields, status: 'done' },
      updatedAt: 2,
    };
    const writeEnvelope = await nodeSeal(
      loombox.session.sessionId,
      { outcome: 'ok', record: updatedRecord },
      loombox.session.key,
    );
    loombox.node.send({
      type: 'tracker_write_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: loombox.session.sessionId,
      requestId: writeRequest.requestId,
      envelope: writeEnvelope,
    });

    await expect(
      page.getByTestId('tracker-board-column-done').getByTestId('tracker-card-rec-1'),
    ).toBeVisible();
  });
});
