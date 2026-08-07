import { expect, sendSessionUpdate, test } from './fixtures';

/**
 * The persistent per-session plan sidebar (SPEC.md §7.24 "Plans, rendered
 * twice from one truth" — sidebar portion, v2; issue #201). Playwright
 * rather than jsdom for the width claim specifically — `PlanSidebar.test.ts`
 * already proves the grouping/completion-bar/no-flicker/no-empty-scaffold
 * behavior against a real render, but none of that is a LAYOUT fact, and
 * jsdom has no layout at all — "does the sidebar's own border box stay
 * inside a 390px viewport" can only be answered by measuring a real one,
 * the same discipline `composer-strip.spec.ts`/`inbox-mobile.spec.ts`
 * already follow at this exact width (an iPhone 12/13/14's logical width,
 * the app's narrowest shipped target).
 */

test.describe('Plan sidebar (issue #201)', () => {
  test('is entirely absent for a session whose agent never emits a plan — no empty scaffold', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 });

    // Some ordinary transcript activity, deliberately with no plan_update
    // anywhere in it — the "never emits a plan" case, not "hasn't yet".
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-1',
      text: 'Working on it, no plan needed for this one.',
    });
    await expect(page.getByText('Working on it, no plan needed for this one.')).toBeVisible();

    await expect(page.getByTestId('plan-sidebar')).toHaveCount(0);
  });

  test('renders the plan grouped by status with a completion bar, and updates in place as a plan_update lands mid-turn', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 });

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'plan_update',
      entries: [
        { content: 'Read the codebase', status: 'completed' },
        { content: 'Write the sidebar', status: 'in_progress' },
        { content: 'Write the tests', status: 'pending' },
        { content: 'Open the PR', status: 'pending' },
      ],
    });

    const sidebar = page.getByTestId('plan-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId('plan-sidebar-progress')).toHaveText('1/4');
    await expect(page.getByTestId('plan-sidebar-meter')).toHaveAttribute('aria-valuenow', '25');
    await expect(page.getByTestId('plan-sidebar-group-pending')).toContainText('Pending · 2');
    await expect(page.getByTestId('plan-sidebar-group-in_progress')).toContainText(
      'In progress · 1',
    );
    await expect(page.getByTestId('plan-sidebar-group-completed')).toContainText('Completed · 1');

    // ACP replaces the whole plan wholesale on every plan_update — never
    // diffed client-side — so this is a full new entries array, same as a
    // real agent's own mid-turn plan report.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'plan_update',
      entries: [
        { content: 'Read the codebase', status: 'completed' },
        { content: 'Write the sidebar', status: 'completed' },
        { content: 'Write the tests', status: 'in_progress' },
        { content: 'Open the PR', status: 'pending' },
      ],
    });

    await expect(page.getByTestId('plan-sidebar-progress')).toHaveText('2/4');
    await expect(page.getByTestId('plan-sidebar-meter')).toHaveAttribute('aria-valuenow', '50');
    await expect(page.getByTestId('plan-sidebar-group-pending')).toContainText('Pending · 1');
    await expect(page.getByTestId('plan-sidebar-group-completed')).toContainText('Completed · 2');
    // Still one persistent surface, not a second one stacked below a first
    // that never went away.
    await expect(page.getByTestId('plan-sidebar')).toHaveCount(1);

    // The update did not steal focus from the composer.
    await page.getByTestId('composer-input').focus();
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'plan_update',
      entries: [
        { content: 'Read the codebase', status: 'completed' },
        { content: 'Write the sidebar', status: 'completed' },
        { content: 'Write the tests', status: 'completed' },
        { content: 'Open the PR', status: 'in_progress' },
      ],
    });
    await expect(page.getByTestId('plan-sidebar-progress')).toHaveText('3/4');
    await expect(page.getByTestId('composer-input')).toBeFocused();
  });

  test('at 390px the sidebar renders inside the viewport with no horizontal overflow, and stays usable collapsed', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 });

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'plan_update',
      entries: [
        { content: 'Read the codebase', status: 'completed' },
        {
          content: 'Write a sidebar that groups pending, in-progress and completed work',
          status: 'in_progress',
        },
        { content: 'Write the tests', status: 'pending' },
      ],
    });
    await expect(page.getByTestId('plan-sidebar')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });

    // Measured, not guessed (the same discipline composer-strip.spec.ts and
    // MessageItem.svelte's own 390px doc comment follow): the sidebar's own
    // border box must not exceed the viewport it renders in.
    const box = await page.getByTestId('plan-sidebar').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    const meterBox = await page.getByTestId('plan-sidebar-meter').boundingBox();
    expect(meterBox).not.toBeNull();
    expect(meterBox!.x).toBeGreaterThanOrEqual(0);
    expect(meterBox!.x + meterBox!.width).toBeLessThanOrEqual(390);

    // A long entry wraps rather than pushing the row wider than the viewport.
    const groupBox = await page.getByTestId('plan-sidebar-group-in_progress').boundingBox();
    expect(groupBox).not.toBeNull();
    expect(groupBox!.x + groupBox!.width).toBeLessThanOrEqual(390);

    // Collapsing still works at this width, and the header (progress figure)
    // stays visible and inside the viewport while collapsed.
    await page.getByTestId('plan-sidebar').getByRole('button', { name: 'Collapse plan' }).click();
    await expect(page.getByTestId('plan-sidebar-group-pending')).toHaveCount(0);
    const collapsedBox = await page.getByTestId('plan-sidebar').boundingBox();
    expect(collapsedBox).not.toBeNull();
    expect(collapsedBox!.x + collapsedBox!.width).toBeLessThanOrEqual(390);
    await expect(page.getByTestId('plan-sidebar-progress')).toBeVisible();
  });
});
