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

    for (const [destination, expected] of [
      ['destination-inbox', /inbox/i],
      ['destination-nodes', /nodes/i],
    ] as const) {
      await page.getByTestId(destination).click();
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveText(expected);
    }
  });

  test('the workbench carries only the open session panels, not the global destinations', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const panels = page.getByRole('group', { name: 'Panels' });
    await expect(panels.getByRole('button')).toHaveCount(3);
    await page.getByTestId('file-tree-toggle').click();
    await expect(page.getByTestId('drawer')).toBeVisible();

    // v3 shipped six tabs, three of which repeated the sidebar's own
    // navigation. Inbox, Nodes and Settings are pages now and must not be
    // reachable as a panel as well. The Drawer's own tab strip — the second
    // copy of this switch — is gone too, so the panel it has open is stated
    // rather than offered again.
    await expect(page.getByTestId('inbox-toggle')).toHaveCount(0);
    await expect(page.getByTestId('targets-toggle')).toHaveCount(0);
    await expect(page.getByTestId('settings-toggle')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByTestId('drawer-title')).toHaveText('Files');
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

  test('the panel switch opens one panel at a time, and says which one is open', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const files = page.getByTestId('file-tree-toggle');
    const terminal = page.getByTestId('terminal-toggle');
    const config = page.getByTestId('project-config-toggle');

    // Three peers of everything else in that corner became one group of three
    // toggles. The state used to live only in a background tint, which is to
    // say nowhere at all for a screen reader; `aria-pressed` is the assertion
    // that matters and the reason these route through `Button`'s new `pressed`
    // rather than a class.
    await expect(files).toHaveAttribute('aria-pressed', 'false');
    await files.click();
    await expect(files).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('file-tree-panel-wrapper')).toBeVisible();
    await expect(terminal).toHaveAttribute('aria-pressed', 'false');
    await expect(config).toHaveAttribute('aria-pressed', 'false');

    // Deliberately asserted: at this width the Drawer is an overlay with a
    // click-to-dismiss backdrop, and that backdrop used to cover the topbar.
    // The switch below could not be clicked at all — `elementFromPoint` at
    // these buttons returned the backdrop, so the click closed the panel
    // instead of switching it. If the Drawer ever stops being an overlay here,
    // this guard has stopped guarding that and should be moved, not deleted.
    await expect(page.getByTestId('drawer-backdrop')).toBeVisible();
    // One drawer: opening another panel closes the first, it never ends up
    // with two segments claiming to be open.
    await terminal.click();
    await expect(terminal).toHaveAttribute('aria-pressed', 'true');
    await expect(files).toHaveAttribute('aria-pressed', 'false');

    // And the open one closes on a second click, which is what makes these
    // toggles rather than a radio group.
    await terminal.click();
    await expect(terminal).toHaveAttribute('aria-pressed', 'false');
  });

  test('the topbar controls show their words where there is room and keep their names where there is not', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    const filesWord = page.getByTestId('file-tree-toggle').locator('.panel-word');
    const paletteWord = page.getByTestId('command-palette-toggle').locator('.panel-word');

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(filesWord).toBeVisible();
    await expect(paletteWord).toBeVisible();

    // Below `--bp-wide` the words go, and this is the half that matters: the
    // five glyphs this replaced had no word ANYWHERE, only a `title` a pointer
    // had to hover for. The accessible name is a prop on the button, not the
    // hidden span, so it survives the pixels going.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(filesWord).toBeHidden();
    await expect(paletteWord).toBeHidden();
    await expect(page.getByRole('button', { name: 'Files' })).toBeVisible();
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
});
