import type { PermissionResponse } from '@loombox/protocol';
import { expect, sendPermissionRequest, sendSessionUpdate, test } from './fixtures';

/**
 * The cross-project attention inbox (issue #167) at the narrow width it is
 * actually promised to work at: SPEC §7.13/design spec v4 §3.5 put Inbox on
 * the mobile bottom tabbar below `--bp-desktop` (1024px), not only in the
 * desktop sidebar `inbox-reply.spec.ts` already drives. That spec already
 * covers the inline-reply path end to end at the suite's default (desktop)
 * viewport; this one is the real-browser, real-viewport-width counterpart
 * for the other two acceptance bullets that only bite at phone width: an
 * approval resolved inline, and a finished session's Open action
 * navigating away from the Inbox tab, both at 390px (an iPhone 12/13/14's
 * logical width, the narrowest shipped target and the same figure
 * `narrow-viewport-permission.spec.ts`/`composer-strip.spec.ts` already
 * measure at).
 */
test.describe('Attention inbox at 390px (issue #167)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the tabbar badge tracks a pending approval, resolving it inline reaches the node, and the badge clears with it', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    // The tabbar is the reachable Inbox affordance at this width (design
    // spec v4 §3.5); the sidebar's own `destination-inbox` sits inside the
    // off-canvas sessions sheet here, not this spec's concern.
    await sendPermissionRequest(loombox.node, loombox.session, {
      requestId: 'req-mobile-1',
      toolCall: { kind: 'tool_call', id: 'tc-mobile-1', title: 'Run the migration' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
      ],
    });

    const tabbarInbox = page.getByTestId('tabbar-inbox');
    await expect(tabbarInbox.getByTestId('tabbar-inbox-count')).toHaveText('1');

    await tabbarInbox.click();
    await expect(page.getByTestId('inbox-page')).toBeVisible();

    const row = page.getByTestId('attention-inbox-item');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('permission-card')).toBeVisible();

    // Measured, not guessed (the same discipline `composer-strip.spec.ts`
    // and `MessageItem.svelte`'s own 390px doc comment follow): the row's
    // own border box must not exceed the viewport it renders in, rather
    // than assuming `min-width: 0` down the flex chain actually holds.
    const rowBox = await row.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.x).toBeGreaterThanOrEqual(0);
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(390);

    await row.getByRole('button', { name: /Allow/ }).click();

    const response = (await loombox.node.waitFor(
      (message) => message.type === 'permission_response' && message.requestId === 'req-mobile-1',
    )) as PermissionResponse;
    expect(response).toMatchObject({
      sessionId: loombox.session.sessionId,
      requestId: 'req-mobile-1',
      decision: 'allow_once',
    });

    // The FIFO queue is now empty and nothing else is waiting: the badge
    // is gone entirely, not stuck at a stale count.
    await expect(tabbarInbox.getByTestId('tabbar-inbox-count')).toHaveCount(0);
  });

  test("opening a finished session's item navigates to it and leaves the Inbox tab", async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'exited',
      updatedAt: new Date().toISOString(),
    });

    const tabbarInbox = page.getByTestId('tabbar-inbox');
    await expect(tabbarInbox.getByTestId('tabbar-inbox-count')).toHaveText('1');
    await tabbarInbox.click();

    const row = page.getByTestId('attention-inbox-item');
    await expect(row).toHaveCount(1);
    await expect(row.getByText('E2E session')).toBeVisible();
    // A session outcome has no inline action (SPEC §7.13: it is read by
    // opening the session, not resolved in place like an approval) — Open
    // is the only control this row offers.
    await expect(row.getByTestId('permission-card')).toHaveCount(0);
    await expect(row.getByTestId('attention-inbox-reply')).toHaveCount(0);

    await row.getByTestId('attention-inbox-open').click();

    // Navigated: the Inbox page is gone, the tabbar's own Inbox tab is no
    // longer the active one, and the session's transcript/composer is what
    // the tab strip now sits below.
    await expect(page.getByTestId('inbox-page')).toHaveCount(0);
    await expect(tabbarInbox).not.toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });
});
