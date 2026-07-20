import type { PromptInjectV1 } from '@loombox/protocol';
import { expect, nodeOpen, sendSessionUpdate, test } from './fixtures';

/**
 * Attention-inbox items actionable inline (issue #168): the approve/deny
 * and Open actions shipped in #342 (see `AttentionInbox.test.ts`'s
 * "inline actions" suite); this spec is the remaining acceptance bullet,
 * the inline reply composer, driven end to end through a real browser
 * against a real relay + fake node — the reply must reach the node as a
 * real (encrypted) `prompt_inject`, the exact same wire path the
 * session's own composer form uses.
 */
test.describe('Attention inbox: inline reply (issue #168)', () => {
  test('replying to an awaiting_input item from the inbox sends a follow-up without navigating into the session', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    // The session transitions to awaiting_input, which is what makes it
    // show up in the attention inbox as a reply-able item.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'awaiting_input',
      updatedAt: new Date().toISOString(),
    });

    const inboxToggle = page.getByTestId('inbox-toggle');
    await expect(page.getByTestId('inbox-count')).toHaveText('1');
    await inboxToggle.click();

    const row = page.getByTestId('attention-inbox-item');
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Waiting for your reply')).toBeVisible();

    const replyInput = row.getByTestId('attention-inbox-reply-input');
    await replyInput.fill('Looks good, go ahead and merge it.');
    await row.getByTestId('attention-inbox-reply-send').click();

    // Never left the inbox panel to do it - no session was opened/selected.
    await expect(page.getByTestId('inbox-toggle')).toHaveClass(/active/);

    const routed = (await loombox.node.waitFor(
      (message) => message.type === 'prompt_inject',
    )) as PromptInjectV1;
    expect(routed.sessionId).toBe(loombox.session.sessionId);

    const plaintext = await nodeOpen<{ text: string }>(
      routed.sessionId,
      routed.envelope,
      loombox.session.key,
    );
    expect(plaintext.text).toBe('Looks good, go ahead and merge it.');
  });
});
