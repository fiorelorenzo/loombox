import type { ConfigOption } from '@loombox/protocol';
import { expect, sendSessionUpdate, test } from './fixtures';

/**
 * The model/mode/reasoning-effort bar (issue #149): `ConfigBar.svelte`'s
 * read side (render straight off `options`, wholesale re-render on any
 * change) already shipped in #341 with jsdom component coverage
 * (`ConfigBar.test.ts`); this is the browser-driven proof the same bar
 * renders correctly off REAL `config_options`/`config_option_update` wire
 * traffic from a real (fake) node and that a user pick actually reaches
 * the node as a `config_option` message.
 *
 * Honest gap (not this spec's job to close): #149's "an automatic fallback
 * event also creates an attention-inbox item" acceptance bullet has no
 * implementation yet — `RelayClient.attentionInbox()`'s `AttentionInboxItem`
 * only ever carries `'permission' | 'awaiting_input'` kinds (see that
 * type's own doc comment), so #149 stays open after this spec, not closed.
 */
test.describe('Model/mode/reasoning-effort bar (issue #149, read side)', () => {
  test('renders from the negotiated config options, re-renders wholesale on an update, and emits a change', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'config_options',
      options: [
        {
          category: 'model',
          current: 'sonnet',
          choices: [
            { id: 'sonnet', name: 'Sonnet' },
            { id: 'haiku', name: 'Haiku' },
          ],
        },
        {
          category: 'mode',
          current: 'default',
          choices: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        {
          category: 'thought_level',
          current: 'medium',
          choices: [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ],
        },
        // An unrecognized category (SPEC §7.24) still renders generically,
        // rather than being silently dropped.
        {
          category: 'sandbox_profile',
          current: 'default',
          choices: [{ id: 'default', name: 'Default' }],
        },
      ],
    });

    await expect(page.getByTestId('config-bar')).toBeVisible();
    await expect(page.getByTestId('config-option-model')).toBeVisible();
    await expect(page.getByTestId('config-option-thought_level')).toBeVisible();
    await expect(page.getByTestId('config-option-mode')).toBeVisible();
    await expect(page.getByTestId('config-option-sandbox_profile')).toBeVisible();

    // A user pick on a plain <select> category sends a clear config_option.
    await page.getByTestId('config-option-model').locator('select').selectOption('haiku');
    const modelChange = (await loombox.node.waitFor(
      (message) => message.type === 'config_option' && message.category === 'model',
    )) as ConfigOption;
    expect(modelChange).toMatchObject({
      sessionId: loombox.session.sessionId,
      category: 'model',
      optionId: 'haiku',
    });

    // Mode renders as a segmented control (buttons), not a <select>.
    await page.getByTestId('config-option-mode').getByRole('button', { name: 'Plan' }).click();
    const modeChange = (await loombox.node.waitFor(
      (message) => message.type === 'config_option' && message.category === 'mode',
    )) as ConfigOption;
    expect(modeChange).toMatchObject({ category: 'mode', optionId: 'plan' });

    // An unprompted config_option_update (e.g. an automatic model
    // downgrade) fully replaces the catalog wholesale — a category absent
    // from the new catalog disappears too, never left stale from a
    // per-control patch.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'config_option_update',
      options: [
        {
          category: 'model',
          current: 'haiku-fallback',
          choices: [{ id: 'haiku-fallback', name: 'Haiku (fallback)' }],
        },
      ],
    });
    await expect(page.getByTestId('config-option-model').locator('select')).toHaveValue(
      'haiku-fallback',
    );
    await expect(page.getByTestId('config-option-mode')).toHaveCount(0);
    await expect(page.getByTestId('config-option-thought_level')).toHaveCount(0);
  });
});
