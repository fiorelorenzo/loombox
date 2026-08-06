import type { Locator, Page } from '@playwright/test';
import { expect, sendSessionUpdate, test, type LoomboxFixture } from './fixtures';

/**
 * The tool-call glyph shares a baseline with the command/title it names
 * (issue #703 — Lorenzo, reviewing v0.4.1 in the real desktop app: "le
 * icone dei comandi eseguiti di quando esegue un tool non sono allineate
 * con il testo del comando").
 *
 * Playwright rather than jsdom, deliberately (same reasoning as
 * `composer-strip.spec.ts`'s own doc comment): the defect is a LAYOUT fact —
 * where the icon's box sits relative to the text's — and jsdom never lays
 * anything out, so a component test asserting a CSS property's value would
 * pass or fail on an implementation detail, never on the thing a reader
 * actually sees.
 *
 * Covers every `ToolCallGutter` consumer whose resting state renders
 * `ToolCard surface={false}` (`.tool-card-plain`) — `BashWidget` and
 * `EditWriteWidget` always, `GenericToolRow`/`TodoWidget` in their default
 * collapsed state (C1-1) — across both the monospace command font
 * (`BashWidget`) and the UI-sans title font (the other three), both themes.
 * `GenericToolRow`/`TodoWidget`'s *expanded* multi-line state
 * (`surface={true}`) is intentionally not covered here: that variant's
 * padding is a real, uniform box-inset for its bordered-card look, not an
 * alignment device, and carries its own smaller pre-existing offset the
 * issue #703 PR left untouched (see that PR's description).
 *
 * Mutation-tested (issue #703 PR): reintroducing `ToolCard.svelte`'s old
 * `.tool-card-plain { padding-top: var(--space-2xs); }` — the second copy
 * of the gutter's own nudge that caused this bug — fails every assertion
 * below.
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
 * A drifted glyph reads as several pixels, not a rounding error — the old
 * `--space-2xs` padding this bug was about is 4px, and the original defect
 * (`ToolCard`'s doubled copy of it) measured 7-11px off depending on the
 * row. The fix aligns the icon to the header text's shared `line-height`
 * (`1lh`) rather than to any one font's measured ascent (issue #703 PR
 * discussion — a hand-tuned pixel offset only ever matches one font/size
 * combination), so a few pixels of slack remain across the different
 * fonts/weights/icon glyphs these rows use (measured 0-4.2px across every
 * consumer below, both themes). This tolerance stays well under half the
 * original defect's magnitude while still failing on a regression of that
 * size.
 */
const ALIGNMENT_TOLERANCE_PX = 5;

/** Asserts the row's decorative gutter icon and its header text share a vertical center, within tolerance. */
async function expectGlyphAlignedWithText(
  row: Locator,
  iconName: string,
  textSelector = '.title',
): Promise<void> {
  const icon = row.locator(`[data-icon-name="${iconName}"]`);
  const text = row.locator(textSelector);
  await expect(icon).toBeVisible();
  await expect(text).toBeVisible();
  const iconCenter = await verticalCenter(icon);
  const textCenter = await verticalCenter(text);
  expect(Math.abs(iconCenter - textCenter)).toBeLessThan(ALIGNMENT_TOLERANCE_PX);
}

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
        // `white-space: nowrap` + ellipsis (it never wraps — the header
        // never does, see the PR description) — this is the real-world
        // stress case, proving the truncated single line still shares the
        // icon's baseline rather than some other line.
        rawInput: {
          command:
            'pnpm --filter @loombox/web exec vitest run src/lib/components/ToolCallGutter.test.ts --reporter=verbose',
        },
        content: 'ok',
      });

      const rows = page.getByTestId('bash-widget');
      await expect(rows).toHaveCount(2);
      for (let i = 0; i < 2; i += 1) {
        await expectGlyphAlignedWithText(rows.nth(i), 'tool-bash');
      }
    });

    test(`the generic tool-call glyph sits on its title's baseline (resting, collapsed state), ${theme} theme`, async ({
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

      // `toolKind: 'read'` now draws its own `tool-read` glyph (issue
      // #744) rather than the shared `tool-generic` wrench every
      // `GenericToolRow` consumer used to draw regardless of kind — the
      // alignment guarantee itself is unchanged, only which icon name to
      // look for.
      await expectGlyphAlignedWithText(page.getByTestId('generic-tool-row'), 'tool-read');
    });

    test(`the edit/write glyph sits on its title's baseline, ${theme} theme`, async ({
      page,
      loombox,
    }) => {
      await seedTheme(page, theme);
      await gotoSession(page, loombox);

      await sendSessionUpdate(loombox.node, loombox.session, {
        kind: 'tool_call',
        id: 'tc-edit',
        turnId: 'turn-1',
        title: 'Edit src/lib/components/ToolCallGutter.svelte',
        toolKind: 'edit',
        status: 'completed',
        diff: {
          path: 'src/lib/components/ToolCallGutter.svelte',
          oldText: 'a',
          newText: 'b',
        },
      });

      await expectGlyphAlignedWithText(page.getByTestId('edit-write-widget'), 'tool-edit');
    });

    test(`the todo glyph sits on its title's baseline (resting, collapsed state), ${theme} theme`, async ({
      page,
      loombox,
    }) => {
      await seedTheme(page, theme);
      await gotoSession(page, loombox);

      await sendSessionUpdate(loombox.node, loombox.session, {
        kind: 'tool_call',
        id: 'tc-todo',
        turnId: 'turn-1',
        title: 'Todo list',
        toolKind: 'other',
        status: 'completed',
        rawInput: { todos: [{ content: 'one', status: 'completed' }] },
      });

      await expectGlyphAlignedWithText(page.getByTestId('todo-widget'), 'tool-generic');
    });
  }
});
