import { expect, sendSessionUpdate, test } from './fixtures';

/**
 * The live session view (issue #127): opening a session subscribes to its
 * live update stream and renders incoming events as they arrive — the one
 * acceptance bullet that genuinely needs a real browser (the subscribe/
 * decrypt/reduce plumbing itself is already exhaustively covered against a
 * real relay + fake node in `relay-client.test.ts`, headlessly). This
 * session auto-selects (`+page.svelte`'s "no session selected yet, pick the
 * first one" default): it's the only session in the account's list.
 */
test.describe('Live session view (issue #127)', () => {
  test('renders streamed transcript output live as it arrives, not just a one-shot snapshot', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');

    // The composer only renders once a session is selected.
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-1',
      text: 'Hello from the agent',
    });
    await expect(page.getByText('Hello from the agent')).toBeVisible();

    // A second chunk on the SAME (turnId, messageId) accumulates onto the
    // existing item (the reducer's append-by-id contract, proven in
    // `relay-client.test.ts`) rather than appending a new one — visible
    // proof this is a live stream being rendered incrementally, not a
    // single decrypted snapshot.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-1',
      text: ', streaming in real time.',
    });
    await expect(page.getByText('Hello from the agent, streaming in real time.')).toBeVisible();

    // A second, independent turn renders as its own item alongside the first.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-2',
      messageId: 'msg-2',
      text: 'A second, later message.',
    });
    await expect(page.getByText('A second, later message.')).toBeVisible();
    await expect(page.getByText('Hello from the agent, streaming in real time.')).toBeVisible();
  });
});
