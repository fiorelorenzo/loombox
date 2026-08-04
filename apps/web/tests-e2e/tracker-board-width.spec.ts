import {
  PROTOCOL_V1,
  type TrackerRecordV1,
  type TrackerSnapshotRequest,
  type TrackerTypeDefinitionV1,
} from '@loombox/protocol';
import { expect, test } from './fixtures';
import { nodeSeal } from './harness/relay-harness';

/**
 * The kanban board at a real laptop width (issue #651, v7 decision F4-2's
 * "no horizontal scroller" acceptance). Before this change, one column
 * per raw status meant a project with a six-status workflow rendered six
 * columns — the review that opened this issue measured that shape
 * overflowing 1778px of content in a 1080px container. Fixing the column
 * count at three, in workflow order, makes the overflow structurally
 * impossible rather than tuned away: this spec seeds records across all
 * three categories (so every column actually renders cards, not just an
 * empty shell) at 1280x800 — a common 13" laptop resolution, the same
 * class of viewport `AGENTS.md`'s own Mac-debug notes reference — and
 * measures the real rendered width, never a static mockup.
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

function record(id: string, issueNumber: number, status: string, title: string): TrackerRecordV1 {
  return {
    id,
    primaryType: 'task',
    typeTags: [],
    issueNumber,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    fields: { title, status },
    system: makeSystem(),
  };
}

test.describe('Tracker kanban board fits a laptop width, no horizontal scroller (issue #651)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('three populated category columns render with zero horizontal overflow at 1280px', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('destination-tracker').click();
    await expect(page.getByTestId('tracker-page')).toBeVisible();

    const request = (await loombox.node.waitFor(
      (message) => message.type === 'tracker_snapshot_request',
    )) as TrackerSnapshotRequest;

    // Six raw statuses (the exact shape the old alphabetical board turned
    // into six columns for) collapse into the three fixed categories, all
    // populated, so this measures the FULL three-column board, not an
    // empty shell.
    const records: TrackerRecordV1[] = [
      record('rec-1', 1, 'backlog', 'Backlog item'),
      record('rec-2', 2, 'todo', 'Todo item'),
      record('rec-3', 3, 'in-progress', 'In progress item'),
      record('rec-4', 4, 'review', 'In review item'),
      record('rec-5', 5, 'done', 'Done item'),
      record('rec-6', 6, 'closed', 'Closed item'),
    ];
    const envelope = await nodeSeal(
      loombox.session.sessionId,
      { outcome: 'ok', records, types: [TASK_TYPE] },
      loombox.session.key,
    );
    loombox.node.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: loombox.session.sessionId,
      requestId: request.requestId,
      envelope,
    });

    // All three columns present, each carrying real cards (not empty).
    await expect(page.getByTestId('tracker-board-column-new')).toBeVisible();
    await expect(page.getByTestId('tracker-board-column-indeterminate')).toBeVisible();
    await expect(page.getByTestId('tracker-board-column-done')).toBeVisible();
    await expect(page.getByTestId('tracker-card-rec-1')).toBeVisible();
    await expect(page.getByTestId('tracker-card-rec-3')).toBeVisible();
    await expect(page.getByTestId('tracker-card-rec-5')).toBeVisible();

    // The real measurement: does the columns row's own content exceed
    // its container, i.e. does a horizontal scrollbar exist. Reported as
    // real numbers (not just a pass/fail) so a reviewer can see the
    // actual margin, the same way the original finding reported its own
    // 1778px-in-1080px overflow.
    const measurement = await page.getByTestId('tracker-board-columns').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    console.log(
      `tracker-board-columns at 1280px: scrollWidth=${measurement.scrollWidth}px, ` +
        `clientWidth=${measurement.clientWidth}px, ` +
        `overflow=${measurement.scrollWidth - measurement.clientWidth}px`,
    );
    expect(measurement.scrollWidth).toBeLessThanOrEqual(measurement.clientWidth);

    const columnsBox = await page.getByTestId('tracker-board-columns').boundingBox();
    expect(columnsBox).not.toBeNull();
    expect(columnsBox!.x + columnsBox!.width).toBeLessThanOrEqual(1280);
  });
});
