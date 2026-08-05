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
 * Cockpit v8 decision E1-2 (issue #711) collapsed the three-plus inline
 * pickers behind one trigger + popover; every assertion below now opens
 * that popover first (the jsdom suite covers the popover's own mechanics
 * — focus, Escape, Tab-trap — this spec's job stays what it always was:
 * prove the bar renders off REAL wire traffic and a REAL pick reaches the
 * node, plus the two things E1-2 newly makes assertable, the trigger's
 * own summary and what happens to an open popover when a wholesale
 * update lands under it).
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
        // rather than being silently dropped — and, since E1-2, joins the
        // trigger's own dot-joined summary the same generic way.
        {
          category: 'sandbox_profile',
          current: 'default',
          choices: [{ id: 'default', name: 'Default' }],
        },
      ],
    });

    // The trigger reads live off the negotiated catalog before a user ever
    // opens anything — E1-2's whole point, and nothing inside it is visible
    // yet.
    const trigger = page.getByTestId('config-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText('Sonnet · Medium · Default');
    await expect(page.getByTestId('config-option-model')).toHaveCount(0);

    await trigger.click();
    const popover = page.getByTestId('config-popover');
    await expect(popover).toBeVisible();
    await expect(page.getByTestId('config-option-model')).toBeVisible();
    await expect(page.getByTestId('config-option-thought_level')).toBeVisible();
    await expect(page.getByTestId('config-option-mode')).toBeVisible();
    await expect(page.getByTestId('config-option-sandbox_profile')).toBeVisible();

    // A user pick on a category rendered by the shared `ui/Select`
    // primitive (button trigger + listbox, redesign v3 §3.5) sends a
    // clear config_option.
    await page.getByTestId('config-option-model').getByRole('combobox').click();
    await page.getByRole('option', { name: 'Haiku' }).click();
    const modelChange = (await loombox.node.waitFor(
      (message) => message.type === 'config_option' && message.category === 'model',
    )) as ConfigOption;
    expect(modelChange).toMatchObject({
      sessionId: loombox.session.sessionId,
      category: 'model',
      optionId: 'haiku',
    });

    // Mode renders as a radiogroup (issue #549: role="radio"/aria-checked,
    // not a plain button, so the current mode is in the a11y tree).
    const modeGroup = page.getByTestId('config-option-mode');
    await expect(modeGroup.getByRole('radio', { name: 'Default', checked: true })).toBeVisible();
    await modeGroup.getByRole('radio', { name: 'Plan', checked: false }).click();
    const modeChange = (await loombox.node.waitFor(
      (message) => message.type === 'config_option' && message.category === 'mode',
    )) as ConfigOption;
    expect(modeChange).toMatchObject({ category: 'mode', optionId: 'plan' });

    // The interesting case E1-2 adds: an unprompted config_option_update
    // (e.g. an automatic model downgrade) can land WHILE the popover is
    // still open. A naive implementation either drops the update (stale
    // options behind an already-rendered panel) or force-closes the
    // popover out from under the user — this bar must do neither: it
    // stays open and re-renders wholesale, exactly like the always-visible
    // bar did before E1-2. A category absent from the new catalog
    // disappears too, never left stale from a per-control patch.
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

    await expect(popover).toBeVisible();
    await expect(page.getByTestId('config-option-model').getByRole('combobox')).toHaveText(
      'Haiku (fallback)',
    );
    await expect(page.getByTestId('config-option-mode')).toHaveCount(0);
    await expect(page.getByTestId('config-option-thought_level')).toHaveCount(0);
    await expect(page.getByTestId('config-option-sandbox_profile')).toHaveCount(0);

    // ...and the trigger behind the still-open popover tracks the same
    // wholesale replacement, not just the panel above it.
    await expect(trigger).toHaveText('Haiku (fallback)');
  });
});
