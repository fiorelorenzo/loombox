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

    // The sub-tabs are a real `radiogroup` (exactly Files and Config),
    // not the old duplicate `aria-pressed` strip this panel's own header
    // comment used to warn against re-adding.
    const tabs = page.getByRole('radiogroup', { name: 'Workbench panel' });
    await expect(tabs.getByRole('radio')).toHaveCount(2);
    await expect(page.getByTestId('file-tree-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('file-tree-panel-wrapper')).toBeVisible();
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

    // Issue #577 / design spec §3.5: the composer is a real field now - a
    // border, `--color-surface-raised`, `--radius-md` and real padding, the
    // same vocabulary `ui/TextArea` gives the inbox reply box and the New
    // Session dialog fields. The chrome lives on `.composer-field`, not on
    // `.composer-row` (that row stays bare so the role gutter above still
    // lines up with the transcript's).
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

    // What separates the composer from the transcript above it is still one
    // hairline across the whole docked strip (plan, queued prompts,
    // permissions, composer), drawn once on the footer rather than per
    // element - otherwise each of those reads as a stray transcript item
    // that fell to the bottom.
    const footerBorder = await page
      .locator('.canvas-footer')
      .evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(footerBorder).not.toBe('0px');

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

  test('the transcript gutter and the composer gutter form one unbroken column, with no caption-case role word in either (issue #575)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-column',
      messageId: 'msg-column',
      text: 'One turn, so the transcript has a role glyph to line up against.',
    });

    const turnGutter = page.getByTestId('message-item').first().locator('.gutter');
    const composerGutter = page.locator('.composer-gutter');
    await expect(turnGutter).toBeVisible();
    await expect(composerGutter).toBeVisible();

    // The old test compared the role WORDS' right edges, which lined up
    // while the column defining them did not (the bug this test used to
    // catch: `align-items: center` on the composer against `flex-end` on
    // the transcript). Design spec v6 §3.4 replaced the word with a glyph
    // (or nothing at all, for a user/composer row), so the column itself —
    // not whatever happens to be painted inside it — is what has to align
    // now: the gutter IS the alignment device.
    const turnBox = await turnGutter.boundingBox();
    const composerBox = await composerGutter.boundingBox();
    const turnRight = (turnBox?.x ?? 0) + (turnBox?.width ?? 0);
    const composerRight = (composerBox?.x ?? 0) + (composerBox?.width ?? 0);
    expect(Math.abs(turnRight - composerRight)).toBeLessThan(1);

    // Attribution by glyph, not by a caption-case word: the agent turn
    // carries a decorative provider glyph...
    const glyph = page.getByTestId('message-item').first().locator('.role-glyph');
    await expect(glyph).toBeVisible();
    await expect(glyph).toHaveAttribute('aria-hidden', 'true');

    // ...and the role still reaches assistive tech, just off-screen rather
    // than painted: a visually-hidden label carries the real text, so
    // sighted users never see "CLAUDE" or "YOU" spelled out anywhere.
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

  test('consecutive turns from the same speaker do not repeat the attribution glyph, but each keeps its own surface (issue #575)', async ({
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

    // First of the run keeps the glyph; the immediate repeat drops it.
    await expect(items.nth(0).locator('.role-glyph')).toBeVisible();
    await expect(items.nth(1).locator('.role-glyph')).toHaveCount(0);

    // The accessible label is never suppressed — every turn still
    // announces its role even when the glyph doesn't repeat.
    await expect(items.nth(1).locator('.sr-only')).toHaveText('Claude');

    // Each turn keeps its own bounded surface regardless of grouping —
    // suppressing the glyph groups the run visually, it never merges the
    // two turns into one block.
    await expect(items.nth(1)).toHaveClass(/agent/);

    // A user turn afterward breaks the run and gets its own attribution
    // back (the user role never draws a glyph in the first place — its
    // accent bar and raised surface already carry it).
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'user_message_chunk',
      turnId: 'turn-3',
      messageId: 'msg-3',
      text: 'A user turn.',
    });
    await expect(items).toHaveCount(3);
    await expect(items.nth(2)).toHaveClass(/user/);
    await expect(items.nth(2).locator('.role-glyph')).toHaveCount(0);
    await expect(items.nth(2).locator('.sr-only')).toHaveText('You');

    // And a fourth agent turn right after the user one gets its glyph back
    // too — the run only resets, it never stays suppressed forever.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-4',
      messageId: 'msg-4',
      text: 'Third agent turn, after a user turn broke the run.',
    });
    await expect(items).toHaveCount(4);
    await expect(items.nth(3).locator('.role-glyph')).toBeVisible();
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

  test('the topbar controls show their words where there is room and keep their names where there is not', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const workbenchWord = page.getByTestId('workbench-toggle').locator('.panel-word');
    const paletteWord = page.getByTestId('command-palette-toggle').locator('.panel-word');

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(workbenchWord).toBeVisible();
    await expect(paletteWord).toBeVisible();

    // Below `--bp-wide` the words go, and this is the half that matters: the
    // five glyphs this replaced had no word ANYWHERE, only a `title` a pointer
    // had to hover for. The accessible name is a prop on the button, not the
    // hidden span, so it survives the pixels going.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(workbenchWord).toBeHidden();
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

  test('on a phone the role column collapses and every row keeps one left edge', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await seedTurnWithToolCall(loombox);
    await page.setViewportSize({ width: 390, height: 780 });

    const label = page.getByTestId('message-item').first().locator('.role-glyph');
    const prose = page.getByTestId('message-text').first();
    const toolCard = page.getByTestId('tool-card').first();
    // `.composer-field`, not the textarea inside it - see the desktop
    // version of this check (issue #577): the field's own edge is the
    // column now that it is a bordered, padded box.
    const field = page.locator('.composer-field');
    await expect(label).toBeVisible();

    const labelBox = await label.boundingBox();
    const proseBox = await prose.boundingBox();
    const toolBox = await toolCard.boundingBox();
    const fieldBox = await field.boundingBox();

    // Above the turn, not beside it: 84px of a 390px phone went to a
    // six-letter word, which left the prose a 244px measure.
    expect((labelBox?.y ?? 0) + (labelBox?.height ?? 0)).toBeLessThanOrEqual(
      (proseBox?.y ?? 0) + 1,
    );
    expect(Math.abs((labelBox?.x ?? 0) - (proseBox?.x ?? 0))).toBeLessThan(1);

    // What the collapse is FOR. 244px before, 316px measured after.
    expect(proseBox?.width ?? 0).toBeGreaterThan(300);

    // Every other surface sharing that column has to move at the same
    // breakpoint, or the timeline's one rule becomes several that nearly line
    // up — which is the defect the column was introduced to fix.
    expect(Math.abs((toolBox?.x ?? 0) - (proseBox?.x ?? 0))).toBeLessThan(1);
    expect(Math.abs((fieldBox?.x ?? 0) - (proseBox?.x ?? 0))).toBeLessThan(1);
  });

  test('the role column is still beside the turn one breakpoint up', async ({ page, loombox }) => {
    await gotoCockpit(page, loombox);
    await seedTurnWithToolCall(loombox);
    await page.setViewportSize({ width: 768, height: 900 });

    const label = page.getByTestId('message-item').first().locator('.role-glyph');
    const prose = page.getByTestId('message-text').first();
    await expect(label).toBeVisible();
    const labelBox = await label.boundingBox();
    const proseBox = await prose.boundingBox();

    // The collapse is a phone rule (`--bp-mobile`), not a "narrow" one: a
    // tablet has room for the column and keeps it, so the media query must not
    // leak upward.
    expect((labelBox?.x ?? 0) + (labelBox?.width ?? 0)).toBeLessThan(proseBox?.x ?? 0);
    expect(Math.abs((labelBox?.y ?? 0) - (proseBox?.y ?? 0))).toBeLessThan(4);
  });

  test('at 1440px opening the right sidebar reflows the canvas and dims nothing (design spec §3.1/§0.6, issue #571)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
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
