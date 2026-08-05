import type { Locator, Page } from '@playwright/test';
import { expect, sendSessionUpdate, test, type LoomboxFixture } from './fixtures';

/**
 * The tool-call glyph shares a baseline with the command it names (issue
 * #703 — Lorenzo, reviewing v0.4.1 in the real desktop app: "le icone dei
 * comandi eseguiti di quando esegue un tool non sono allineate con il testo
 * del comando").
 *
 * Playwright rather than jsdom, deliberately (same reasoning as
 * `composer-strip.spec.ts`'s own doc comment): the defect is a LAYOUT fact —
 * where the icon's ink sits relative to the text's ink — and jsdom never
 * lays anything out, so a component test asserting a `padding-top` value
 * would pass or fail on an implementation detail, never on the thing a
 * reader actually sees. `ToolCallGutter`'s `.tool-gutter` and `ToolCard`'s
 * `.tool-card-plain` both push their content down from the row's shared
 * `align-items: flex-start` top edge; comparing bounding-box vertical
 * centers here catches either one drifting relative to the other,
 * regardless of which rule caused it.
 *
 * Mutation-tested (issue #703 PR): reintroducing `ToolCard.svelte`'s old
 * `.tool-card-plain { padding-top: var(--space-2xs); }` — the second copy
 * of the gutter's own nudge that caused this bug — sinks the command text
 * ~7-8px below the icon and fails every assertion below.
 */
async function gotoSession(page: Page, loombox: LoomboxFixture): Promise<void> {
  expect(loombox.session.sessionId).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 });
}

async function seedTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('loombox:theme', value), theme);
}

/** Vertical center of a locator's own bounding box, in page coordinates. */
async function verticalCenter(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no layout box');
  return box.y + box.height / 2;
}

/**
 * A drifted glyph reads as several pixels, not a rounding error — `--space-
 * 2xs` (the padding this bug was about) is 4px, so a tolerance under that
 * still fails on a regression of that size while absorbing sub-pixel font
 * hinting/AA differences between runs.
 */
const ALIGNMENT_TOLERANCE_PX = 3;

test.describe('Tool-call gutter glyph alignment (issue #703)', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`the bash glyph sits on the command's baseline, short and truncated-long commands alike, ${theme} theme`, async ({
      page,
      loombox,
    }) => {
      await seedTheme(page, theme);
      await gotoSession(page, loombox);

      await sendSessionUpdate(loombox.node, loombox.session, {
        kind: 'tool_call',
        id: 'tc-short',
        turnId: 'turn-1',
        title: 'Bash',
        toolKind: 'execute',
        status: 'completed',
        rawInput: { command: 'pwd' },
        content: '/home/dev',
      });
      await sendSessionUpdate(loombox.node, loombox.session, {
        kind: 'tool_call',
        id: 'tc-long',
        turnId: 'turn-1',
        title: 'Bash',
        toolKind: 'execute',
        status: 'completed',
        // Longer than the row is wide: `BashWidget`'s `.title` is
        // `white-space: nowrap` + ellipsis (it never wraps, see the PR
        // description for why "wrap" isn't literally reachable here) — this
        // is the real-world stress case, proving the truncated single line
        // still shares the icon's baseline rather than some other line.
        rawInput: {
          command:
            'pnpm --filter @loombox/web exec vitest run src/lib/components/ToolCallGutter.test.ts --reporter=verbose',
        },
        content: 'ok',
      });

      const rows = page.getByTestId('bash-widget');
      await expect(rows).toHaveCount(2);

      for (let i = 0; i < 2; i += 1) {
        const row = rows.nth(i);
        const icon = row.locator('[data-icon-name="tool-bash"]');
        const command = row.locator('.title');
        await expect(icon).toBeVisible();
        await expect(command).toBeVisible();
        const iconCenter = await verticalCenter(icon);
        const textCenter = await verticalCenter(command);
        expect(Math.abs(iconCenter - textCenter)).toBeLessThan(ALIGNMENT_TOLERANCE_PX);
      }
    });

    test(`the generic tool-call glyph sits on its title's baseline, ${theme} theme`, async ({
      page,
      loombox,
    }) => {
      await seedTheme(page, theme);
      await gotoSession(page, loombox);

      await sendSessionUpdate(loombox.node, loombox.session, {
        kind: 'tool_call',
        id: 'tc-generic',
        turnId: 'turn-1',
        title: 'Read file.ts',
        toolKind: 'read',
        status: 'completed',
      });

      const row = page.getByTestId('generic-tool-row');
      const icon = row.locator('[data-icon-name="tool-generic"]');
      const title = row.locator('.title');
      await expect(icon).toBeVisible();
      await expect(title).toBeVisible();
      const iconCenter = await verticalCenter(icon);
      const textCenter = await verticalCenter(title);
      expect(Math.abs(iconCenter - textCenter)).toBeLessThan(ALIGNMENT_TOLERANCE_PX);
    });
  }
});
