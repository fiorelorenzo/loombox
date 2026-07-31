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

    // The agent answering, named in front of its own model picker.
    await expect(page.getByTestId('config-agent')).toHaveText('Claude Code');
    await expect(page.getByTestId('config-option-model')).toBeVisible();
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

  test('fits one row on a phone: pickers collapse, the figures stay, nothing overlaps', async ({
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

    // The pickers fold behind the "···"; the figures a user watches do not.
    await expect(page.getByTestId('config-option-model')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More composer options' })).toBeVisible();
    const meter = page.getByTestId('context-meter');
    await expect(meter).toContainText('191k');
    await expect(meter).toContainText('$1.40');
    // Only the denominator goes, and the track still carries the ratio.
    await expect(meter).not.toContainText('200k');
    await expect(page.getByTestId('context-track')).toHaveAttribute('data-fill', '96');

    // The regression: the meter used to overflow its shrunk-to-nothing box and
    // paint straight over the Send button.
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

    // One row, not the three it took before the meter was shortened: every
    // child shares the send button's line.
    const send = page.getByRole('button', { name: 'Send prompt' });
    const sendBox = await send.boundingBox();
    const rowBox = await row.boundingBox();
    expect(rowBox?.height ?? 0).toBeLessThan((sendBox?.height ?? 0) * 2);
  });
});
