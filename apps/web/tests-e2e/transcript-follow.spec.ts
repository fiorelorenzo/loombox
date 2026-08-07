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
 *
 * Issue #755 (real transcript windowing) reused this exact mechanism —
 * `TranscriptTimeline.svelte`'s pin effect still reads the browser's own
 * `scrollHeight`, just re-run on a measured-height change too, not only a
 * new `items` reference — and its pixel-level anchor math has its own
 * dedicated jsdom test (`TranscriptTimeline.test.ts`, stubbed geometry).
 * What changed here: the second test below no longer waits for the newest
 * item to be *attached* while scrolled away — under windowing that item is
 * legitimately unmounted (a hidden tail spacer stands in for it) rather
 * than a bug, so the synchronization gate is the windowed spacer's own
 * `scrollHeight` growth instead.
 */

/** Enough tool calls to overflow the transcript viewport at 900px tall. Chunked into `TOOL_CALL_BURST_THRESHOLD`-sized runs separated by a one-line message: an unbroken 30-call run would collapse into ONE tier-3 burst card (issue #202), starting collapsed by default — exactly what this fixture must NOT do, since the tests below assert individual tool-call titles (`file-29.ts`) render directly, not behind a click. */
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
    if (i % 5 === 4) {
      await sendSessionUpdate(node, session, {
        kind: 'agent_message_chunk',
        turnId: 'turn-1',
        messageId: `msg-batch-${i}`,
        text: 'Continuing.',
      });
    }
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
    const heightBeforeUpdate = await items.evaluate((el) => el.scrollHeight);
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-while-detached',
      text: 'Still working on it.',
    });
    // The newest item is legitimately NOT attached here (issue #755): it's
    // scrolled well out of the rendered window, standing in behind a
    // spacer. `scrollHeight` still grows to account for it (the spacer is
    // sized from the windowing engine's own total, not just the mounted
    // rows), so waiting for that growth off the pre-update baseline is the
    // windowing-safe version of "the update actually reached the client"
    // this gate needs before the `scrollTop` comparison below means
    // anything.
    await expect
      .poll(() => items.evaluate((el) => el.scrollHeight))
      .toBeGreaterThan(heightBeforeUpdate);
    expect(await items.evaluate((el) => el.scrollTop)).toBe(before);

    await jump.click();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
    await expect(jump).toHaveCount(0);
  });
});
