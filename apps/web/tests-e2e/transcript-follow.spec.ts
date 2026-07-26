import type { Page } from '@playwright/test';
import { expect, sendSessionUpdate, test } from './fixtures';

/**
 * The transcript follows the agent's newest output (issue #508).
 *
 * It never did: `.items` scrolled, but nothing ever set `scrollTop`, so a
 * live session streamed tool calls and messages in below the fold and left
 * the list pinned at the first frame. What you saw at the boundary was a diff
 * sliced through the middle of its glyphs with no bottom border and no
 * scrollbar, which is why the bug was filed as a rendering fault.
 *
 * Browser-driven on purpose: the defect is a scroll position, and jsdom has
 * no layout, so a component test here would pass against the broken build.
 */

/** Enough tool calls to overflow the transcript viewport at 900px tall. */
async function seedOverflowingTranscript(
  node: Parameters<typeof sendSessionUpdate>[0],
  session: Parameters<typeof sendSessionUpdate>[1],
): Promise<void> {
  await sendSessionUpdate(node, session, { kind: 'turn_started', turnId: 'turn-1' });
  for (let i = 0; i < 30; i += 1) {
    await sendSessionUpdate(node, session, {
      kind: 'tool_call',
      id: `tool-${i}`,
      turnId: 'turn-1',
      title: `Read packages/relay/src/file-${i}.ts`,
      toolKind: 'read',
      status: 'completed',
    });
  }
}

function distanceFromBottom(page: Page): Promise<number> {
  return page
    .getByTestId('transcript-items')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test.describe('transcript follow', () => {
  test('scrolls to the newest output as it arrives', async ({ page, loombox }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    await seedOverflowingTranscript(loombox.node, loombox.session);
    const items = page.getByTestId('transcript-items');
    await expect(items.getByText('file-29.ts')).toBeVisible();

    // The list must actually overflow, or this asserts nothing.
    expect(await items.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);

    // A later chunk keeps following rather than landing below the fold.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-last',
      text: 'Done. The dedupe key is now per session.',
    });
    await expect(items.getByText('Done. The dedupe key is now per session.')).toBeVisible();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
  });

  test('stops following once you scroll up, and offers a way back', async ({ page, loombox }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    await seedOverflowingTranscript(loombox.node, loombox.session);
    const items = page.getByTestId('transcript-items');
    await expect(items.getByText('file-29.ts')).toBeVisible();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);

    const jump = page.getByTestId('transcript-jump-latest');
    await expect(jump).toHaveCount(0);

    await items.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(jump).toBeVisible();

    // Reading earlier output is not interrupted by the agent still working.
    const before = await items.evaluate((el) => el.scrollTop);
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-while-detached',
      text: 'Still working on it.',
    });
    await expect(items.getByText('Still working on it.')).toBeAttached();
    expect(await items.evaluate((el) => el.scrollTop)).toBe(before);

    await jump.click();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
    await expect(jump).toHaveCount(0);
  });
});
