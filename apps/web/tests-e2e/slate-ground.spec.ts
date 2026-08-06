import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { contrastRatio, relativeLuminance } from '../src/lib/accent-color';
import { expect, sendSessionUpdate, test, type LoomboxFixture } from './fixtures';

/**
 * Zed-parity A1-2 (issue #733, `docs/superpowers/specs/2026-08-05-zed-
 * parity-decisions.md`): the dark theme's ground inverts — chrome
 * (`--color-rail`) lightest, the content well (`--color-bg`, i.e.
 * `.canvas`) darkest, with real chroma instead of near-zero. Light is
 * deliberately NOT inverted (its own chrome-darker-than-canvas "shell"
 * reading from #502 stands), so this spec locks in both relations rather
 * than just the dark one.
 *
 * Same fixture/navigation pattern as `turn-delimitation.spec.ts`.
 */
async function gotoCockpit(page: Page, loombox: LoomboxFixture): Promise<void> {
  expect(loombox.session.sessionId).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('sessions-column')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('session-row-item').first()).toBeVisible({ timeout: 60_000 });
}

/** One user turn followed by one agent turn, so the screenshot shows a real message row (`--color-surface`, the "flat" elevation tier) sitting inside the canvas, not just an empty page. */
async function seedUserAndAgentTurn(loombox: LoomboxFixture): Promise<void> {
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'user_message_chunk',
    turnId: 'turn-user',
    messageId: 'msg-user',
    text: 'Does the new ground actually read as chrome-lightest, content-darkest?',
  });
  await sendSessionUpdate(loombox.node, loombox.session, {
    kind: 'agent_message_chunk',
    turnId: 'turn-agent',
    messageId: 'msg-agent',
    text: 'Checked `--color-bg` against `--color-rail` on `:root` — the canvas is the deepest surface on screen now, the sidebar is the lightest, and `--color-surface`/`--color-surface-raised` step between them in that order.',
  });
}

/** Reads the four neutral ramp tokens straight off `:root` — the same values `deck.css` sets and `/style-reference`'s neutral swatches render, without coupling to that page's markup. */
async function readNeutralRamp(
  page: Page,
): Promise<{ bg: string; surface: string; surfaceRaised: string; rail: string }> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    return {
      bg: read('--color-bg'),
      surface: read('--color-surface'),
      surfaceRaised: read('--color-surface-raised'),
      rail: read('--color-rail'),
    };
  });
}

const SCREENSHOT_DIR = path.resolve(process.cwd(), '../../docs/design/ground-inversion-2026-08-06');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.describe('A1-2 dark ground inversion (issue #733)', () => {
  test('dark: chrome (rail) is the lightest neutral, the canvas (bg) is the deepest, and every tier is distinguishable', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    const { bg, surface, surfaceRaised, rail } = await readNeutralRamp(page);

    // Strictly decreasing luminance from chrome to content well — the
    // inversion itself, measured off the live tokens rather than asserted.
    const [lRail, lSurfaceRaised, lSurface, lBg] = [rail, surfaceRaised, surface, bg].map(
      relativeLuminance,
    );
    expect(lRail).toBeGreaterThan(lSurfaceRaised);
    expect(lSurfaceRaised).toBeGreaterThan(lSurface);
    expect(lSurface).toBeGreaterThan(lBg);

    // "Distinguishable at a glance": each adjacent step clears a real
    // contrast-ratio floor, not a rounding difference invisible on screen.
    expect(contrastRatio(rail, surfaceRaised)).toBeGreaterThan(1.15);
    expect(contrastRatio(surfaceRaised, surface)).toBeGreaterThan(1.15);
    expect(contrastRatio(surface, bg)).toBeGreaterThan(1.15);
    // And the two ends of the ramp are clearly, not just technically, apart.
    expect(contrastRatio(rail, bg)).toBeGreaterThan(1.8);
  });

  test('light: the pre-existing chrome-darker-than-canvas relation is untouched (light is not being inverted)', async ({
    page,
    loombox,
  }) => {
    await gotoCockpit(page, loombox);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

    const { bg, rail } = await readNeutralRamp(page);
    // Opposite of dark on purpose (deck.css's light doc comment: "clearly
    // DARKER than the canvas, so the merged sidebar reads as a shell").
    expect(relativeLuminance(rail)).toBeLessThan(relativeLuminance(bg));
  });

  // Screenshots for the PR — the cockpit in both themes, from a real spec
  // run against a real relay + fake node (not a hand-taken screenshot).
  for (const theme of ['dark', 'light'] as const) {
    test(`screenshot: ${theme} theme cockpit`, async ({ page, loombox }) => {
      await page.setViewportSize({ width: 1728, height: 1000 });
      await gotoCockpit(page, loombox);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await seedUserAndAgentTurn(loombox);
      await expect(page.getByTestId('message-item')).toHaveCount(2);
      // Let the beat-in entrance animation settle before capturing.
      await page.waitForTimeout(300);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${theme}-1728.png`),
      });
    });
  }
});
