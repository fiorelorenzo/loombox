import type { Page } from '@playwright/test';
import { PROTOCOL_V1 } from '@loombox/protocol';
import { expect, test } from './fixtures';
import { sendSessionUpdate } from './harness/relay-harness';

/**
 * The load/concurrency-limits UI (SPEC §7.16; issue #255) at the app's
 * mobile floor — the same 390x844 figure `accounts-mobile.spec.ts`/
 * `spend-report-mobile.spec.ts` already measure at. Lives inside Settings
 * > Nodes (`TargetStatusView.svelte`, issue #568's merge), reached the
 * same `tabbar-sessions` -> account menu -> Settings path
 * `accounts-mobile.spec.ts`'s own `openSettingsAccounts` already
 * establishes, just switched to the Nodes tab instead of Accounts.
 */
async function openSettingsNodes(page: Page): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('tabbar-sessions').click();
  await page.getByTestId('account-menu-toggle').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByTestId('tabbar-sessions').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('settings-tab-nodes').click();
  await expect(page.getByTestId('settings-section-nodes')).toBeVisible();
}

test.describe('Load and concurrency-limits UI at 390px (issue #255)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows the seeded target's concurrency cap and its honest source, entirely inside the viewport", async ({
    page,
    loombox,
  }) => {
    loombox.node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'e2e-node-daemon',
      targets: [
        {
          id: 'local',
          kind: 'local',
          label: 'This machine',
          providers: ['claude'],
          maxConcurrentSessions: 3,
          maxConcurrentSessionsSource: 'default',
        },
      ],
    } as never);

    await page.goto('/');
    await openSettingsNodes(page);

    const key = 'e2e-node-daemon:local';
    // No session has a live status yet (`loombox`'s seeded session never
    // pushed one) — 0 running, still shows the real cap and its default
    // (never operator-set) source, honestly.
    await expect(page.getByTestId(`target-concurrency-cap-${key}`)).toHaveText('0/3');
    await expect(page.getByTestId(`target-concurrency-source-${key}`)).toHaveText('default');
    await expect(page.getByTestId(`target-concurrency-queued-${key}`)).toHaveCount(0);

    const row = page.getByTestId(`target-status-row-${key}`);
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });

  test("a queued session renders distinctly from running — its wait is visible on the session row, and the Nodes view's queued badge tracks it live, both inside the viewport", async ({
    page,
    loombox,
  }) => {
    loombox.node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'e2e-node-daemon',
      targets: [
        {
          id: 'local',
          kind: 'local',
          label: 'This machine',
          providers: ['claude'],
          maxConcurrentSessions: 1,
          maxConcurrentSessionsSource: 'configured',
        },
      ],
    } as never);

    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'queued',
      updatedAt: new Date().toISOString(),
    });

    // The wait reads in the sidebar row's own title — not the bare
    // "Queued" a slow-but-actually-running session could equally show
    // (issue #255's whole point: today a user starting a queued session
    // cannot tell it apart from slow).
    await page.getByTestId('tabbar-sessions').click();
    const row = page.getByTestId('session-row-item').first();
    await expect(row).toBeVisible();
    await expect(row.locator('button.session')).toHaveAttribute(
      'title',
      /Queued: waiting for a slot/,
    );
    await page.getByTestId('tabbar-sessions').click();

    // The SAME wait, made explicable next to the limit that caused it
    // (Settings > Nodes), still inside the viewport.
    await openSettingsNodes(page);
    const key = 'e2e-node-daemon:local';
    const queuedBadge = page.getByTestId(`target-concurrency-queued-${key}`);
    await expect(queuedBadge).toBeVisible();
    await expect(queuedBadge).toContainText('1 queued');
    await expect(page.getByTestId(`target-concurrency-cap-${key}`)).toHaveText('0/1');
    await expect(page.getByTestId(`target-concurrency-source-${key}`)).toHaveText('configured');

    const badgeBox = await queuedBadge.boundingBox();
    expect(badgeBox).not.toBeNull();
    expect(badgeBox!.x).toBeGreaterThanOrEqual(0);
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(390);
  });
});
