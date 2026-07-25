import type { Page } from '@playwright/test';
import { announceSession, expect, FakeNode, test, type LoomboxFixture } from './fixtures';
import { randomBase64 } from './harness/relay-harness';

/**
 * Navigates to the app and waits for the cockpit to actually be up: this
 * fixture stands up a real relay, signs a real user up over real HTTP, and
 * the client then connects a WebSocket and decrypts its session list, which
 * takes noticeably longer than the default 5s expect timeout once several
 * workers are doing it at once.
 */
async function gotoCockpit(page: Page, loombox: LoomboxFixture): Promise<void> {
  // `loombox` is required, not decorative: Playwright only sets a fixture up
  // for a test that actually asks for it, and this one is what stands the
  // relay up and seeds the bearer token + AMK into `localStorage` before the
  // first navigation. A test that takes only `page` lands on the signed-out
  // gate pointed at the PUBLIC relay and hangs on "Checking session".
  expect(loombox.session.sessionId).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('session-row-item').first()).toBeVisible({ timeout: 60_000 });
}

/**
 * The redesign v3 cockpit shell (design spec §3.1-§3.6). Every assertion
 * here is about an affordance the v2 shell either lacked or shipped broken,
 * and every one of them needs a real browser: focus location decides whether
 * Escape reaches an overlay, `:hover` decides whether the row menu exists,
 * and a scrim is only observable as a painted element over the app.
 */
test.describe('cockpit shell (redesign v3)', () => {
  test('the sidebar filters sessions, and clearing the query restores them', async ({
    page,
    loombox,
  }) => {
    const second = new FakeNode(loombox.relay.url, {
      deviceId: 'shell-spec-node',
      devicePublicKey: randomBase64(),
      authToken: loombox.token,
    });
    await second.ready;
    await announceSession(second, {
      amk: loombox.amk,
      accountId: loombox.accountId,
      sessionId: 'sess_shell_spec',
      nodeId: 'shell-spec-daemon',
      targetId: 'ssh:build-server',
      provider: 'codex',
      title: 'Unrelated pitchbox work',
      projectPath: '/workspace/pitchbox',
    });

    await gotoCockpit(page, loombox);
    const rows = page.getByTestId('session-row-item');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });

    await page.getByTestId('session-filter').fill('pitchbox');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Unrelated pitchbox work');

    // A query nothing matches says so, rather than rendering an empty list
    // that reads as "you have no sessions".
    await page.getByTestId('session-filter').fill('zzzz-no-such-session');
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('session-filter-empty')).toBeVisible();

    await page.getByTestId('session-filter').fill('');
    await expect(rows).toHaveCount(2);

    second.close();
  });

  test('the account menu is an anchored popover with no scrim, and Escape closes it', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);

    await page.getByTestId('account-menu-toggle').click();
    await expect(page.getByTestId('account-menu')).toBeVisible();
    // The v2 menu rendered through `Overlay`, dimming the whole app behind a
    // two-item list. A menu is not modal.
    await expect(page.getByTestId('overlay-backdrop')).toHaveCount(0);

    // Focus stays on the trigger, outside the menu — which is exactly the
    // case the old backdrop-bound keydown handler could never see.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toHaveCount(0);
  });

  test('the Drawer closes on Escape and on a backdrop click', async ({ page, loombox }) => {
    await gotoCockpit(page, loombox);
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('drawer')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toHaveCount(0);

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    // Click the backdrop away from the panel (which stops propagation).
    await page.getByTestId('drawer-backdrop').click({ position: { x: 40, y: 300 } });
    await expect(page.getByTestId('drawer')).toHaveCount(0);
  });

  test('a session row exposes its actions on hover instead of a permanent second button', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const row = page.getByTestId('session-row-item').first();

    // The target-status action exists, but only once the row is engaged —
    // it used to be a permanently rendered button wide enough to squeeze
    // the title down to a single character.
    await expect(page.getByTestId('session-target-status-link')).toHaveCount(0);
    await row.hover();
    await page.getByTestId('session-row-more').first().click();
    await page.getByTestId('session-target-status-link').click();

    await expect(page.getByTestId('drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-tab-targets')).toHaveAttribute('aria-selected', 'true');
  });

  test('"Add a target" lives behind the New session split menu, not beside it', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await expect(page.getByTestId('new-session-button')).toBeVisible();
    await expect(page.getByTestId('add-target-button')).toHaveCount(0);

    await page.getByTestId('new-session-menu-toggle').click();
    await expect(page.getByTestId('new-session-menu')).toBeVisible();
    await page.getByTestId('add-target-button').click();
    await expect(page.getByRole('heading', { name: 'Add target' })).toBeVisible();
  });

  test('collapsing the sidebar is reversible', async ({ page, loombox }) => {
    await gotoCockpit(page, loombox);
    const sidebar = page.getByTestId('sessions-column');
    const toggle = page.getByTestId('sidebar-collapse-toggle');

    await expect(page.getByTestId('session-filter')).toBeVisible();
    await toggle.click();
    await expect(sidebar).toHaveClass(/collapsed/);
    await expect(page.getByTestId('selvage-session-list')).toBeVisible();

    // The control must survive its own collapse — hiding it made collapsing
    // a one-way door out of the full sidebar.
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(sidebar).not.toHaveClass(/collapsed/);
    await expect(page.getByTestId('session-filter')).toBeVisible();
  });

  test('the header shows no connection chip while the relay connection is healthy', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    // v2 spent the header's highest-attention corner on a permanently green
    // dot. A healthy connection is now silent.
    await expect(page.getByTestId('connection-status-chip')).toHaveCount(0);
  });
});
