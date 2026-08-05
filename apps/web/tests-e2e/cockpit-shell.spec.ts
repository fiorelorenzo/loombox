import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  announceSession,
  expect,
  FakeNode,
  sendSessionUpdate,
  test,
  type LoomboxFixture,
} from './fixtures';
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
 * One agent turn plus one tool call: the two transcript row types that share
 * the timeline's role column with the composer, so a test can measure all
 * three against each other.
 */
async function seedTurnWithToolCall(loombox: LoomboxFixture): Promise<void> {
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'agent_message_chunk',
    turnId: 'turn-column',
    messageId: 'msg-column',
    text: 'One turn, so the transcript has a role word and a measurable line of prose.',
  });
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'tool_call',
    id: 'tool-column',
    turnId: 'turn-column',
    title: 'Read packages/relay/src/router.ts',
    toolKind: 'read',
    status: 'completed',
  });
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
    await expect(page.getByTestId('right-sidebar-backdrop')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toHaveCount(0);
  });

  test('below --bp-desktop the right sidebar is a sheet: it scrims, closes on Escape and on a backdrop click, and leaves the transcript untouched (design spec §3.3, issue #571)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    // The right sidebar is docked (no scrim at all) at this suite's default
    // 1280x720 viewport — issue #571's whole point. The overlay/backdrop
    // behaviour this test guards only exists below `--bp-desktop` (1024px),
    // so it moved here from the old "panel switch opens one panel at a
    // time" test, which used to guard it at the (now-docked) default width.
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('workbench-toggle').click();
    await expect(page.getByTestId('right-sidebar')).toBeVisible();
    await expect(page.getByTestId('right-sidebar-backdrop')).toBeVisible();
    // The sheet sits over the canvas, not in place of it — the transcript
    // underneath stays mounted and interactive the whole time.
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('right-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('workbench-toggle').click();
    await expect(page.getByTestId('right-sidebar')).toBeVisible();
    // Click the backdrop away from the panel (which stops propagation).
    await page.getByTestId('right-sidebar-backdrop').click({ position: { x: 40, y: 300 } });
    await expect(page.getByTestId('right-sidebar')).toHaveCount(0);
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
    // Issue #568: Nodes moved from its own destination into a Settings
    // section, so the deep link now lands on Settings with that section
    // selected, not its own page — the target-status view itself keeps its
    // own `<h2>`, `PageLayout`'s `<h1>` reads "Settings".
    await expect(page.getByTestId('settings-page').getByRole('heading', { level: 1 })).toHaveText(
      /settings/i,
    );
    await expect(page.getByTestId('settings-section-nodes')).toBeVisible();
    await expect(page.getByTestId('right-sidebar')).toHaveCount(0);
  });

  test('exactly one h1 per view, and it names the view rather than the app', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const h1 = page.getByRole('heading', { level: 1 });

    // The wordmark used to be an `<h1>` too, so every page carried two and one
    // of them was always wrong: the app's name never changes, so it cannot be
    // the heading of a view.
    await page.getByTestId('session-row-item').first().click();
    await expect(h1).toHaveCount(1);
    // `fixtures.ts` announces this one session under exactly this title.
    await expect(h1).toHaveText('E2E session');

    for (const [destination, expected] of [['destination-inbox', /inbox/i]] as const) {
      await page.getByTestId(destination).click();
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveText(expected);
    }

    // Nodes moved into Settings (issue #568): no destination row left to
    // click, so this reaches it through the account menu instead, and the
    // Nodes section gets an `<h2>`, not a second `<h1>`.
    await page.getByTestId('account-menu-toggle').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText(/settings/i);

    await page.getByTestId('settings-nav-nodes').click();
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText(/settings/i);
    await expect(page.getByRole('heading', { level: 2, name: 'Nodes and targets' })).toBeVisible();
  });

  test('the right sidebar carries only the open session panels, not the global destinations, and offers no third-Terminal tab', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    // One topbar control for the sidebar itself now (design spec §3.3,
    // issue #571), not the old three-button "Panels" group — and it is
    // already open, since a session is selected at this suite's default
    // wide viewport.
    await expect(page.getByTestId('workbench-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('right-sidebar')).toBeVisible();

    // v3 shipped six tabs, three of which repeated the sidebar's own
    // navigation. Inbox, Nodes and Settings are pages now and must not be
    // reachable as a panel as well; Terminal left this panel entirely for
    // its own dock (#572) and must not be reachable here either.
    await expect(page.getByTestId('inbox-toggle')).toHaveCount(0);
    await expect(page.getByTestId('targets-toggle')).toHaveCount(0);
    await expect(page.getByTestId('settings-toggle')).toHaveCount(0);
    await expect(page.getByTestId('terminal-toggle')).toHaveCount(0);

    // The sub-tabs are a real `radiogroup` — a named set (Files, Config,
    // Runner; issue #244 added Runner as a third), not a raw `toHaveCount`
    // that would silently pass whether a tab was lost or an unrelated one
    // (e.g. Terminal) crept back in. Asserting each accessible name AND
    // that the group's total matches the named set catches both.
    const tabs = page.getByRole('radiogroup', { name: 'Workbench panel' });
    const radios = tabs.getByRole('radio');
    await expect(radios).toHaveCount(3);
    await expect(radios.filter({ hasText: 'Files' })).toHaveCount(1);
    await expect(radios.filter({ hasText: 'Config' })).toHaveCount(1);
    await expect(radios.filter({ hasText: 'Runner' })).toHaveCount(1);
    await expect(radios.filter({ hasText: 'Terminal' })).toHaveCount(0);
    await expect(page.getByTestId('file-tree-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('file-tree-panel-wrapper')).toBeVisible();
  });

  test('the Workbench toggle carries no label at any width — C1-3 kills it outright, not just below the width Terminal/Jump to… still reveal theirs at (v8 C1-3, issue #710)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.getByTestId('session-row-item').first().click();
    const workbench = page.getByTestId('workbench-toggle');

    // Suite default viewport is 1280x720 (>= the 1280px `.panel-word`
    // breakpoint), where the terminal dock toggle still reveals its own
    // text label — proving Workbench's absence below is the label being
    // gone from the DOM outright, not a width this suite happens to run
    // under.
    await expect(page.getByTestId('terminal-dock-toggle')).toContainText('Terminal');
    await expect(workbench).not.toContainText('Workbench');
    await expect(workbench).toHaveAttribute('aria-label', 'Workbench');
    await expect(workbench).toHaveAttribute('title', 'Workbench');

    // C1-3's own pick was "in the same order", not "hidden until there's
    // room" — a labelled button widening back in at 1920px would be
    // exactly the option Lorenzo did NOT choose (C1-1/C1-2).
    await page.setViewportSize({ width: 1920, height: 1000 });
    await expect(workbench).not.toContainText('Workbench');
  });

  test("the Agent/Tracker switch's centre tracks the topbar's own centre, not the two flanking zones, with a very long project path and a very short one (v8 D1-1, issue #710)", async ({
    page,
    loombox,
  }) => {
    const longNode = new FakeNode(loombox.relay.url, {
      deviceId: 'e2e-node-long-path',
      devicePublicKey: randomBase64(),
      authToken: loombox.token,
    });
    await longNode.ready;
    await announceSession(longNode, {
      amk: loombox.amk,
      accountId: loombox.accountId,
      sessionId: `sess_long_path_${Date.now()}`,
      nodeId: 'e2e-node-long-path-daemon',
      targetId: 'relay-eu-west-1-worker-03.internal.staging.example.corp',
      provider: 'claude',
      title: 'Migrate the relay worker fleet to the new staging cluster end to end',
      projectPath:
        '/workspace/loombox-relay-worker-eu-west-1-staging-cluster-very-long-project-name-for-real',
    });

    await gotoCockpit(page, loombox);

    // The topbar's own bounding box IS the window's centre, minus its
    // symmetric inline padding — measuring against it directly, rather
    // than the viewport, is what actually proves the grid (not a
    // coincidence of this suite's own symmetric chrome).
    const centreDelta = async (): Promise<number> => {
      const topbarBox = await page.locator('.topbar').boundingBox();
      const switchBox = await page.getByTestId('topbar-view-switch').boundingBox();
      if (!topbarBox || !switchBox) throw new Error('.topbar or the switch is not measurable');
      const topbarCentre = topbarBox.x + topbarBox.width / 2;
      const switchCentre = switchBox.x + switchBox.width / 2;
      return Math.abs(switchCentre - topbarCentre);
    };

    const widths = [1024, 1152, 1280, 1440, 1920];

    // The default fixture session first — title "E2E session", project
    // "e2e-project", target "local": the short case.
    await page.getByTestId('session-row-item').filter({ hasText: 'E2E session' }).click();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      expect(await centreDelta()).toBeLessThanOrEqual(2);
    }

    // Then the long-title/long-project/long-target session — the exact
    // case D1-1's own trade sentence names: bolting the switch onto the
    // old `space-between` flex would drift the centre column here the
    // moment the left zone's content changed width relative to the right
    // zone's; the dedicated grid must not, because the two flanks are
    // forced to equal width regardless of what either one holds.
    await page.getByTestId('session-row-item').filter({ hasText: 'Migrate the relay' }).click();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      expect(await centreDelta()).toBeLessThanOrEqual(2);
    }

    // And centred while showing this session's own Tracker board too, not
    // just while showing Agent — the switch's own state must survive the
    // view it switches TO.
    await page.getByTestId('topbar-view-tracker').click();
    await expect(page.getByTestId('topbar-view-tracker')).toHaveAttribute('aria-checked', 'true');
    expect(await centreDelta()).toBeLessThanOrEqual(2);

    longNode.close();
  });

  test('below --bp-desktop the Agent/Tracker switch drops out of the topbar entirely, and the sidebar stays the route into Tracker (v8 D1-1 narrow-window answer, issue #710)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.getByTestId('session-row-item').first().click();
    await expect(page.getByTestId('topbar-view-switch')).toBeVisible();

    // The defined narrow-window answer: below --bp-desktop (1024px) the
    // switch drops out of the topbar rather than fight the truncating left
    // zone or the rigid right one for width — it doesn't need a full-width
    // bar of its own down here, because it is not this width's only route.
    // The sidebar already becomes primary navigation at this exact
    // breakpoint (`.tabbar`'s own media query), and its own
    // `destination-tracker` row (demoted, not deleted — see that row's own
    // doc comment) is already how every OTHER destination is reached here.
    await page.setViewportSize({ width: 1023, height: 900 });
    await expect(page.getByTestId('topbar-view-switch')).toBeHidden();

    await page.getByTestId('tabbar-sessions').click();
    await page.getByTestId('destination-tracker').click();
    await expect(page.getByTestId('tracker-page')).toBeVisible();

    // Back at --bp-desktop and above, the switch reappears and reflects
    // Tracker as current — reaching Tracker through the sidebar's fallback
    // route did not orphan the topbar switch's own state.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(page.getByTestId('topbar-view-switch')).toBeVisible();
    await expect(page.getByTestId('topbar-view-tracker')).toHaveAttribute('aria-checked', 'true');
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
    // The transcript is replaced, not overlaid: no right sidebar, no scrim.
    await expect(page.getByTestId('composer-input')).toHaveCount(0);
    await expect(page.getByTestId('right-sidebar')).toHaveCount(0);

    // Returning is one click, because the session stayed selected.
    await page.getByTestId('session-row-item').first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });

  test('the composer reads as a field, at rest and focused', async ({ page, loombox }) => {
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

    // Issue #577 / design spec §3.5, then A1-3 (issue #666, v7 §1): the
    // composer is a real field - a border, `--color-surface-raised`,
    // `--radius-md`, real padding, and (A1-3) a soft shadow so it reads as
    // the one deliberately raised surface in an otherwise flat app. The
    // chrome lives on `.composer-field`, not on `.composer-row` (that row
    // stays bare so the role gutter above still lines up with the
    // transcript's).
    const field = page.locator('.composer-field');
    const remPx = await page.evaluate(
      () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    );
    const radiusToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--radius-md').trim(),
    );
    const atRest = await field.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        borderWidth: style.borderTopWidth,
        borderRadius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        padding: style.paddingTop,
        outlineStyle: style.outlineStyle,
      };
    });
    expect(atRest.borderWidth).not.toBe('0px');
    // The token is a `rem` string, the computed style is resolved `px` at
    // whatever the root font-size actually is here - convert rather than
    // assume 16px/rem, the same way the gutter check below does.
    expect(parseFloat(atRest.borderRadius)).toBeCloseTo(parseFloat(radiusToken) * remPx, 1);
    expect(atRest.padding).not.toBe('0px');
    // Transparent would mean this box is drawn over the page's own surface
    // rather than sitting on its own raised one.
    expect(atRest.background).not.toBe('rgba(0, 0, 0, 0)');
    // `outline-width`'s computed value is browser-default `medium` (Chrome:
    // 3px) whether or not anything paints - only `outline-style` says
    // whether a ring is actually drawn. No ring while nothing inside the
    // field has focus.
    expect(atRest.outlineStyle).toBe('none');

    // A1-3 (issue #666, v7 §1): the hairline that used to sit above the
    // whole docked strip (plan, queued prompts, permissions, composer) is
    // gone - `.canvas-footer` draws no border of its own anymore. The
    // field's own border + shadow (asserted above) is the strip's only
    // boundary now, and it belongs to the field alone.
    const footerBorder = await page
      .locator('.canvas-footer')
      .evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(footerBorder).toBe('0px');
    const fieldShadow = await field.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(fieldShadow).not.toBe('none');

    // C2 (issue #577): at-rest and focused screenshots used to be
    // byte-identical (md5 match) because no `:focus-within` rule existed
    // anywhere in the file. Prove the fix the same way the audit proved the
    // bug: hash both states and show they now differ. `.focus()` reaches the
    // textarea the way Tab would, with no pointer involved - keyboard focus
    // being visible is the WCAG 2.4.7 contract this issue is about.
    const restShot = await field.screenshot();
    const restHash = createHash('md5').update(restShot).digest('hex');

    const focusRingWidth = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--focus-ring-width').trim(),
    );
    await input.focus();
    await expect(field).toHaveCSS('outline-style', 'solid');
    await expect(field).toHaveCSS('outline-width', focusRingWidth);
    const focusedOutlineColor = await field.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(focusedOutlineColor).not.toBe('rgba(0, 0, 0, 0)');

    const focusShot = await field.screenshot();
    const focusHash = createHash('md5').update(focusShot).digest('hex');
    expect(focusHash).not.toBe(restHash);

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
    expect(parseFloat(gutterWidth)).toBeCloseTo(parseFloat(token) * remPx, 1);
  });

  test('Settings is reachable from the account menu, not the sidebar or the mobile tabbar; Nodes has no destination row or tabbar item of its own (issue #568)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);

    // Coherence v5 §2: removed from both places the redesign closed —
    // the sidebar's primary destinations and the mobile tabbar (hidden by
    // a `@media` query, not conditionally rendered, so its absence here is
    // unconditional too). Issue #568 folded Nodes into Settings, so it
    // loses both spots too.
    await expect(page.getByTestId('destination-settings')).toHaveCount(0);
    await expect(page.getByTestId('tabbar-settings')).toHaveCount(0);
    await expect(page.getByTestId('destination-nodes')).toHaveCount(0);
    await expect(page.getByTestId('tabbar-targets')).toHaveCount(0);

    await page.getByTestId('account-menu-toggle').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
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

  test('"Add a target" lives on the Nodes section of Settings, not in the sidebar (issue #568)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    // It used to sit beside "New session" in a 288px column where both
    // wrapped onto two lines, then behind that button's split menu. It is a
    // once-per-machine setup step, so it belongs with the other ones.
    await expect(page.getByTestId('add-target-button')).toHaveCount(0);

    await page.getByTestId('account-menu-toggle').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByTestId('settings-nav-nodes').click();
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

  test('a session row spends a dot only on a status worth showing, and reserves its slot either way', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const row = page.getByTestId('session-row-item').first();
    const title = row.locator('strong');

    // Same rule as the header chip above. Every neutral tone — no status yet,
    // awaiting input, exited — used to draw an identical grey speck in the
    // row's leading indent, so the dot could not be read as meaning anything.
    await expect(row.getByTestId('ui-status-dot')).toHaveCount(0);
    const quiet = await title.boundingBox();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'session_status',
      status: 'working',
      updatedAt: new Date().toISOString(),
    });

    // `working` is one of the three tones that do mean something, so a dot
    // arrives — into a column that was already holding its width. A title that
    // jogged sideways the moment its session started working would be a worse
    // defect than the speck this replaced, and jsdom cannot see either.
    await expect(row.getByTestId('ui-status-dot')).toHaveCount(1);
    const working = await title.boundingBox();
    expect(working?.x).toBe(quiet?.x);
  });

  test('the transcript gutter and the composer gutter form one unbroken column, narrower now that nothing paints in either (v7 turn delimitation, issue #667)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-column',
      messageId: 'msg-column',
      text: 'One turn, so the transcript has a gutter to line up against.',
    });

    const turnGutter = page.getByTestId('message-item').first().locator('.gutter');
    const composerGutter = page.locator('.composer-gutter');
    await expect(turnGutter).toBeVisible();
    await expect(composerGutter).toBeVisible();

    // v6 replaced the role word with a glyph; v7 (issue #667, B2-4) drops
    // the glyph too — the column itself, not whatever happens to be
    // painted inside it, is what has to align, and now nothing paints
    // inside either gutter at all.
    const turnBox = await turnGutter.boundingBox();
    const composerBox = await composerGutter.boundingBox();
    const turnRight = (turnBox?.x ?? 0) + (turnBox?.width ?? 0);
    const composerRight = (composerBox?.x ?? 0) + (composerBox?.width ?? 0);
    expect(Math.abs(turnRight - composerRight)).toBeLessThan(1);

    // The shared `--gutter` token itself is narrower for v7 (tokens.css's
    // own comment records why 2.5rem, down from 4.75rem, is the new
    // floor) — read from the token rather than a hardcoded pixel value so
    // this stays a real regression guard, not a second copy of the number.
    const remPx = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const token = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--gutter').trim(),
    );
    expect(token).not.toBe('');
    expect(parseFloat(token) * remPx).toBeLessThan(4.75 * remPx);
    expect(turnBox?.width).toBeCloseTo(parseFloat(token) * remPx, 1);

    // No glyph anywhere (B2-4) — the gutter carries only the off-screen
    // label now.
    await expect(page.locator('[data-icon-name^="provider-"]')).toHaveCount(0);

    // ...and the role still reaches assistive tech, off-screen: a
    // visually-hidden label carries the real text, so sighted users never
    // see "CLAUDE" or "YOU" spelled out anywhere.
    const srLabel = page.getByTestId('message-item').first().locator('.sr-only');
    await expect(srLabel).toHaveText('Claude');
    // The standard clip-rect `.sr-only` technique keeps a 1x1px box in the
    // layout on purpose (so it stays reachable/focusable-adjacent for
    // assistive tech) rather than `display: none`, so Playwright's own
    // `toBeVisible()` — which only checks for a non-empty box — still calls
    // it visible. The real, meaningful check is that it paints nothing a
    // sighted user can perceive: a box clipped down to a single pixel.
    const srBox = await srLabel.boundingBox();
    expect(srBox?.width ?? 0).toBeLessThanOrEqual(1);
    expect(srBox?.height ?? 0).toBeLessThanOrEqual(1);

    // The composer's own gutter stays `aria-hidden` (its accessible name
    // lives on the textarea instead, same as before) and paints nothing.
    await expect(composerGutter).toHaveAttribute('aria-hidden', 'true');
    expect((await composerGutter.textContent())?.trim()).toBe('');
  });

  test("a screen reader still gets every turn's role even though the gutter no longer paints a caption-case word (issue #575)", async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-a11y',
      messageId: 'msg-a11y',
      text: 'Role reaches assistive tech through text, not paint.',
    });

    // `page.accessibility.snapshot()` no longer exists in this Playwright
    // version — `Locator.ariaSnapshot()` is its replacement, a YAML dump of
    // the accessibility tree rooted at the element, real text nodes and
    // all, so it still proves the role reaches assistive tech even though
    // nothing about it is visible on screen.
    const row = page.getByTestId('message-item').first();
    const snapshot = await row.ariaSnapshot();
    expect(snapshot).toContain('Claude');
  });

  test('consecutive turns from the same speaker no longer carry any grouping logic — B2-4 removed the glyph that logic existed to suppress, so every turn renders identically regardless of what precedes it (v7 turn delimitation, issue #667)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-1',
      text: 'First agent turn.',
    });
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-2',
      messageId: 'msg-2',
      text: 'Second agent turn, same speaker.',
    });

    const items = page.getByTestId('message-item');
    await expect(items).toHaveCount(2);

    // No glyph on either turn — there is nothing left for a "first of the
    // run" rule to keep or a "repeat" rule to drop.
    await expect(items.nth(0).locator('[data-icon-name^="provider-"]')).toHaveCount(0);
    await expect(items.nth(1).locator('[data-icon-name^="provider-"]')).toHaveCount(0);

    // The accessible label is never suppressed — every turn still
    // announces its role regardless of adjacency.
    await expect(items.nth(0).locator('.sr-only')).toHaveText('Claude');
    await expect(items.nth(1).locator('.sr-only')).toHaveText('Claude');

    // Each turn keeps its own bounded surface — consecutive same-speaker
    // turns are two rows, never merged into one block.
    await expect(items.nth(1)).toHaveClass(/agent/);

    // A user turn afterward gets its own tinted surface — the one signal
    // B1-2 amended left it (no glyph, no accent bar, ever).
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'user_message_chunk',
      turnId: 'turn-3',
      messageId: 'msg-3',
      text: 'A user turn.',
    });
    await expect(items).toHaveCount(3);
    await expect(items.nth(2)).toHaveClass(/user/);
    await expect(items.nth(2).locator('[data-icon-name^="provider-"]')).toHaveCount(0);
    await expect(items.nth(2).locator('.sr-only')).toHaveText('You');
  });

  test('switching Files to Config keeps the right sidebar open at the same width and does not remount the other panel (design spec §3.3, issue #571)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const toggle = page.getByTestId('workbench-toggle');
    const files = page.getByTestId('file-tree-toggle');
    const config = page.getByTestId('project-config-toggle');
    const sidebar = page.getByTestId('right-sidebar');

    // Open by default (design spec §3.3): a session is selected at this
    // suite's default 1280x720 (>=`--bp-wide`) viewport.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(files).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('file-tree-panel-wrapper')).toBeVisible();

    const widthBefore = (await sidebar.boundingBox())?.width;

    // The sub-tabs are a `radiogroup`, not the old three-way `aria-pressed`
    // toggle strip: switching Files -> Config changes WHICH is checked, it
    // does not close and reopen the panel the way the old toggle group did.
    // These sub-tabs living inside the right sidebar's own header, not the
    // topbar, used to be incidental to issue #571 — it could have changed
    // the moment #710 landed. It didn't: v8 C1-3 (issue #710) picked the
    // option that keeps the Files/Config/Runner group here permanently, so
    // this assertion is no longer contingent on a still-open decision.
    await config.click();
    await expect(config).toHaveAttribute('aria-checked', 'true');
    await expect(files).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('project-config-panel-wrapper')).toBeVisible();

    // Not remounted: still in the DOM, merely hidden — `toHaveCount(1)`
    // proves it never left, `not.toBeVisible()` proves the native `hidden`
    // attribute (not a `{#if}`) is what's covering it.
    const filesPanel = page.getByTestId('file-tree-panel-wrapper');
    await expect(filesPanel).toHaveCount(1);
    await expect(filesPanel).not.toBeVisible();

    const widthAfter = (await sidebar.boundingBox())?.width;
    expect(widthAfter).toBe(widthBefore);

    // The topbar's one control closes the whole panel, independent of
    // which sub-tab was active — this is a docked column here (this
    // suite's default viewport is >=`--bp-desktop`), so there is no
    // backdrop to click through; see the narrow-viewport sheet test above
    // for that guard, which is where it moved from.
    await toggle.click();
    await expect(sidebar).toHaveCount(0);
    await toggle.click();
    await expect(sidebar).toBeVisible();
  });

  test('the topbar controls show their words where there is room and keep their names where there is not — except Workbench, which never gets one back (v8 C1-3, issue #710)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const workbench = page.getByTestId('workbench-toggle');
    const terminalWord = page.getByTestId('terminal-dock-toggle').locator('.panel-word');
    const paletteWord = page.getByTestId('command-palette-toggle').locator('.panel-word');

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(terminalWord).toBeVisible();
    await expect(paletteWord).toBeVisible();
    // Workbench carries no `.panel-word` at all anymore (v8 C1-3, issue
    // #710) — not hidden by the same width rule Terminal/Jump to… still
    // follow, gone from the markup outright, even at the widest viewport
    // this suite ever runs.
    await expect(workbench.locator('.panel-word')).toHaveCount(0);

    // Below `--bp-wide` the words go, and this is the half that matters: the
    // five glyphs this replaced had no word ANYWHERE, only a `title` a pointer
    // had to hover for. The accessible name is a prop on the button, not the
    // hidden span, so it survives the pixels going.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(terminalWord).toBeHidden();
    await expect(paletteWord).toBeHidden();
    await expect(page.getByRole('button', { name: 'Workbench' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Jump to/ })).toBeVisible();
  });

  test('every timeline row shares one text column, the composer included', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await seedTurnWithToolCall(loombox);
    await page.setViewportSize({ width: 1440, height: 900 });

    const prose = page.getByTestId('message-text').first();
    const toolCard = page.getByTestId('tool-card').first();
    const field = page.locator('.composer-field');
    await expect(prose).toBeVisible();
    await expect(toolCard).toBeVisible();

    const proseBox = await prose.boundingBox();
    const toolBox = await toolCard.boundingBox();
    const fieldBox = await field.boundingBox();

    // The test above measures the role WORDS' right edges, which lined up
    // while the column they define did not: `.composer-row` carried a
    // `gap: var(--space-sm)` on top of the same 4.75rem gutter, so the field
    // began 7.6px right of the prose (measured 493.8 against 486.2 at 1440px).
    // A word is not the column; the text is.
    //
    // Measured against `.composer-field` itself (issue #577), not the
    // textarea inside it: the field is a bordered, padded box now, so its
    // own typed TEXT sits inset from the field's edge the same way any real
    // input's does - the FIELD's left edge is the column, same as it was
    // when field and textarea were the same box.
    expect(Math.abs((proseBox?.x ?? 0) - (toolBox?.x ?? 0))).toBeLessThan(1);
    expect(Math.abs((proseBox?.x ?? 0) - (fieldBox?.x ?? 0))).toBeLessThan(1);
  });

  test('on a phone the gutter column collapses and every row keeps one left edge (v7 turn delimitation, issue #667)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await seedTurnWithToolCall(loombox);
    await page.setViewportSize({ width: 390, height: 780 });

    const gutter = page.getByTestId('message-item').first().locator('.gutter');
    const prose = page.getByTestId('message-text').first();
    const toolCard = page.getByTestId('tool-card').first();
    // `.composer-field`, not the textarea inside it - see the desktop
    // version of this check (issue #577): the field's own edge is the
    // column now that it is a bordered, padded box.
    const field = page.locator('.composer-field');
    await expect(gutter).toBeVisible();

    const gutterBox = await gutter.boundingBox();
    const proseBox = await prose.boundingBox();
    const toolBox = await toolCard.boundingBox();
    const fieldBox = await field.boundingBox();

    // Above the turn, not beside it: the column collapses to a stacked
    // block regardless of what it holds — nothing sighted anymore (v7),
    // but the geometry is unchanged from when it held an 84px word/glyph.
    expect((gutterBox?.y ?? 0) + (gutterBox?.height ?? 0)).toBeLessThanOrEqual(
      (proseBox?.y ?? 0) + 1,
    );
    expect(Math.abs((gutterBox?.x ?? 0) - (proseBox?.x ?? 0))).toBeLessThan(1);

    // What the collapse is FOR. 244px before, 316px measured after.
    expect(proseBox?.width ?? 0).toBeGreaterThan(300);

    // Every other surface sharing that column has to move at the same
    // breakpoint, or the timeline's one rule becomes several that nearly line
    // up — which is the defect the column was introduced to fix.
    expect(Math.abs((toolBox?.x ?? 0) - (proseBox?.x ?? 0))).toBeLessThan(1);
    expect(Math.abs((fieldBox?.x ?? 0) - (proseBox?.x ?? 0))).toBeLessThan(1);
  });

  test('the gutter column is still beside the turn one breakpoint up, flush against the content with nothing painted to hold a gap open (v7 turn delimitation, issue #667)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await seedTurnWithToolCall(loombox);
    await page.setViewportSize({ width: 768, height: 900 });

    const gutter = page.getByTestId('message-item').first().locator('.gutter');
    const prose = page.getByTestId('message-text').first();
    await expect(gutter).toBeVisible();
    const gutterBox = await gutter.boundingBox();
    const proseBox = await prose.boundingBox();
    const gutterPaddingTop = await gutter.evaluate((el) =>
      parseFloat(getComputedStyle(el).paddingTop),
    );

    // The collapse is a phone rule (`--bp-mobile`), not a "narrow" one: a
    // tablet has room for the column and keeps it, so the media query must not
    // leak upward.
    //
    // `toBeLessThanOrEqual`, not strictly less: v7 dropped the glyph that
    // used to sit inset inside the gutter (its own `--space-sm` padding
    // held a visible gap open before the prose). With nothing painted
    // there anymore, the gutter's own box runs flush to content's left
    // edge — still never overlapping it, which is the actual contract.
    expect((gutterBox?.x ?? 0) + (gutterBox?.width ?? 0)).toBeLessThanOrEqual(
      (proseBox?.x ?? 0) + 1,
    );
    // The two boxes' TOP edges no longer land at the same y: `.content`'s
    // own `--space-sm` padding-top offsets the prose from the row's top,
    // and `.gutter`'s matching padding-top (the same token, kept for
    // parity with sibling gutters that still hold content — see that
    // rule's own comment) offsets an equal amount from ITS box's top. Add
    // it back before comparing, so this still proves the two columns
    // start their content at the same baseline, not just that raw
    // boundingBox() coordinates happen to differ by a padding value.
    expect(Math.abs((gutterBox?.y ?? 0) + gutterPaddingTop - (proseBox?.y ?? 0))).toBeLessThan(4);
  });

  test('at 1440px opening the right sidebar reflows the canvas and dims nothing (design spec §3.1/§0.6, issue #571)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    // Workbench opens/closes a right-sidebar PANEL rather than switching
    // among topbar tabs — until v8 C1-3 (issue #710) that was one of three
    // still-open options (C1-1/C1-2 would have promoted the Files/Config/
    // Runner group into the topbar itself), so this test's whole premise
    // was incidentally, not permanently, correct. C1-3 settled it: this
    // panel/toggle shape is the permanent architecture now.
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = page.locator('.canvas');
    const toggle = page.getByTestId('workbench-toggle');
    const sidebar = page.getByTestId('right-sidebar');

    // Open by default at this width with a session selected (design spec
    // §3.3) — close it first so "opening" below is a real before/after.
    await expect(sidebar).toBeVisible();
    await toggle.click();
    await expect(sidebar).toHaveCount(0);

    const bgBefore = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);
    const canvasBoxBefore = await canvas.boundingBox();
    const screenshotBefore = await page.screenshot();

    await toggle.click();
    await expect(sidebar).toBeVisible();

    // The audit's own method (design spec P2 finding: measured `(199,206,217)
    // -> (123,129,138)` on the old Drawer, identical to a modal's scrim) —
    // the SAME element's background colour, read the same way, before and
    // after. Unchanged is the proof there is no scrim at this width.
    const bgAfter = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bgAfter).toBe(bgBefore);

    // Reflowed (pushed narrower), not covered: the canvas's own box shrinks
    // by roughly the sidebar's width, rather than the sidebar painting on
    // top of an unchanged canvas box.
    const canvasBoxAfter = await canvas.boundingBox();
    const sidebarWidth = (await sidebar.boundingBox())?.width ?? 0;
    const widthDelta = (canvasBoxBefore?.width ?? 0) - (canvasBoxAfter?.width ?? 0);
    expect(widthDelta).toBeGreaterThan(sidebarWidth - 10);
    expect(widthDelta).toBeLessThan(sidebarWidth + 10);

    // Nothing clipped: the composer stays fully visible and interactive
    // underneath, and a real screenshot pair shows an actual visual change
    // (the reflow), not two identical frames.
    await expect(page.getByTestId('composer-input')).toBeVisible();
    const screenshotAfter = await page.screenshot();
    expect(screenshotBefore.equals(screenshotAfter)).toBe(false);
  });

  test('right sidebar width and open state survive a reload and a viewport crossing of --bp-wide (design spec §3.3, issue #571)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    // Same permanence note as the reflow test above (v8 C1-3, issue #710):
    // this panel surviving reload/viewport changes is only meaningful
    // long-term because C1-3 keeps Workbench a right-sidebar panel toggle
    // rather than a topbar tab group that would have made this whole test
    // obsolete.
    await page.setViewportSize({ width: 1440, height: 900 });
    const sidebar = page.getByTestId('right-sidebar');
    const handle = page.getByTestId('right-sidebar-resize-handle');
    await expect(sidebar).toBeVisible();

    // Drag the handle to a real, distinguishable width — a size-only
    // interaction, which must NOT by itself flip whether `open` is a real
    // user preference (see `RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY`'s
    // own doc comment for the exact bug this guards).
    const handleBox = await handle.boundingBox();
    expect(handleBox).toBeTruthy();
    const startX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
    const startY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 60, startY);
    await page.mouse.up();

    const widthAfterDrag = (await sidebar.boundingBox())?.width;
    expect(widthAfterDrag).toBeDefined();

    await page.reload();
    await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
    // Still open after reload: the drag alone never touched
    // `workbenchToggle`, so this proves the size-only interaction did not
    // accidentally freeze the panel shut either.
    await expect(sidebar).toBeVisible();
    const widthAfterReload = (await sidebar.boundingBox())?.width;
    expect(Math.abs((widthAfterReload ?? 0) - (widthAfterDrag ?? 0))).toBeLessThan(2);

    // Explicitly open it (a real user choice) before crossing `--bp-wide`
    // down into the sheet range and back, so the sticky width is being
    // tested against a genuine preference, not just the dynamic default.
    await page.getByTestId('workbench-toggle').click();
    await expect(sidebar).toHaveCount(0);
    await page.getByTestId('workbench-toggle').click();
    await expect(sidebar).toBeVisible();

    // `.last()`: crossing into sheet mode and back mounts a new
    // `<aside data-testid="right-sidebar">` while the previous one is still
    // playing its `out:rightSidebarSlide` transition (marked `inert`
    // meanwhile) — both briefly coexist, and the freshly-mounted one is
    // the one this assertion means.
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(sidebar.last()).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(sidebar.last()).toBeVisible();
    // Polled rather than a single-shot `boundingBox()` read: the freshly
    // mounted docked `<aside>` (see `.last()`'s own comment above) needs a
    // layout pass to actually reflect its inline `width` style, and a bare
    // read landed on this box has caught it mid-reflow before now.
    await expect
      .poll(async () => (await sidebar.last().boundingBox())?.width)
      .toBeGreaterThan((widthAfterDrag ?? 0) - 2);
    const widthAfterCrossing = (await sidebar.last().boundingBox())?.width;
    expect(Math.abs((widthAfterCrossing ?? 0) - (widthAfterDrag ?? 0))).toBeLessThan(2);
  });

  test('at 1279/1280/1281px the right sidebar is a docked, backdrop-free column with no dead pin control (issue #573)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const sidebar = page.getByTestId('right-sidebar');
    const toggle = page.getByTestId('workbench-toggle');

    // #573's own reproduction: the pin control used to be visible and
    // inert at exactly 1280px, because `viewport.ts`'s `(max-width:
    // 1280px)` and `+page.svelte`'s `(min-width: 1280px)` were both true
    // there. There is no pin control offered at all anymore — the sidebar's
    // docked-vs-sheet boundary (`--bp-desktop`, 1024px) doesn't even share
    // this number — so it stays a docked, backdrop-free column at all
    // three widths the bug lived at.
    //
    // Establishes a REAL (sticky) preference before touching the viewport
    // at all, regardless of whatever the dynamic default currently shows —
    // that default is `matchMedia`-driven and settles asynchronously after
    // `setViewportSize`, so re-deriving "is it open" from a synchronous
    // `.count()` inside the loop below raced it. `toggleRightSidebar` sets
    // the sticky flag on EITHER direction, so closing it first (only if the
    // dynamic default already opened it) then reopening reaches the same
    // "open and sticky" state as a browser that started closed and got one
    // click, either way with a real click in the log rather than an
    // inferred one. The boundary's OWN open-by-default behaviour is
    // covered on its own, isolated terms by the next test.
    if ((await sidebar.count()) > 0) {
      await toggle.click();
      await expect(sidebar).toHaveCount(0);
    }
    await toggle.click();
    await expect(sidebar).toBeVisible();

    for (const width of [1279, 1280, 1281]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(sidebar).toBeVisible();
      await expect(page.getByTestId('drawer-pin-toggle')).toHaveCount(0);
      await expect(page.getByTestId('right-sidebar-backdrop')).toHaveCount(0);
    }
  });

  test('open-by-default flips cleanly at exactly --bp-wide (1280px), with no dead zone on either side (issue #573)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const sidebar = page.getByTestId('right-sidebar');

    // A genuinely fresh preference throughout (no click anywhere in this
    // test) — `rightSidebarOpen` tracks the viewport/session pair live, so
    // this is the exact `matchMedia` boundary `viewport.ts`'s `exclusive`
    // option now owns, isolated from the docked/pin test above.
    await page.setViewportSize({ width: 1279, height: 900 });
    await expect(sidebar).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(sidebar).toBeVisible();
    await page.setViewportSize({ width: 1281, height: 900 });
    await expect(sidebar).toBeVisible();
    await page.setViewportSize({ width: 1279, height: 900 });
    await expect(sidebar).toHaveCount(0);
  });

  test('at 1440px the terminal dock opens alongside the transcript, composer and right sidebar, dimming nothing (design spec §3.1/§0.6, issue #572)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = page.locator('.canvas');
    const toggle = page.getByTestId('terminal-dock-toggle');
    const dock = page.getByTestId('terminal-dock');
    const sidebar = page.getByTestId('right-sidebar');

    // The right sidebar opens by default at this width with a session
    // selected (design spec §3.3); the terminal never does (design spec
    // decision #4, closed by default) — asserted first, since everything
    // below only proves something if this dock really started shut.
    await expect(sidebar).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Mounted but hidden, not absent (issue #572's own "collapsing must
    // not drop the PTY" design: the dock wrapper stays in the DOM once a
    // session exists so a LATER open/close round trip never remounts
    // `InteractiveTerminal` — see `.terminal-dock`'s own doc comment in
    // `+page.svelte`). Closed-by-default is a visibility fact here, not a
    // DOM-presence one.
    await expect(dock).not.toBeVisible();

    const bgBefore = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);
    const screenshotBefore = await page.screenshot();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(dock).toBeVisible();

    // The audit's own method (design spec P2 finding, reused above by the
    // right sidebar's identical test): the SAME element's background
    // colour, read the same way, before and after. Unchanged is the proof
    // there is no scrim — design spec §0.6 "a workbench panel never dims
    // the app", now proven for a THIRD panel open at once, not just one.
    const bgAfter = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bgAfter).toBe(bgBefore);

    // Never scrims at this width, unlike the mobile bottom sheet further
    // down: no backdrop element exists at all here.
    await expect(page.getByTestId('terminal-dock-backdrop')).toHaveCount(0);

    // All four zones visible and interactive at once — the acceptance
    // line itself.
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByTestId('transcript-items')).toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId('interactive-terminal')).toBeVisible();

    // A real visual change (the dock now painted at the bottom of the
    // window), not two identical frames.
    const screenshotAfter = await page.screenshot();
    expect(screenshotBefore.equals(screenshotAfter)).toBe(false);
  });

  test('the terminal dock is one frame, not two: the word "Terminal" appears once, no hairline, a distinct surface from the canvas, and the resize edge still works from the keyboard (design spec §4 D1-2/D2-2, issue #669)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = page.locator('.canvas');
    const toggle = page.getByTestId('terminal-dock-toggle');
    const dock = page.getByTestId('terminal-dock');
    const handle = page.getByTestId('terminal-dock-resize-handle');

    await toggle.click();
    await expect(dock).toBeVisible();

    // One frame, not two (D1-2's own acceptance line): the terminal used
    // to draw its own titlebar saying "Terminal" inside a dock that
    // already says it via this toggle. Scoped to the dock + toggle region
    // (not the whole page — "Terminal" legitimately appears elsewhere,
    // e.g. a `tool-bash` call's label) so this only proves the ONE place
    // this issue is about. Joined with a space, not bare concatenation —
    // otherwise the toggle's own trailing "Terminal" glues onto the
    // dock's leading text with no word boundary between them, hiding a
    // real second occurrence from `\bTerminal\b` just as easily as it
    // would hide a real ABSENCE of one.
    const dockRegionText = `${await toggle.innerText()} ${await dock.innerText()}`;
    const terminalOccurrences = dockRegionText.match(/\bTerminal\b/g) ?? [];
    expect(terminalOccurrences).toHaveLength(1);

    // The one thin bar replacing the old card+titlebar — carries status,
    // not a redundant "Terminal" label of its own.
    await expect(page.getByTestId('terminal-bar')).toBeVisible();
    await expect(page.getByTestId('terminal-bar-status')).toBeVisible();

    // D2-2: no hairline between the canvas and the dock, and the dock
    // reads as a genuinely different surface (`--color-rail`, one shade
    // off the canvas's own `--color-bg`), not just a missing border on an
    // otherwise-identical background.
    const dockStyle = await dock.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { borderTopWidth: computed.borderTopWidth, background: computed.backgroundColor };
    });
    expect(dockStyle.borderTopWidth).toBe('0px');
    const canvasBackground = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dockStyle.background).not.toBe(canvasBackground);

    // With no hairline, the resize handle is the only proof this edge is
    // resizable — it must still be genuinely discoverable on hover (a
    // real, visible style change, not just an invisible bigger hit area)
    // and still actually resize the dock, both with a mouse (covered by
    // the drag test above) and from the keyboard.
    const backgroundBeforeHover = await handle.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await handle.hover();
    await expect(async () => {
      const backgroundOnHover = await handle.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(backgroundOnHover).not.toBe(backgroundBeforeHover);
    }).toPass({ timeout: 2_000 });

    const heightBefore = (await dock.boundingBox())?.height ?? 0;
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect(async () => {
      const heightAfter = (await dock.boundingBox())?.height ?? 0;
      expect(heightAfter).toBeGreaterThan(heightBefore);
    }).toPass({ timeout: 2_000 });
  });

  test("dragging the terminal dock's top edge resizes it and xterm reflows to real cols/rows, not just the CSS height (issue #572)", async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('terminal-dock-toggle').click();

    const dock = page.getByTestId('terminal-dock');
    const terminal = page.getByTestId('interactive-terminal');
    const handle = page.getByTestId('terminal-dock-resize-handle');
    await expect(dock).toBeVisible();
    await expect(terminal).toBeVisible();

    // The initial fit (`InteractiveTerminal.svelte`'s own top doc comment,
    // issue #572): xterm reports real cols/rows from the FIRST paint, not
    // the 80x24 fallback the component seeds itself with before any real
    // layout exists.
    const colsBefore = await terminal.evaluate((el) => Number(el.getAttribute('data-cols')));
    const rowsBefore = await terminal.evaluate((el) => Number(el.getAttribute('data-rows')));
    expect(colsBefore).toBeGreaterThan(0);
    expect(rowsBefore).toBeGreaterThan(0);
    const heightBefore = (await dock.boundingBox())?.height ?? 0;

    const handleBox = await handle.boundingBox();
    expect(handleBox).toBeTruthy();
    const startX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
    const startY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // A CONTINUOUS drag (several intermediate moves, not one jump) — the
    // coalescing `InteractiveTerminal.svelte`'s own doc comment documents
    // (a `ResizeObserver` notification per render frame, not per
    // `pointermove`) is what this exercises: many pointermoves during the
    // drag, one real resize outcome once it settles.
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(startX, startY - step * 10);
    }
    await page.mouse.up();

    const heightAfter = (await dock.boundingBox())?.height ?? 0;
    expect(heightAfter).toBeGreaterThan(heightBefore + 40);

    // The real effect of the resize, not just the CSS box (issue #572's
    // own acceptance line: "xterm reflows to the new rows/cols").
    await expect(async () => {
      const rowsAfter = await terminal.evaluate((el) => Number(el.getAttribute('data-rows')));
      expect(rowsAfter).toBeGreaterThan(rowsBefore);
    }).toPass({ timeout: 5_000 });

    // A vertical-only drag: the dock's width never moved, so cols
    // shouldn't either — proving this read the terminal's REAL layout
    // rather than one attribute both dimensions happen to bump together.
    const colsAfter = await terminal.evaluate((el) => Number(el.getAttribute('data-cols')));
    expect(colsAfter).toBe(colsBefore);
  });

  test('collapsing and reopening the terminal dock keeps the same terminal: no repeated terminal_open, no terminal_close (issue #572)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 1440, height: 900 });
    const toggle = page.getByTestId('terminal-dock-toggle');
    const dock = page.getByTestId('terminal-dock');

    await toggle.click();
    await expect(dock).toBeVisible();

    // The node side of the protocol sees exactly one `terminal_open` for
    // the whole test. `FakeNode` never answers it — this harness has no
    // terminal-protocol support of its own — which is fine: what this
    // test proves is `InteractiveTerminal`'s own mount/PTY lifecycle
    // (never re-triggered by a collapse/reopen), not a real shell round
    // trip end to end.
    await loombox.node.waitFor((message) => message.type === 'terminal_open');
    expect(loombox.node.messages.filter((message) => message.type === 'terminal_open').length).toBe(
      1,
    );

    // A stable DOM node identity is the real proof `InteractiveTerminal`
    // was never unmounted+remounted — Playwright locators re-query on
    // every call, an in-page reference does not.
    await page.evaluate(() => {
      (window as unknown as { __terminalNode: Element | null }).__terminalNode =
        document.querySelector('[data-testid="interactive-terminal"]');
    });

    // Collapse, then reopen — today, before this dock, this exact round
    // trip unmounted `InteractiveTerminal` and its own `onDestroy` closed
    // the terminal outright (`.terminal-dock`'s own doc comment in
    // `+page.svelte`).
    await toggle.click();
    await expect(dock).not.toBeVisible();
    await toggle.click();
    await expect(dock).toBeVisible();

    const sameNode = await page.evaluate(
      () =>
        document.querySelector('[data-testid="interactive-terminal"]') ===
        (window as unknown as { __terminalNode: Element | null }).__terminalNode,
    );
    expect(sameNode).toBe(true);
    expect(loombox.node.messages.filter((message) => message.type === 'terminal_open').length).toBe(
      1,
    );
    expect(
      loombox.node.messages.filter((message) => message.type === 'terminal_close').length,
    ).toBe(0);
  });

  test('terminal dock height and open state survive a reload (issue #572)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 1440, height: 900 });
    const toggle = page.getByTestId('terminal-dock-toggle');
    const dock = page.getByTestId('terminal-dock');
    const handle = page.getByTestId('terminal-dock-resize-handle');

    await toggle.click();
    await expect(dock).toBeVisible();

    const handleBox = await handle.boundingBox();
    expect(handleBox).toBeTruthy();
    const startX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
    const startY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY - 60);
    await page.mouse.up();
    // A settle wait, not a bare read: `DockPanel.persist()` writes to
    // `localStorage` off the same `pointermove` handler that drives the
    // visible height, but this file's own e2e run showed a rare race
    // between that last write actually landing and the very next command
    // reading `boundingBox()` — flaky only under this box's shared load,
    // never a logic bug (the drag itself, and reflow, are both proven
    // deterministically by the dedicated drag spec above).
    await page.waitForTimeout(300);

    const heightAfterDrag = (await dock.boundingBox())?.height;
    expect(heightAfterDrag).toBeDefined();

    await page.reload();
    await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });

    // Closed by default (design spec decision #4) means "still open" after
    // a reload is the real proof of persistence here — this dock has no
    // dynamic default to rule out the way the right sidebar's own reload
    // test above does.
    await expect(page.getByTestId('terminal-dock-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(dock).toBeVisible();
    const heightAfterReload = (await dock.boundingBox())?.height;
    expect(Math.abs((heightAfterReload ?? 0) - (heightAfterDrag ?? 0))).toBeLessThan(2);
  });

  test('at 390px the terminal is a bottom sheet, follows the one-panel-at-a-time rule, and the sessions/right-sidebar sheets are not regressed (design spec §3.3, issue #572)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.setViewportSize({ width: 390, height: 844 });

    const sessionsToggle = page.getByTestId('tabbar-sessions');
    const workbenchToggle = page.getByTestId('workbench-toggle');
    const terminalToggle = page.getByTestId('terminal-dock-toggle');
    const sessionsColumn = page.getByTestId('sessions-column');
    const rightSidebar = page.getByTestId('right-sidebar');
    const dock = page.getByTestId('terminal-dock');

    // A genuine bottom sheet: fixed, full-width, with the same manually-
    // conditioned backdrop the sessions sidebar's own mobile sheet uses —
    // issue #572's own "reconcile it with the existing mobile sheet": the
    // SAME mechanism, not a second one (see `.terminal-dock`'s own CSS doc
    // comment in `+page.svelte`).
    await terminalToggle.click();
    await expect(dock).toBeVisible();
    await expect(page.getByTestId('terminal-dock-backdrop')).toBeVisible();
    const dockBox = await dock.boundingBox();
    expect(dockBox?.width).toBeGreaterThan(370);

    // One panel at a time below `--bp-desktop` (design spec §3.3):
    // opening the sessions sheet closes the terminal right back.
    //
    // Not `not.toBeVisible()`: Playwright's visibility check only looks at
    // `display`/`visibility`/box size, never actual viewport position, so
    // a `transform`-translated-off-screen element with a real nonzero box
    // (this dock's own mobile-sheet CSS, `height: min(60vh, 32rem)`
    // regardless of open state) still reads as "visible" to it. The class
    // removal (`terminalDock.open`'s own real signal) plus a bounding-box
    // check that the box's top has actually left the viewport are the
    // real proof.
    await sessionsToggle.click();
    await expect(sessionsColumn).toHaveClass(/sheet-open/);
    await expect(dock).not.toHaveClass(/terminal-dock-open/);
    await expect(async () => {
      const box = await dock.boundingBox();
      expect(box?.y ?? 0).toBeGreaterThanOrEqual(844);
    }).toPass({ timeout: 5_000 });
    await expect(page.getByTestId('terminal-dock-backdrop')).toHaveCount(0);

    // The sessions sheet is a FULL-SCREEN sheet at this width (`top: 0` to
    // `bottom: --tabbar-height`, `.sidebar`'s own CSS) that covers the
    // ENTIRE topbar while open — pre-existing sessions-sidebar behaviour,
    // nothing this dock introduced — so the terminal's own topbar toggle
    // is unreachable by a real tap until the sessions sheet is dismissed
    // through ITS OWN control first (the same tabbar button that opened
    // it, already proven reachable above — `--z-overlay` sits above the
    // sheet for exactly this "the control that opened it can also close
    // it" reason).
    await sessionsToggle.click();
    await expect(sessionsColumn).not.toHaveClass(/sheet-open/);

    // Reachable again, and reopens cleanly.
    await terminalToggle.click();
    await expect(dock).toHaveClass(/terminal-dock-open/);

    // The right sidebar's own EXISTING mobile sheet is not regressed by
    // any of this — and unlike the sessions sheet, it does NOT cover the
    // topbar at this width (`top: auto; height: 60vh`, sitting in the
    // bottom half only, `.right-sidebar`'s own `@media (max-width: 767px)`
    // rule), so its toggle stays reachable with the terminal open: opening
    // it closes the terminal, the same one-at-a-time rule, proven with a
    // genuinely reachable click this time.
    await workbenchToggle.click();
    await expect(rightSidebar).toBeVisible();
    await expect(page.getByTestId('right-sidebar-backdrop')).toBeVisible();
    await expect(dock).not.toHaveClass(/terminal-dock-open/);
    await expect(async () => {
      const box = await dock.boundingBox();
      expect(box?.y ?? 0).toBeGreaterThanOrEqual(844);
    }).toPass({ timeout: 5_000 });

    // And the reverse, which IS reachable here (the terminal toggle was
    // never covered by the right sidebar's own bottom-half sheet):
    // opening the terminal again dismisses the right sidebar sheet right
    // back, proving the exclusivity is genuinely bidirectional wherever
    // the UI lets two controls compete for the same tap.
    await terminalToggle.click();
    await expect(dock).toHaveClass(/terminal-dock-open/);
    await expect(rightSidebar).toHaveCount(0);
  });
});
