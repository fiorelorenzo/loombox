import { PROTOCOL_V1, type PromptInjectV1 } from '@loombox/protocol';
import { expect, nodeOpen, sendSessionUpdate, test } from './fixtures';

/**
 * Reviving a disconnected session's agent on demand (issue #706/#912), at
 * 390px (AGENTS.md's headless-checking section). The client half of #706:
 * the composer stays usable for a `'disconnected'` session (sending is
 * what triggers revival), a `prompt_inject_result` `outcome: 'error'`
 * reaches the user as a real message, and the `'starting'` status's own
 * `reason` (the revival's honesty disclosure) renders as a visible
 * boundary row in the transcript, not just an ambient status string.
 */
test.describe('Reviving a disconnected session (issue #706/#912)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a disconnected session accepts a prompt, the revival boundary shows inline, and the conversation continues below it', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    // Some transcript history from before the (simulated) node restart.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-before',
      messageId: 'msg-before',
      text: 'This is what we discussed before the restart.',
    });
    await expect(page.getByText('This is what we discussed before the restart.')).toBeVisible();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'disconnected',
      updatedAt: new Date().toISOString(),
    });

    // The composer must stay usable — sending is what triggers revival.
    const textarea = page.getByTestId('composer-input');
    await expect(textarea).toBeEnabled();
    await textarea.fill('Are you still there?');
    await page.getByRole('button', { name: 'Send prompt' }).click();

    const routed = (await loombox.node.waitFor(
      (message) => message.type === 'prompt_inject',
    )) as PromptInjectV1;
    expect(routed.sessionId).toBe(loombox.session.sessionId);
    const decrypted = await nodeOpen<{ text: string }>(
      routed.sessionId,
      routed.envelope,
      loombox.session.key,
    );
    expect(decrypted.text).toBe('Are you still there?');

    // The node revives: 'starting', carrying the honesty disclosure a
    // real NodeDaemon.reviveSessionInternal pushes.
    const revivalReason =
      'Reviving this session: the node restarted, so this starts a brand-new agent process in the same workspace. It does not remember earlier turns — only the transcript above does.';
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'starting',
      updatedAt: new Date().toISOString(),
      reason: revivalReason,
    });

    const revivalRow = page.getByTestId('transcript-revival');
    await expect(revivalRow).toBeVisible();
    await expect(revivalRow).toContainText('does not remember earlier turns');

    // The revival succeeds, and the new agent answers.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'working',
      updatedAt: new Date().toISOString(),
    });
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-after',
      messageId: 'msg-after',
      text: "Yes, I'm here now.",
    });
    await expect(page.getByText("Yes, I'm here now.")).toBeVisible();

    // Order proof: the boundary sits strictly between the pre-restart
    // message and the revived agent's own reply — never let the new
    // reply read as a plain continuation.
    const rows = page.getByTestId('transcript-row');
    const rowTexts = await rows.allTextContents();
    const beforeIndex = rowTexts.findIndex((text) =>
      text.includes('This is what we discussed before the restart.'),
    );
    const revivalIndex = rowTexts.findIndex((text) => text.includes('does not remember'));
    const afterIndex = rowTexts.findIndex((text) => text.includes("Yes, I'm here now."));
    expect(beforeIndex).toBeGreaterThanOrEqual(0);
    expect(revivalIndex).toBeGreaterThan(beforeIndex);
    expect(afterIndex).toBeGreaterThan(revivalIndex);
  });

  test('a revival failure reaches the user as a real message, in the UI, not a console line', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'disconnected',
      updatedAt: new Date().toISOString(),
    });

    const textarea = page.getByTestId('composer-input');
    await expect(textarea).toBeEnabled();
    await textarea.fill('bring it back');
    await page.getByRole('button', { name: 'Send prompt' }).click();

    const routed = (await loombox.node.waitFor(
      (message) => message.type === 'prompt_inject',
    )) as PromptInjectV1;

    loombox.node.send({
      type: 'prompt_inject_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: loombox.session.sessionId,
      promptId: routed.promptId,
      result: {
        outcome: 'error',
        message: "Couldn't restart this session's agent: provider unreachable",
      },
    });

    const notice = page.getByTestId('ui-error-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Couldn't restart this session's agent");
  });
});
