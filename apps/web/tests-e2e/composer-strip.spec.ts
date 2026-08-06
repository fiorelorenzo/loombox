import { expect, sendSessionUpdate, test } from './fixtures';

/**
 * The composer's one control strip (Lorenzo's ask, 2026-07-30): attach, the
 * pickers, and the context/cost figures share the single row under the
 * textarea, where a mini-toolbar above the composer and a keyboard hint below
 * it used to sit.
 *
 * Playwright rather than jsdom, deliberately: every invariant here is a LAYOUT
 * fact — where a row's left edge lands, whether two controls overlap, whether
 * an element spends any pixels — and jsdom has no layout at all, so a
 * component test cannot see any of it. Both regressions these guard were
 * introduced by me and caught by measuring a real render, not by reading the
 * markup: the meter overflowed straight over the Send button at 390px, and the
 * row had to be proven flush with the text column rather than assumed.
 */

/** A real negotiated catalog + a real usage_update: the strip renders off these, never off hardcoded values. */
async function seedStrip(
  node: Parameters<typeof sendSessionUpdate>[0],
  session: Parameters<typeof sendSessionUpdate>[1],
  usage: { tokensUsed: number; costUsd: number },
): Promise<void> {
  await sendSessionUpdate(node, session, {
    kind: 'config_option_update',
    options: [
      {
        category: 'model',
        current: 'sonnet-4-5',
        choices: [
          { id: 'sonnet-4-5', name: 'Sonnet 4.5' },
          { id: 'opus-4-1', name: 'Opus 4.1' },
        ],
      },
      {
        category: 'mode',
        current: 'default',
        choices: [
          { id: 'default', name: 'Auto' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    ],
  });
  await sendSessionUpdate(node, session, {
    kind: 'usage_update',
    sessionId: session.sessionId,
    tokensUsed: usage.tokensUsed,
    contextWindow: 200_000,
    costUsd: usage.costUsd,
  });
}

test.describe('composer strip', () => {
  test('runs under the textarea, flush with the text column, carrying the agent and the figures', async ({
    page,
    loombox,
  }) => {
    // Required, not decorative: Playwright only sets a fixture up for a test
    // that asks for it, and this one is what seeds the bearer token + AMK
    // before the first navigation (same note as `cockpit-shell.spec.ts`).
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    const textarea = page.getByTestId('composer-input');
    await expect(textarea).toBeVisible({ timeout: 60_000 });
    await seedStrip(loombox.node, loombox.session, { tokensUsed: 76_400, costUsd: 0.34 });

    const row = page.getByTestId('composer-controls');
    await expect(row).toBeVisible();

    const textBox = await textarea.boundingBox();
    const rowBox = await row.boundingBox();
    // The FIRST CONTROL's left edge, not the row's: a row box swallows its own
    // padding, so measuring it passes happily while everything inside sits
    // indented (mutation-tested — a 24px `padding-left` on the row did not
    // move `rowBox.x` at all). What a reader sees line up is the paperclip
    // against the first character of the prompt above it.
    const clipBox = await page.getByRole('button', { name: 'Attach image' }).boundingBox();
    expect(Math.abs((clipBox?.x ?? 0) - (textBox?.x ?? 0))).toBeLessThan(1);
    // ...and under it, not above: this is what replaced the old toolbar.
    expect(rowBox?.y ?? 0).toBeGreaterThan(textBox?.y ?? 0);

    // The agent answering, named in front of the consolidated model/
    // thinking/mode trigger (cockpit v8 decision E1-2, issue #711) that
    // replaced the always-visible pickers this row used to hold directly.
    await expect(page.getByTestId('config-agent')).toHaveText('Claude Code');
    await expect(page.getByTestId('config-trigger')).toBeVisible();
    // The context in use against its maximum, and the session's cost.
    const meter = page.getByTestId('context-meter');
    await expect(meter).toContainText('76k');
    await expect(meter).toContainText('200k');
    await expect(meter).toContainText('$0.34');
    await expect(page.getByTestId('context-track')).toHaveAttribute('data-fill', '38');
  });

  test('spends no pixels on the keyboard hint while keeping it as the field description', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    const textarea = page.getByTestId('composer-input');
    await expect(textarea).toBeVisible({ timeout: 60_000 });
    // Still the textarea's accessible description...
    const describedBy = await textarea.getAttribute('aria-describedby');
    expect(describedBy).toBe('composer-hint');
    const hint = page.locator('#composer-hint');
    await expect(hint).toContainText('Enter');
    // ...while taking no room in the row it used to occupy. A visible line
    // would be several hundred pixels wide; the sr-only clip is 1px.
    const box = await hint.boundingBox();
    expect(box?.width ?? 999).toBeLessThanOrEqual(2);
    expect(box?.height ?? 999).toBeLessThanOrEqual(2);
  });

  test('fits one row on a phone: pickers collapse, nothing overlaps, and the status bar keeps every figure without overflowing (issue #736 moved the meter off this row onto the status bar, which has room the composer never had)', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 });
    await seedStrip(loombox.node, loombox.session, { tokensUsed: 191_000, costUsd: 1.4 });

    await page.setViewportSize({ width: 390, height: 780 });
    const row = page.getByTestId('composer-controls');
    await expect(row).toBeVisible();

    // The pickers fold behind the "···" — since E1-2 (issue #711) that's
    // one consolidated trigger, not a picker per category, but it still
    // has to be one of the things that goes.
    await expect(page.getByTestId('config-trigger')).toHaveCount(0);
    await expect(page.getByTestId('config-option-model')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More composer options' })).toBeVisible();

    // The meter itself (issue #736) is not in this row at all anymore — it
    // is the status bar's own full-window-width row, which never had to
    // fit against Send/attach/pickers the way the composer strip did, so
    // nothing about it drops at phone width: both figures, the track, the
    // cost, all still there.
    const meter = page.getByTestId('context-meter');
    await expect(meter).toContainText('191k');
    await expect(meter).toContainText('200k');
    await expect(meter).toContainText('$1.40');
    await expect(page.getByTestId('context-track')).toHaveAttribute('data-fill', '96');

    // The regression this guards, now against the bar the meter actually
    // lives in: it used to overflow its shrunk-to-nothing composer box and
    // paint straight over Send (issue #248); the status bar must not
    // overflow the viewport it spans either.
    const statusBarOverflows = await page
      .getByTestId('status-bar')
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(statusBarOverflows).toBe(false);

    const overlaps = await row.evaluate((el) => {
      const kids = [...el.children].map((child) => ({
        name: child.tagName.toLowerCase() + '.' + String(child.className).split(' ')[0],
        r: child.getBoundingClientRect(),
      }));
      const hits: string[] = [];
      for (let i = 0; i < kids.length; i += 1) {
        for (let j = i + 1; j < kids.length; j += 1) {
          const a = kids[i].r;
          const b = kids[j].r;
          if (
            a.left < b.right - 0.5 &&
            b.left < a.right - 0.5 &&
            a.top < b.bottom - 0.5 &&
            b.top < a.bottom - 0.5
          ) {
            hits.push(`${kids[i].name} over ${kids[j].name}`);
          }
        }
      }
      return hits;
    });
    expect(overlaps).toEqual([]);

    // One row, not the several it took before the meter left it entirely:
    // every remaining child shares the send button's line.
    const send = page.getByRole('button', { name: 'Send prompt' });
    const sendBox = await send.boundingBox();
    const rowBox = await row.boundingBox();
    expect(rowBox?.height ?? 0).toBeLessThan((sendBox?.height ?? 0) * 2);
  });

  test('the placeholder just names the box; the @ instruction lives in the hint, and the hint actually reaches the accessibility tree (A2-1, issue #666)', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    const textarea = page.getByTestId('composer-input');
    await expect(textarea).toBeVisible({ timeout: 60_000 });

    await expect(textarea).toHaveAttribute('placeholder', 'Send a follow-up prompt…');
    const placeholder = await textarea.getAttribute('placeholder');
    expect(placeholder).not.toContain('@');

    const hint = page.locator('#composer-hint');
    await expect(hint).toContainText('@');
    await expect(hint).toContainText('to reference a file');

    // Not just "the text is somewhere in the DOM" — the accessibility tree
    // is what a screen reader actually consumes. `aria-describedby` is
    // supposed to fold the hint's text into the textbox's own accessible
    // *description*, a distinct field from its name; read that field
    // straight out of Chromium's real accessibility tree via CDP (the
    // modern replacement for the removed `page.accessibility` API) rather
    // than assuming the wiring works because the id matches.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const textboxNode = nodes.find(
      (node) => node.role?.value === 'textbox' && node.name?.value === 'Follow-up prompt',
    );
    expect(textboxNode).toBeTruthy();
    const description = String(textboxNode?.description?.value ?? '');
    expect(description).toContain('@');
    expect(description).toContain('to reference a file');

    // The attach control's own glyph, at its new 20px size (up from 16px).
    const attachIcon = page.getByRole('button', { name: 'Attach image' }).locator('svg');
    const box = await attachIcon.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(20);
    expect(Math.round(box?.height ?? 0)).toBe(20);
  });

  test('Stop replaces Send in the same slot while a turn runs, with a live line on the turn gutter that clears when the turn ends (A3-2, issue #666)', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 });

    const send = page.getByRole('button', { name: 'Send prompt' });
    const stop = page.getByTestId('turn-stop-control');
    const progress = page.getByTestId('turn-progress-line');

    // At rest: Send is there, Stop and the progress line are not.
    await expect(send).toBeVisible();
    await expect(stop).toHaveCount(0);
    await expect(progress).toHaveCount(0);

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'turn_started',
      turnId: 'turn-swap',
    });

    // Gone, not disabled-and-present: Send leaves the DOM entirely, Stop
    // takes its exact slot, and the turn's own live line appears — before
    // any thought/message content has arrived for this turn at all, the
    // one gap nothing else in the transcript covers.
    await expect(send).toHaveCount(0);
    await expect(stop).toBeVisible();
    await expect(progress).toBeVisible();

    // Gone means gone: zero matches, not merely invisible — asserted above
    // via `toHaveCount(0)`, not repeated here as a `boundingBox()` probe
    // (which waits out its full actionability timeout against a locator
    // that will never resolve, and stalls the test for no extra signal).
    const attachBox = await page.getByRole('button', { name: 'Attach image' }).boundingBox();

    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'turn_ended',
      turnId: 'turn-swap',
      stopReason: 'end_turn',
    });

    // Settles back: Stop and the progress line both clear, Send returns to
    // the exact same slot, nothing else on the strip moved.
    await expect(stop).toHaveCount(0);
    await expect(progress).toHaveCount(0);
    await expect(send).toBeVisible();
    const attachBoxAfter = await page.getByRole('button', { name: 'Attach image' }).boundingBox();
    expect(attachBoxAfter?.x).toBeCloseTo(attachBox?.x ?? 0, 0);
    expect(attachBoxAfter?.y).toBeCloseTo(attachBox?.y ?? 0, 0);
  });
});
