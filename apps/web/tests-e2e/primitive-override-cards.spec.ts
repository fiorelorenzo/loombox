import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { generateAmk } from '@loombox/crypto';
import { bridgeRelayCors, expect, sendSessionUpdate, test } from './fixtures';
import { signUpTestUser, startE2eRelay } from './harness/relay-harness';

/**
 * Real-browser proof for issue #665 (a `:global()` override handed to a UI
 * primitive is silently dropped on specificity — verified by compiling
 * `Button`/`Row` and reading the emitted CSS, see that issue's own doc). Two
 * of the seven sites are the visible regression Lorenzo's screenshot caught
 * — the Inbox row (no card, centred title) and the onboarding choice cards
 * (centred) — so this is the layout-sensitive Playwright coverage
 * `AGENTS.md`'s own `gate-composition.spec.ts` note calls out: jsdom never
 * lays anything out, so a `justify-content`/`align-items` regression is
 * invisible to the unit suite. Screenshots land in `__screenshots__/` for
 * the PR to carry as visual proof, both themes, at the 1280px width
 * Lorenzo's own screenshot was taken at.
 */
const screenshotDir = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__', 'issue-665');

async function seedTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('loombox:theme', value), theme);
}

/** Writes a PNG under `screenshotDir` and asserts it landed as a real, non-trivial file in the same test — a silently-failed `page.goto`/navigation would otherwise leave a blank or missing file with the spec still reporting green. */
async function screenshot(
  target: Page | { screenshot: (opts: { path: string }) => Promise<Buffer> },
  name: string,
): Promise<void> {
  await mkdir(screenshotDir, { recursive: true });
  const path = join(screenshotDir, `${name}.png`);
  await target.screenshot({ path });
  const { size } = await stat(path);
  expect(size).toBeGreaterThan(1000);
}

test.describe('Attention inbox item renders as a real card, left-aligned (issue #665)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} theme: card background/border apply and the Open trigger's title stacks above its subtitle, left-aligned`, async ({
      page,
      loombox,
    }) => {
      await seedTheme(page, theme);
      await page.goto('/');
      await expect(page.getByTestId('composer-input')).toBeVisible();

      await sendSessionUpdate(loombox.node, loombox.session, {
        kind: 'session_status',
        status: 'awaiting_input',
        updatedAt: new Date().toISOString(),
      });

      await page.getByTestId('destination-inbox').click();
      const row = page.getByTestId('attention-inbox-item');
      await expect(row).toHaveCount(1);

      // `Row`'s `surface` prop (issue #665): the card background/border now
      // applies — the exact properties a `:global(.item)` override used to
      // declare and silently lose to `.ui-row`'s own scoped root rule.
      const rowStyle = await row.evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, border: style.borderStyle };
      });
      expect(rowStyle.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(rowStyle.border).toBe('solid');

      // `Button`'s `align="start"` prop (issue #665): the title stacks
      // above the subtitle (not side by side) and both read from the same
      // left edge (not centred) — the exact shape a `:global(.open)`
      // override used to declare and silently lose to `.ui-button`'s own
      // `align-items: center`.
      const openButton = row.getByTestId('attention-inbox-open');
      const title = openButton.locator('strong');
      const subtitle = openButton.locator('small');
      const [titleBox, subtitleBox] = await Promise.all([
        title.boundingBox(),
        subtitle.boundingBox(),
      ]);
      expect(titleBox).not.toBeNull();
      expect(subtitleBox).not.toBeNull();
      expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(subtitleBox!.y + 1);
      expect(Math.abs(titleBox!.x - subtitleBox!.x)).toBeLessThanOrEqual(1);

      await screenshot(page, `inbox-card-${theme}`);
      await screenshot(row, `inbox-card-${theme}-row-only`);
    });
  }
});

test.describe('Onboarding choice cards are left-aligned (issue #665)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} theme: the choice card title reads from the card's left edge, not centred`, async ({
      page,
    }) => {
      // No `loombox` fixture here (it also seeds an AMK, which would skip
      // straight past onboarding) — a real relay + a real signed-up
      // account, exactly like the fixture builds, minus the AMK seed, so
      // `+page.svelte` finds an authenticated session with no local AMK and
      // renders `OnboardingGate` instead of the cockpit.
      const relay = await startE2eRelay();
      await bridgeRelayCors(page, relay.httpBaseUrl);
      const { token, accountId } = await signUpTestUser(
        relay.httpBaseUrl,
        `e2e-onboarding-${theme}-${Date.now()}@example.com`,
      );
      generateAmk(); // exercised for parity with the real onboarding path; not persisted (that's the point).

      await seedTheme(page, theme);
      await page.addInitScript(
        (seed) => {
          window.localStorage.setItem(
            'loombox:auth-session',
            JSON.stringify({ token: seed.token, accountId: seed.accountId }),
          );
          window.localStorage.setItem('loombox:relay-url', seed.relayUrl);
        },
        { token, accountId, relayUrl: relay.url },
      );

      try {
        await page.goto('/');
        const gate = page.getByTestId('onboarding-gate');
        await expect(gate).toBeVisible();

        const firstCard = page.getByTestId('onboarding-choose-first-device');
        await expect(firstCard).toBeVisible();

        // `Button`'s `align="start"` prop (issue #665): the title reads
        // from the card's own left edge (a small, constant inset), never
        // centred in the card's full width — the exact shape a
        // `:global(.choice-card-trigger)` override used to declare
        // (`justify-content: flex-start`) and silently lose to
        // `.ui-button`'s own `justify-content: center`.
        const card = page.locator('.choice-card').first();
        const [cardBox, titleBox] = await Promise.all([
          card.boundingBox(),
          firstCard.locator('strong').boundingBox(),
        ]);
        expect(cardBox).not.toBeNull();
        expect(titleBox).not.toBeNull();
        const inset = titleBox!.x - cardBox!.x;
        expect(inset).toBeGreaterThan(0);
        // A centred title in a card this wide would sit roughly mid-card; a
        // left-aligned one sits within one padding step of the edge.
        expect(inset).toBeLessThan(cardBox!.width * 0.25);

        await screenshot(page, `onboarding-choice-${theme}`);
        await screenshot(gate, `onboarding-choice-${theme}-gate-only`);
      } finally {
        await relay.close();
      }
    });
  }
});
