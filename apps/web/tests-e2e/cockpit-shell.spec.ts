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
 * The cockpit shell, covering both redesigns it has been through.
 *
 * v3 (design spec `2026-07-25-redesign-v3-design.md` §3.1-§3.6) gave it one
 * sidebar and one timeline; v4 (`2026-07-25-ia-v4-design.md`) fixed what the
 * navigation actually meant. Every assertion here is about an affordance one
 * of the two either lacked or shipped broken, and every one needs a real
 * browser: focus location decides whether Escape reaches an overlay,
 * `:hover` decides whether the row menu exists, and a scrim is only
 * observable as a painted element over the app.
 */
test.describe('cockpit shell', () => {
  test('the sidebar filters sessions, and clearing the query restores them', async ({
    page,
    loombox,
  }) => {
    // A second session on a second project, so the filter has something to
    // discard and the tree has two groups to render.
    const other = new FakeNode(loombox.relay.url, {
      deviceId: 'e2e-node-2',
      devicePublicKey: randomBase64(),
      authToken: loombox.token,
    });
    await other.ready;
    await announceSession(other, {
      amk: loombox.amk,
      accountId: loombox.accountId,
      sessionId: `sess_filter_${Date.now()}`,
      nodeId: 'e2e-node-2-daemon',
      targetId: 'local',
      provider: 'claude',
      title: 'Totally unrelated work',
      projectPath: '/workspace/other-project',
    });

    await gotoCockpit(page, loombox);
    const rows = page.getByTestId('session-row-item');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });

    await page.getByTestId('session-filter').fill('unrelated');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Totally unrelated work');

    // The filter matches a project name too, not only a session title: the
    // tree groups by project now, so filtering that can't reach the group
    // header would be filtering half the surface.
    await page.getByTestId('session-filter').fill('e2e-project');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('E2E session');

    await page.getByTestId('session-filter').fill('');
    await expect(rows).toHaveCount(2);
    other.close();
  });

  test('the account menu is an anchored popover with no scrim, and Escape closes it', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.getByTestId('account-menu-toggle').click();
    await expect(page.getByTestId('account-menu')).toBeVisible();

    // v2 dimmed the entire app behind a 40% scrim to show two menu items.
    // An anchored popover paints no backdrop at all.
    await expect(page.getByTestId('drawer-backdrop')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toHaveCount(0);
  });

  test('the Drawer closes on Escape and on a backdrop click', async ({ page, loombox }) => {
    await gotoCockpit(page, loombox);
    // The drawer is the open session's workbench now, so it is opened from a
    // session-scoped control rather than from a global navigation item.
    await page.getByTestId('file-tree-toggle').click();
    await expect(page.getByTestId('drawer')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toHaveCount(0);

    await page.getByTestId('file-tree-toggle').click();
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

    // v4: target status is a destination in the main area, not a drawer tab.
    // Coherence v5 §2: the topbar's own title span is gone, so the page
    // title lives only in `PageLayout`'s real `<h1>` now.
    await expect(page.getByTestId('nodes-page').getByRole('heading', { level: 1 })).toHaveText(
      /nodes/i,
    );
    await expect(page.getByTestId('drawer')).toHaveCount(0);
  });

  test('the drawer carries only the open session workbench, not the global destinations', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.getByTestId('file-tree-toggle').click();
    await expect(page.getByTestId('drawer')).toBeVisible();

    // v3 shipped six tabs, three of which repeated the sidebar's own
    // navigation. Inbox, Nodes and Settings are pages now and must not be
    // reachable as a tab as well.
    await expect(page.getByTestId('drawer-tab-inbox')).toHaveCount(0);
    await expect(page.getByTestId('drawer-tab-targets')).toHaveCount(0);
    await expect(page.getByTestId('drawer-tab-settings')).toHaveCount(0);
    await expect(page.getByTestId('drawer-tab-files')).toBeVisible();
  });

  test('a destination switches the main area and keeps the session selected', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.getByTestId('session-row-item').first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('destination-inbox').click();
    await expect(page.getByTestId('inbox-page').getByRole('heading', { level: 1 })).toHaveText(
      /inbox/i,
    );
    // The transcript is replaced, not overlaid: no drawer, no scrim.
    await expect(page.getByTestId('composer-input')).toHaveCount(0);
    await expect(page.getByTestId('drawer')).toHaveCount(0);

    // Returning is one click, because the session stayed selected.
    await page.getByTestId('session-row-item').first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });

  test('the composer reads as the last entry in the timeline, not a chat box', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.getByTestId('session-row-item').first().click();
    const input = page.getByTestId('composer-input');
    await expect(input).toBeVisible();

    // Coherence v5 §4: the hint is wired to the field rather than floating
    // under it as decoration, so a screen reader gets it at the same moment
    // a sighted reader does.
    const hintId = await input.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    await expect(page.locator(`#${hintId}`)).toContainText('Enter');

    // The two things that made this a chat widget: a rounded pill and a
    // filled surface of its own. Both gone - the composer draws no box at all.
    const row = page.locator('.composer-row');
    const radius = await row.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(radius).toBe('0px');

    // What separates the composer from the transcript is one hairline across
    // the whole docked strip (plan, queued prompts, permissions, composer),
    // drawn once on the footer rather than per element - otherwise each of
    // those reads as a stray transcript item that fell to the bottom.
    const footerBorder = await page
      .locator('.canvas-footer')
      .evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(footerBorder).not.toBe('0px');

    // Same role column the transcript runs, so it does not restart at the
    // composer. Compared against the shared `--gutter` token rather than
    // against a rendered transcript item: this fixture's session has no
    // updates yet, so there is no item to measure, and the token IS the
    // contract both surfaces are meant to read.
    const { gutterWidth, token } = await page.locator('.composer-gutter').evaluate((el) => ({
      gutterWidth: getComputedStyle(el).width,
      token: getComputedStyle(document.documentElement).getPropertyValue('--gutter').trim(),
    }));
    expect(token).not.toBe('');
    const remPx = await page.evaluate(
      () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    );
    expect(parseFloat(gutterWidth)).toBeCloseTo(parseFloat(token) * remPx, 1);
  });

  test('Settings is reachable from the account menu, not the sidebar or the mobile tabbar', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);

    // Coherence v5 §2: removed from both places the redesign closed —
    // the sidebar's primary destinations and the mobile tabbar (hidden by
    // a `@media` query, not conditionally rendered, so its absence here is
    // unconditional too).
    await expect(page.getByTestId('destination-settings')).toHaveCount(0);
    await expect(page.getByTestId('tabbar-settings')).toHaveCount(0);

    await page.getByTestId('account-menu-toggle').click();
    await page.getByRole('menuitem', { name: /appearance.*settings/i }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
  });

  test('sessions are nested under their project, and creation is project-scoped', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);

    // The project the fixture's session runs in was adopted into the
    // registry, so the tree has a group even though nobody added it by hand.
    const group = page.getByTestId('project-group').first();
    await expect(group).toBeVisible();
    await expect(group.getByTestId('project-group-header')).toContainText('e2e-project');
    await expect(group.getByTestId('session-row-item').first()).toBeVisible();

    // v3's global "New session" button is gone: every entry point carries a
    // project, so the one in the tree belongs to this group.
    await expect(page.getByTestId('new-session-button')).toHaveCount(0);
    await expect(group.getByTestId('project-new-session-row')).toBeVisible();
  });

  test('"Add a target" lives on the Nodes page, not in the sidebar', async ({ page, loombox }) => {
    await gotoCockpit(page, loombox);
    // It used to sit beside "New session" in a 288px column where both
    // wrapped onto two lines, then behind that button's split menu. It is a
    // once-per-machine setup step, so it belongs with the other ones.
    await expect(page.getByTestId('add-target-button')).toHaveCount(0);

    await page.getByTestId('destination-nodes').click();
    await page.getByTestId('nodes-page-add-target').click();
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
