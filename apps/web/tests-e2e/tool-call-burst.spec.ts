import type { Page } from '@playwright/test';
import { expect, sendSessionUpdate, test, type LoomboxFixture } from './fixtures';

/**
 * The tier-3 tool-call burst/group summary card (issue #202; SPEC.md
 * §7.24's own tier-3 bullet). `TranscriptTimeline.test.ts`/
 * `ToolCallBurstGroup.test.ts` already prove the grouping rule, streaming
 * stability, expand-reveals-real-calls, and window-boundary behavior
 * against jsdom; this is the real-browser, real-layout counterpart for the
 * one thing jsdom cannot answer — "does the card's own border box, and its
 * expanded detail, stay inside a 390px viewport" — the same discipline
 * `plan-sidebar.spec.ts`/`composer-strip.spec.ts` already follow at this
 * exact width (an iPhone 12/13/14's logical width, the app's narrowest
 * shipped target).
 */

async function gotoSession(page: Page, loombox: LoomboxFixture): Promise<void> {
  expect(loombox.session.sessionId).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 });
}

/** Six ordinary, real-shaped tool calls — one MORE than `TOOL_CALL_BURST_THRESHOLD` (5), so the whole run collapses into one card. Two kinds/statuses mixed in (one `search`, one `failed`) so the summary line's succeeded/failed breakdown has something real to say. */
async function sendBurst(loombox: LoomboxFixture): Promise<void> {
  const calls: Array<{ id: string; title: string; toolKind: string; status: string }> = [
    { id: 'tc-pwd', title: 'pwd', toolKind: 'execute', status: 'completed' },
    { id: 'tc-status', title: 'git status --porcelain', toolKind: 'execute', status: 'completed' },
    { id: 'tc-read', title: 'Read src/app.ts', toolKind: 'read', status: 'completed' },
    { id: 'tc-grep', title: 'grep -n TODO src/app.ts', toolKind: 'search', status: 'completed' },
    { id: 'tc-typecheck', title: 'pnpm typecheck', toolKind: 'execute', status: 'failed' },
    { id: 'tc-commit', title: 'git commit -m done', toolKind: 'execute', status: 'completed' },
  ];
  for (const call of calls) {
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'tool_call',
      id: call.id,
      turnId: 'turn-1',
      title: call.title,
      toolKind: call.toolKind,
      status: call.status,
    });
  }
}

test.describe('Tool-call burst/group summary card (issue #202)', () => {
  test('a run above the threshold renders one card, not one row per call, and expanding reveals every real call', async ({
    page,
    loombox,
  }) => {
    await gotoSession(page, loombox);
    await sendBurst(loombox);

    const card = page.getByTestId('tool-call-burst-group');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('tool-call-row')).toHaveCount(0);
    await expect(card).toContainText('6 tool calls');
    await expect(card).toContainText('5 succeeded');
    await expect(card).toContainText('1 failed');

    await page.getByTestId('tool-call-burst-summary').click();
    const detail = page.getByTestId('tool-call-burst-detail');
    await expect(detail).toBeVisible();
    // Every real call, through its normal tier-1/2 renderer — the exact
    // same row shape (and the same `pnpm typecheck` failure text) an
    // ungrouped call would render.
    await expect(detail.getByTestId('tool-call-row')).toHaveCount(6);
    await expect(detail).toContainText('pwd');
    await expect(detail).toContainText('pnpm typecheck');
  });

  test('at 390px the collapsed card and its expanded detail stay inside the viewport, no horizontal overflow', async ({
    page,
    loombox,
  }) => {
    await gotoSession(page, loombox);
    await sendBurst(loombox);

    await page.setViewportSize({ width: 390, height: 844 });

    const card = page.getByTestId('tool-call-burst-group');
    await expect(card).toBeVisible();

    // Measured, not guessed (the same discipline `plan-sidebar.spec.ts`'s
    // own 390px test and `MessageItem.svelte`'s own doc comment follow):
    // the card's own border box must not exceed the viewport it renders in.
    const collapsedBox = await card.boundingBox();
    expect(collapsedBox).not.toBeNull();
    expect(collapsedBox!.x).toBeGreaterThanOrEqual(0);
    expect(collapsedBox!.x + collapsedBox!.width).toBeLessThanOrEqual(390);

    await page.getByTestId('tool-call-burst-summary').click();
    const detail = page.getByTestId('tool-call-burst-detail');
    await expect(detail).toBeVisible();
    const detailBox = await detail.boundingBox();
    expect(detailBox).not.toBeNull();
    expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(390);

    // The failed call's own row — the one most likely to carry a long
    // command/error line — also stays inside the viewport once expanded.
    const failedRow = detail.getByTestId('tool-call-row').filter({ hasText: 'pnpm typecheck' });
    await expect(failedRow).toBeVisible();
    const failedBox = await failedRow.boundingBox();
    expect(failedBox).not.toBeNull();
    expect(failedBox!.x + failedBox!.width).toBeLessThanOrEqual(390);
  });
});
