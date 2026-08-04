import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The one spacing contract every form in the app depends on, asserted in a real
 * browser because it is a LAYOUT fact: `Field.svelte` gaps its own
 * label/control/help stack by `--space-3xs`, and its doc comment requires
 * anything stacking `Field`s to beat that "by at least `--space-sm`" — because
 * when the two distances are close, nothing groups and the form reads as a flat
 * run of alternating text and boxes (the "generic webapp form" tell the
 * coherence wave set out to remove).
 *
 * That rule was documented but unenforced, and it broke twice. Most recently
 * `AddTargetWizard`'s `.host-form` shipped `--space-2xs`: measured, 4px between
 * fields against 2px inside them, which is visually nothing. jsdom cannot catch
 * this at all (it performs no layout, so every rect is zero), which is exactly
 * why it belongs here rather than in a component test.
 */
async function measure(
  page: Page,
  // Scopes the scan to a container's own subtree rather than the whole
  // document. Needed now that the right sidebar (issue #571) can be open by
  // default alongside a modal: its `ProjectConfigPanel` carries `ui-field`s
  // of its own, and an unscoped `document.querySelectorAll` conflated a
  // sidebar field pair with the dialog's, driving `tightestBetween` to 0.
  // Optional (default the whole document) so the add-target wizard test
  // below, which has no such sibling `ui-field` on screen, is unaffected.
  rootSelector?: string,
): Promise<{ within: number[]; between: number[]; floorPx: number }> {
  return page.evaluate((selector) => {
    const root = selector ? document.querySelector(selector) : document;
    if (!root) throw new Error(`measure(): no element matched ${selector}`);
    const fields = Array.from(root.querySelectorAll('[data-testid="ui-field"]'));
    const within: number[] = [];
    const between: number[] = [];
    for (const field of fields) {
      const label = field.querySelector('.ui-field-label')?.getBoundingClientRect();
      const control = field.querySelector('.ui-field-control')?.getBoundingClientRect();
      if (label && control) within.push(control.top - label.bottom);
    }
    for (let i = 0; i < fields.length - 1; i += 1) {
      const current = fields[i].getBoundingClientRect();
      const nextLabel = fields[i + 1].querySelector('.ui-field-label')?.getBoundingClientRect();
      // Only compare siblings in the same stack: a field in a different column
      // or panel sits at an unrelated offset and would make this meaningless.
      if (nextLabel && nextLabel.top >= current.bottom) {
        between.push(nextLabel.top - current.bottom);
      }
    }
    // Resolve the documented floor from the page itself rather than hardcoding
    // 8px, so a retuned scale moves the test with it.
    const probe = document.createElement('div');
    probe.style.height = 'var(--space-sm)';
    document.body.append(probe);
    const floorPx = probe.getBoundingClientRect().height;
    probe.remove();
    return { within, between, floorPx };
  }, rootSelector);
}

function assertFieldsGroup(measured: {
  within: number[];
  between: number[];
  floorPx: number;
}): void {
  expect(measured.within.length).toBeGreaterThan(1);
  expect(measured.between.length).toBeGreaterThan(0);
  expect(measured.floorPx).toBeGreaterThan(0);
  const tightestBetween = Math.min(...measured.between);
  // The rule verbatim: at least `--space-sm` between stacked fields. Asserting
  // a RATIO against the within-field gap does not work - `--space-2xs` is
  // exactly 2x `--space-3xs`, so a `> within * 2` check passed the real
  // regression by 0.016px of sub-pixel rounding (which is how this assertion
  // got rewritten). The floor is the contract; compare against it directly.
  expect(tightestBetween).toBeGreaterThanOrEqual(measured.floorPx);
  // And it must still clearly beat the within-field gap, which is the point.
  expect(tightestBetween).toBeGreaterThan(Math.max(...measured.within) * 2);
}

test.describe('form rhythm (Field stacking contract)', () => {
  test('the add-target wizard groups its fields instead of listing them flat', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    loombox.node.send({
      type: 'target_announce',
      protocolVersion: 1,
      nodeId: 'e2e-node-daemon',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    } as never);

    await page.goto('/');
    await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('account-menu-toggle').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByTestId('settings-nav-nodes').click();
    await page.getByTestId('nodes-page-add-target').click();
    await expect(page.getByTestId('add-target-host')).toBeVisible({ timeout: 30_000 });

    assertFieldsGroup(await measure(page));
  });

  test('the new-session dialog groups its fields too', async ({ page, loombox }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    loombox.node.send({
      type: 'target_announce',
      protocolVersion: 1,
      nodeId: 'e2e-node-daemon',
      targets: [
        { id: 'local', kind: 'local', label: 'This machine', providers: ['claude', 'ohmypi'] },
      ],
    } as never);

    await page.goto('/');
    await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('project-new-session-row').first().click();
    await expect(page.getByTestId('new-session-prompt')).toBeVisible({ timeout: 30_000 });

    assertFieldsGroup(await measure(page, '[data-testid="dialog"]'));
  });

  test('the tracker config panel (issue #220) groups its fields once live mode reveals more than one', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();

    await page.goto('/');
    await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('project-config-toggle').click();
    await expect(page.getByTestId('tracker-config-panel')).toBeVisible({ timeout: 30_000 });

    // Native-only shows a single Field (nothing to compare a gap against
    // yet); live mode reveals the provider + account + target fields this
    // contract is actually about.
    await page.getByTestId('tracker-mode-live').click();
    await expect(page.getByTestId('tracker-provider')).toBeVisible();

    assertFieldsGroup(await measure(page, '[data-testid="tracker-config-panel"]'));
  });
});
