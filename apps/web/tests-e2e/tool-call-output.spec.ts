import type { Page } from '@playwright/test';
import { expect, sendSessionUpdate, test, type LoomboxFixture } from './fixtures';

/**
 * A tool call's output renders as its text, not as the wire envelope
 * (issue #689).
 *
 * `content` on the ACP wire is an ARRAY of `ToolCallContent`, and
 * `toolCallOutputText` used to `JSON.stringify` anything that was not a
 * plain string — so a real agent's failed command printed
 * `[{"type":"content","content":{"type":"text","text":"..."}}]` where its
 * error should have been.
 *
 * It survived a full wire audit (#623, which fixed the sibling `diff` case)
 * and the v7 tool-call redesign (#668, which is entirely about how this
 * output is presented) because NOTHING ever sent one: `echo-acp-agent.mjs`
 * emits only message chunks, and every other e2e tool call omits `content`.
 * That fixture gap is the actual defect this file closes — the unit tests in
 * `tool-widgets.test.ts` cover the extraction, and this covers the thing
 * nobody was exercising, which is a tool call arriving over a real relay
 * with real content and being read by a human.
 */
async function gotoSession(page: Page, loombox: LoomboxFixture): Promise<void> {
  expect(loombox.session.sessionId).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('session-row-item').first().click();
}

test('a failed tool call shows its error text, not the content envelope (#689)', async ({
  page,
  loombox,
}) => {
  await gotoSession(page, loombox);
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'tool_call',
    id: 'tc-typecheck',
    turnId: 'turn-1',
    title: 'pnpm typecheck',
    toolKind: 'execute',
    status: 'failed',
    // The real ACP shape, verbatim: an array of ToolCallContent entries.
    content: [
      {
        type: 'content',
        content: { type: 'text', text: "src/a.ts(4,9): error TS2304: Cannot find name 'x'." },
      },
    ],
  });

  const row = page.getByTestId('tool-call-row').filter({ hasText: 'pnpm typecheck' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // C2-1: a failure is force-expanded, so the text is readable with no click.
  await expect(row).toContainText("error TS2304: Cannot find name 'x'.");
  // The regression itself: no envelope keys anywhere in the rendered row.
  await expect(row).not.toContainText('"type"');
  await expect(row).not.toContainText('"text"');
});
