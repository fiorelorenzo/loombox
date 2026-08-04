import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, sendSessionUpdate, test, type LoomboxFixture } from './fixtures';

/**
 * v7 turn delimitation (design spec `2026-08-04-cockpit-v7-decisions.md`
 * §2, issue #667: B1-2 amended + B2-4). B1-2 amended: the user turn keeps a
 * `--color-surface-raised` fill, the agent turn has no fill and runs on the
 * page background, and neither carries a gutter accent bar anymore. B2-4:
 * the role glyph is gone from the gutter too, the `.sr-only` role label
 * stays, and the gutter survives narrower as the shared alignment device.
 *
 * Same fixture/navigation pattern as `cockpit-shell.spec.ts`'s own gutter
 * and attribution tests — see that file's `gotoCockpit` doc comment for why
 * the `loombox` fixture (not just `page`) is required.
 */
async function gotoCockpit(page: Page, loombox: LoomboxFixture): Promise<void> {
  expect(loombox.session.sessionId).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('session-row-item').first()).toBeVisible({ timeout: 60_000 });
}

/** One user turn followed by one agent turn — the minimal pair the spec's own acceptance bar asks be "tellable apart at a glance". */
async function seedUserAndAgentTurn(loombox: LoomboxFixture): Promise<void> {
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'user_message_chunk',
    turnId: 'turn-user',
    messageId: 'msg-user',
    text: "Can you check why the relay's device flow times out on a slow network?",
  });
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'agent_message_chunk',
    turnId: 'turn-agent',
    messageId: 'msg-agent',
    text: "Looked at `startGithubConnect` — the poll interval is fixed at 5s with no backoff, so a flaky connection just times out at the SDK's own ceiling rather than retrying. I'll widen the ceiling and add jittered backoff.",
  });
}

const SCREENSHOT_DIR = path.resolve(
  process.cwd(),
  '../../docs/design/turn-delimitation-2026-08-04',
);
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.describe('turn delimitation v7 (design spec §2, issue #667)', () => {
  test('the user turn is tinted, the agent turn is plain, and neither carries a gutter accent bar', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await seedUserAndAgentTurn(loombox);

    const items = page.getByTestId('message-item');
    await expect(items).toHaveCount(2);
    const userRow = items.nth(0);
    const agentRow = items.nth(1);
    await expect(userRow).toHaveClass(/\buser\b/);
    await expect(agentRow).toHaveClass(/\bagent\b/);

    // Exactly one signal per role (B1-2 amended): the user row is filled,
    // the agent row is transparent — not a second, quieter fill, none at
    // all — so it paints through to whatever the page behind it is.
    const [userBg, agentBg] = await Promise.all([
      userRow.evaluate((el) => getComputedStyle(el).backgroundColor),
      agentRow.evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    expect(userBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(agentBg).toBe('rgba(0, 0, 0, 0)');
    expect(userBg).not.toBe(agentBg);

    // No accent bar anywhere — not on the user's own gutter, the one row
    // that used to carry it, and not on the agent's either.
    const [userGutterShadow, agentGutterShadow] = await Promise.all([
      userRow.locator('.gutter').evaluate((el) => getComputedStyle(el).boxShadow),
      agentRow.locator('.gutter').evaluate((el) => getComputedStyle(el).boxShadow),
    ]);
    expect(userGutterShadow).toBe('none');
    expect(agentGutterShadow).toBe('none');
  });

  test('no role glyph renders in the gutter for either role, but the gutter still narrows to the shared token', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await seedUserAndAgentTurn(loombox);

    // B2-4: the glyph is gone entirely, not just suppressed on a repeat.
    await expect(page.locator('[data-icon-name^="provider-"]')).toHaveCount(0);

    // The column survives, narrowed (tokens.css's own comment records why
    // 2.5rem, down from 4.75rem, is the new floor).
    const gutter = page.getByTestId('message-item').first().locator('.gutter');
    const { widthPx, tokenRem, remPx } = await gutter.evaluate((el) => {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const tokenRem = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--gutter').trim(),
      );
      return { widthPx: parseFloat(getComputedStyle(el).width), tokenRem, remPx };
    });
    expect(tokenRem).toBeLessThan(4.75);
    expect(widthPx).toBeCloseTo(tokenRem * remPx, 1);
  });

  test("a screen reader still announces every turn's role — user and agent — with nothing painted to carry it (B2-4's own acceptance bar)", async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await seedUserAndAgentTurn(loombox);

    const items = page.getByTestId('message-item');
    const userSnapshot = await items.nth(0).ariaSnapshot();
    const agentSnapshot = await items.nth(1).ariaSnapshot();
    expect(userSnapshot).toContain('You');
    expect(agentSnapshot).toContain('Claude');

    // The label is real text, not decorative, and clipped to a single
    // pixel — reachable by assistive tech, invisible to sighted users.
    const label = items.nth(0).locator('.sr-only');
    await expect(label).toHaveText('You');
    expect(label.getAttribute('aria-hidden')).not.toBe('true');
    const box = await label.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(1);
    expect(box?.height ?? 0).toBeLessThanOrEqual(1);
  });

  // Screenshots for the PR (acceptance: "verify on screen rather than
  // trusting the paragraph" — spec §2's own words on the B2-4/B1-4 pairing
  // argument). One test per theme/viewport combination the issue asks for,
  // each saving a real screenshot next to this spec's own evidence folder
  // rather than asserting a pixel value nobody could sanity-check by eye.
  for (const theme of ['dark', 'light'] as const) {
    for (const viewport of [
      { name: '1728', width: 1728, height: 1000 },
      { name: '390', width: 390, height: 844 },
    ]) {
      test(`screenshot: ${theme} theme at ${viewport.name}px`, async ({ page, loombox }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await gotoCockpit(page, loombox);
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await seedUserAndAgentTurn(loombox);
        await expect(page.getByTestId('message-item')).toHaveCount(2);
        // Let the beat-in entrance animation settle before capturing.
        await page.waitForTimeout(300);

        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${theme}-${viewport.name}.png`),
        });
      });
    }
  }
});
