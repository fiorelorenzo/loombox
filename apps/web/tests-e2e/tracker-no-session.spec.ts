import type { Page } from '@playwright/test';
import { generateAmk } from '@loombox/crypto';
import {
  PROTOCOL_V1,
  type TrackerRecordV1,
  type TrackerSnapshotRequest,
  type TrackerTypeDefinitionV1,
} from '@loombox/protocol';
import { bridgeRelayCors, expect, test } from './fixtures';
import {
  amkToStorageValue,
  deriveNodeProjectKey,
  FakeNode,
  nodeSeal,
  randomBase64,
  signUpTestUser,
  startE2eRelay,
} from './harness/relay-harness';

/**
 * Issue #697: the Tracker page's records used to ride a session-scoped
 * transport (`sessionId` + `targetId`, sealed to a session key), so a
 * project's tracker was unreachable whenever no agent session happened to
 * be running for it. This spec never creates a session at all — no
 * `announceSession` call anywhere, unlike every other tracker spec in this
 * suite (`tracker-setup`/`tracker-board-width`/`tracker-keyboard-move`/
 * `tracker-mobile`, all built on the `loombox` fixture's one pre-announced
 * session) — proving both of #697's acceptance bullets at once: the
 * Tracker page loads records with no session open, and a project that has
 * never had one works too (there is nothing here for it to have ever had).
 *
 * No `loombox` fixture on purpose (it always announces one session): a
 * real relay + a real signed-up account + a real AMK, built the same way
 * the fixture does, minus the session. The `FakeNode` registers itself
 * with the relay via `target_announce` alone — never `session_announce` —
 * the only way a node makes itself routable before any session exists
 * (`packages/relay`'s own `registry.nodeConnectionsByNodeId` is populated
 * by either message; this spec exercises the one that survives with zero
 * sessions). The project itself is seeded straight into the client-side
 * project registry (`loombox:projects`, `projects.ts`'s own storage key) —
 * exactly the shape `AddProjectDialog` would leave behind — since there is
 * no session for `ProjectStore.adoptFromSessions` to register it from
 * instead.
 */

const NODE_ID = 'e2e-no-session-node';
const PROJECT_PATH = '/workspace/no-session-project';

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

/** Seeds the exact `Project` shape `projects.ts`'s own `isProject` validator accepts, straight into `localStorage` — the same registry key (`loombox:projects`) `AddProjectDialog`/`ProjectStore.adoptFromSessions` write to, just written directly since this spec never creates a session for adoption to pick up. Runs before the app's first navigation, mirroring how the `loombox` fixture seeds the auth session/AMK. */
async function seedProject(page: Page): Promise<void> {
  await page.addInitScript(
    (seed) => {
      window.localStorage.setItem(
        'loombox:projects',
        JSON.stringify([
          {
            id: 'proj-no-session',
            name: 'No-session project',
            nodeId: seed.nodeId,
            targetId: 'local',
            path: seed.projectPath,
            createdAt: Date.now(),
          },
        ]),
      );
    },
    { nodeId: NODE_ID, projectPath: PROJECT_PATH },
  );
}

test.describe('Tracker page works with no session at all (issue #697)', () => {
  test('loads real records for a project that has never had a session, with zero sessions in the account throughout', async ({
    page,
  }) => {
    const relay = await startE2eRelay();
    await bridgeRelayCors(page, relay.httpBaseUrl);
    const email = `e2e-no-session-${Date.now()}@example.com`;
    const { token, accountId } = await signUpTestUser(relay.httpBaseUrl, email);
    const amk = generateAmk();

    // Seeded before the app's first navigation, exactly like the `loombox`
    // fixture's own seed — minus any session, which is the whole point.
    await page.addInitScript(
      (seed) => {
        window.localStorage.setItem(
          'loombox:auth-session',
          JSON.stringify({ token: seed.token, accountId: seed.accountId }),
        );
        window.localStorage.setItem(`loombox:amk:${seed.accountId}`, seed.amkBase64);
        window.localStorage.setItem('loombox:relay-url', seed.relayUrl);
      },
      { token, accountId, amkBase64: amkToStorageValue(amk), relayUrl: relay.url },
    );
    await seedProject(page);

    const node = new FakeNode(relay.url, {
      deviceId: 'e2e-no-session-node-device',
      devicePublicKey: randomBase64(),
      authToken: token,
    });
    await node.ready;
    // Registers NODE_ID with the relay via `target_announce` alone — never
    // `session_announce` — the only way a node makes itself reachable
    // before any session exists.
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: NODE_ID,
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    // Issue #672: the Tracker page's empty state doubles as the
    // tracker-mode setup step, so the board needs a saved mode first.
    node.seedTrackerMode(PROJECT_PATH, { kind: 'native' });

    try {
      await page.goto('/');

      // Readiness with no session anywhere: the project tree (built from
      // the registry alone, per `+page.svelte`'s own `projectGroups`
      // derivation) is what this app shows once connected — never the
      // composer, which only renders once a session is selected.
      await expect(page.getByTestId('project-group')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('composer-input')).toHaveCount(0);

      // Reaches Tracker through the project row's own "Open tracker"
      // action (issue #697) — not the top nav's `destination-tracker`
      // shortcut, which only ever reflects a currently selected session
      // and stays hidden here since none exists.
      await page.getByTestId('project-row-more').click();
      await page.getByTestId('project-open-tracker').click();
      await expect(page.getByTestId('tracker-page')).toBeVisible();

      const request = (await node.waitFor(
        (message) => message.type === 'tracker_snapshot_request',
      )) as TrackerSnapshotRequest;
      expect(request.nodeId).toBe(NODE_ID);
      expect(request.projectPath).toBe(PROJECT_PATH);
      // The old shape (`sessionId`/`targetId`) is gone from the wire
      // entirely, not just unused.
      expect(Object.keys(request)).not.toContain('sessionId');
      expect(Object.keys(request)).not.toContain('targetId');

      const records: TrackerRecordV1[] = [
        {
          id: 'rec-1',
          primaryType: 'task',
          typeTags: [],
          issueNumber: 1,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
          fields: { title: 'Ship it', status: 'todo' },
          system: makeSystem(),
        },
      ];
      const key = await deriveNodeProjectKey(amk, accountId, PROJECT_PATH);
      const envelope = await nodeSeal(
        PROJECT_PATH,
        { outcome: 'ok', records, types: [TASK_TYPE] },
        key,
      );
      node.send({
        type: 'tracker_snapshot_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: NODE_ID,
        projectPath: PROJECT_PATH,
        requestId: request.requestId,
        envelope,
      });

      await expect(page.getByTestId('tracker-card-rec-1')).toBeVisible();
      // Still zero sessions, even after a full round trip of real tracker
      // traffic — the records loaded through the project alone.
      await expect(page.getByTestId('composer-input')).toHaveCount(0);
    } finally {
      node.close();
      await relay.close();
    }
  });
});
