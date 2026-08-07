import type { Page } from '@playwright/test';
import { expect, sendSessionUpdate, test, type LoomboxFixture } from './fixtures';

/**
 * The canvas tab strip (issue #737, settled pick B2-2). Exercises the one
 * entry point that needs no wire round trip beyond a plain `session_update`
 * — a diff-carrying tool call's own "Open" affordance on `DiffViewer` — and
 * the required, not-optional narrow-viewport behaviour: below
 * `TABLET_VIEWPORT_BREAKPOINT_PX` (768px) the horizontal strip becomes a
 * single active tab plus a `Dialog`-backed picker (`CanvasTabStrip.svelte`'s
 * own doc comment names this as the decisions doc's own first option).
 * Content loading itself (`fs_read_request`/`fs_read_response`) is covered
 * at the unit level (`relay-client.test.ts`, `node-daemon.test.ts`) — this
 * spec only proves the tab strip's own structure and narrow swap render
 * correctly against a real browser, which needs real layout/CSS to observe.
 */
async function gotoCockpit(page: Page, loombox: LoomboxFixture): Promise<void> {
  expect(loombox.session.sessionId).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('session-row-item').first()).toBeVisible({ timeout: 60_000 });
}

async function seedDiffTurn(loombox: LoomboxFixture): Promise<void> {
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'tool_call',
    id: 'tool-edit-1',
    turnId: 'turn-1',
    title: 'Edit src/foo.ts',
    toolKind: 'edit',
    status: 'completed',
    diff: {
      path: 'src/foo.ts',
      oldText: 'const x = 1;\n',
      newText: 'const x = 2;\n',
    },
  });
}

test.describe('canvas tab strip (issue #737)', () => {
  test('opening a file from a diff card\u2019s "Open" affordance adds a real, closable tab beside the permanent, non-closable transcript tab', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedDiffTurn(loombox);

    await expect(page.getByTestId('canvas-tab-strip')).toBeVisible();
    await expect(page.getByTestId('canvas-tab')).toHaveCount(1); // transcript only, so far

    // A completed edit card rests collapsed (issue #668's C1-1) — expand
    // it to reach the diff body and its "Open" affordance.
    await page.getByTestId('row-header').click();
    await page.getByRole('button', { name: 'Open src/foo.ts' }).click();

    const tabs = page.getByTestId('canvas-tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0).getByTestId('canvas-tab-close')).toHaveCount(0);
    await expect(tabs.nth(1)).toContainText('foo.ts');
    await expect(tabs.nth(1).getByTestId('canvas-tab-close')).toBeVisible();

    // The newly opened tab is the active one, and the transcript's own
    // composer/timeline are hidden behind it (never both at once).
    await expect(page.getByTestId('file-editor')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toBeHidden();

    // Switching back to the transcript tab restores the composer, and the
    // file tab survives (not remounted/lost) rather than being discarded.
    await tabs.nth(0).getByTestId('canvas-tab-activate').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByTestId('canvas-tab')).toHaveCount(2);
  });

  test('below 768px the strip collapses to a single active tab plus a picker — the required narrow-viewport answer, tested at 390px', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedDiffTurn(loombox);
    await page.getByTestId('row-header').click();
    await page.getByRole('button', { name: 'Open src/foo.ts' }).click();
    await expect(page.getByTestId('file-editor')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });

    // No horizontal strip of tab chips at this width.
    await expect(page.getByTestId('canvas-tab')).toHaveCount(0);

    // The active tab renders inline, plus a picker trigger.
    const trigger = page.getByTestId('canvas-tab-strip-picker-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('foo.ts');

    // The active file tab's own close button stays reachable without
    // opening the picker first.
    await expect(page.getByTestId('canvas-tab-strip-close-active')).toBeVisible();

    // The picker opens a dialog listing every open tab, including the
    // permanent transcript tab.
    await trigger.click();
    const items = page.getByTestId('canvas-tab-picker-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Session');
    await expect(items.nth(1)).toContainText('foo.ts');

    // Picking the transcript tab switches to it and closes the picker.
    await items.nth(0).click();
    await expect(page.getByTestId('canvas-tab-picker-list')).toBeHidden();
    await expect(trigger).toContainText('Session');
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });
});
