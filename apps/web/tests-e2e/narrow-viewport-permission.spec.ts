import type { PermissionResponse } from '@loombox/protocol';
import { expect, sendPermissionRequest, test } from './fixtures';

/**
 * Narrow-viewport permission footer and scrollable option lists (issue
 * #134): `PermissionQueueBar`/`PermissionCard` already collapse to two
 * primary actions plus an overflow control under jsdom's simulated
 * `narrow` prop (`PermissionCard.test.ts`); this is the real-browser,
 * real-viewport-width counterpart that issue's own acceptance line asked
 * for, driving `$lib/viewport.ts`'s actual `matchMedia` query rather than a
 * mocked one.
 */
test.describe('Narrow-viewport permission footer (issue #134)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('collapses to two primary actions plus a scrollable overflow, and resolving from it reaches the node', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await sendPermissionRequest(loombox.node, loombox.session, {
      requestId: 'req-narrow-1',
      toolCall: { kind: 'tool_call', id: 'tc-narrow-1', title: 'Run a risky command' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
      ],
    });

    await expect(page.getByTestId('permission-card')).toBeVisible();

    const optionsRow = page.getByTestId('permission-options');
    const primaryButtons = optionsRow.locator(
      'button:not([data-testid="permission-overflow-toggle"])',
    );
    // Below the breakpoint, only the two primary options render inline —
    // the other two are folded behind the overflow toggle.
    await expect(primaryButtons).toHaveCount(2);
    await expect(primaryButtons.nth(0)).toBeVisible();
    await expect(primaryButtons.nth(1)).toBeVisible();

    const overflowToggle = page.getByTestId('permission-overflow-toggle');
    await expect(overflowToggle).toHaveText('More (2)');
    // Closed by default: the scrollable overflow list isn't even in the DOM yet.
    await expect(page.getByTestId('permission-options-scroll')).toHaveCount(0);

    await overflowToggle.click();
    const overflowList = page.getByTestId('permission-options-scroll');
    await expect(overflowList).toBeVisible();
    await expect(overflowList.locator('button')).toHaveCount(2);
    // The primary buttons stay visible/reachable while the overflow is open.
    await expect(primaryButtons.nth(0)).toBeVisible();

    await overflowList.getByRole('button', { name: /Reject once/ }).click();

    const response = (await loombox.node.waitFor(
      (message) => message.type === 'permission_response' && message.requestId === 'req-narrow-1',
    )) as PermissionResponse;
    expect(response).toMatchObject({
      sessionId: loombox.session.sessionId,
      requestId: 'req-narrow-1',
      decision: 'reject_once',
    });
  });
});
