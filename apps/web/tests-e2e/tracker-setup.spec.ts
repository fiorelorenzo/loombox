import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * F1-1/F2-2 (issue #672, spec §6): the Tracker page's own empty state
 * becomes the tracker-mode setup step (F1-1), and once a mode is saved the
 * page header carries the "what is this / change what this is" control
 * (F2-2) — Config's old Tracker section is deleted outright, not mirrored.
 * `TrackerConfigPanel.svelte` itself (component-level behavior: field
 * reveal, validation, storage round-trip) is already covered by
 * `TrackerConfigPanel.test.ts`; this spec is the real-browser proof that
 * it is reachable from the RIGHT place now, in both its `'panel'` (setup)
 * and `'header'` (change) shapes, and that Config genuinely lost the
 * section rather than still quietly carrying it.
 *
 * Screenshots land in `__screenshots__/issue-672/` as this PR's visual
 * proof, both themes, at 1728px (desktop) and 390px (the narrowest shipped
 * target, same figure `tracker-mobile.spec.ts`/`accounts-mobile.spec.ts`
 * already measure at).
 */
const screenshotDir = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__', 'issue-672');

async function seedTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('loombox:theme', value), theme);
}

/** Writes a PNG under `screenshotDir` and asserts it landed as a real, non-trivial file in the same test — mirrors `primitive-override-cards.spec.ts`'s own helper (issue #665) so a silently-failed navigation can't leave a green test with a blank/missing file. */
async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(screenshotDir, { recursive: true });
  const path = join(screenshotDir, `${name}.png`);
  await page.screenshot({ path });
  const { size } = await stat(path);
  expect(size).toBeGreaterThan(1000);
}

async function openTrackerPage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('destination-tracker').click();
  await expect(page.getByTestId('tracker-page')).toBeVisible();
}

/** Below `--bp-tablet` the sidebar (which hosts the Tracker destination row) is a dismissible sheet reached from the bottom tab bar — mirrors `tracker-mobile.spec.ts`'s own note. Unlike Settings' own `destination-settings` (see `accounts-mobile.spec.ts`'s `openSettingsAccounts`), `destination-tracker`'s click handler already sets `sessionsSheetOpen = false` itself, so a THIRD `tabbar-sessions` click here would toggle the sheet back OPEN instead of closing it — it must NOT be repeated after this. */
async function openTrackerPageMobile(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('tabbar-sessions').click();
  await page.getByTestId('destination-tracker').click();
  await expect(page.getByTestId('tracker-page')).toBeVisible();
  // The sheet's own CSS `transform` slide-out is a plain transition, not a
  // Svelte one Playwright's actionability checks wait out on their own —
  // a screenshot taken before it settles catches the sheet mid-slide
  // (the `.sidebar-backdrop` button unmounts synchronously with the
  // click above, so its ABSENCE is not enough of a signal on its own).
  await expect
    .poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
}

test.describe('Tracker page owns setup and the mode picker (issue #672)', () => {
  test('no tracker mode configured meets a real choice on the Tracker page, not a blank panel', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await openTrackerPage(page);

    await expect(page.getByTestId('tracker-setup')).toBeVisible();
    await expect(page.getByTestId('tracker-config-panel')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Tracking mode' })).toBeVisible();
    // Nothing to summarize in the header before a choice exists — the
    // compact control only appears once F2-2's "what is this" has a real
    // answer (the next test).
    await expect(page.getByTestId('tracker-mode-summary')).toHaveCount(0);
  });

  test('choosing native completes setup, and the header\u2019s compact mode control works from there (F2-2)', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await openTrackerPage(page);

    await page.getByTestId('tracker-mode-native').click();
    await page.getByTestId('tracker-save').click();

    await expect(page.getByTestId('tracker-setup')).toHaveCount(0);
    await expect(page.getByTestId('tracker-mode-summary')).toBeVisible();
    await expect(page.getByTestId('tracker-mode-summary')).toContainText(/native/i);

    // "Works from there": the header's own "Change tracker mode" reopens
    // the same form, pre-selected on the saved mode — Cancel leaves it
    // untouched, same contract `TrackerConfigPanel.test.ts` already proves
    // at the component level, now driven through the real header control.
    await page.getByTestId('tracker-change-mode').click();
    const dialog = page.getByTestId('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('tracker-mode-native')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('tracker-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('tracker-mode-summary')).toContainText(/native/i);
  });

  test('connecting a GitHub or Jira account is reachable from the setup step when none is connected', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await openTrackerPage(page);

    await page.getByTestId('tracker-mode-live').click();
    await expect(page.getByTestId('ui-empty-state')).toContainText(/no connected github account/i);
    await expect(page.getByTestId('tracker-connect-github')).toBeVisible();
    // The pre-#672 escape hatch stays available alongside the real connect
    // path, not replaced by it.
    await expect(page.getByTestId('tracker-use-native-instead')).toBeVisible();

    await page.getByTestId('tracker-connect-github').click();
    await expect(page.getByRole('heading', { name: 'Connect a GitHub account' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog')).toBeHidden();

    await page.getByTestId('tracker-provider-jira').click();
    await expect(page.getByTestId('tracker-connect-jira')).toBeVisible();
    await page.getByTestId('tracker-connect-jira').click();
    await expect(page.getByRole('heading', { name: 'Connect a Jira account' })).toBeVisible();
  });

  test('Config has no Tracker section any more, and its other panels still work (F2-2)', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('project-config-toggle').click();
    const panel = page.getByTestId('project-config-panel-wrapper');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('mcp-config-panel')).toBeVisible();
    await expect(panel.getByTestId('plugin-config-panel')).toBeVisible();
    await expect(panel.getByTestId('tracker-config-panel')).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'Tracker' })).toHaveCount(0);
  });
});

for (const viewport of [
  { name: 'desktop', width: 1728, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test.describe(`Tracker setup screenshots at ${viewport.width}px (issue #672)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const theme of ['dark', 'light'] as const) {
      test(`the empty-state setup step, ${theme}`, async ({ page, loombox }) => {
        expect(loombox.session.sessionId).toBeTruthy();
        await seedTheme(page, theme);
        if (viewport.name === 'mobile') {
          await openTrackerPageMobile(page);
        } else {
          await openTrackerPage(page);
        }
        await expect(page.getByTestId('tracker-setup')).toBeVisible();
        await screenshot(page, `setup-${viewport.name}-${theme}`);
      });

      test(`the header mode control once a mode is saved, ${theme}`, async ({ page, loombox }) => {
        expect(loombox.session.sessionId).toBeTruthy();
        await seedTheme(page, theme);
        if (viewport.name === 'mobile') {
          await openTrackerPageMobile(page);
        } else {
          await openTrackerPage(page);
        }
        await page.getByTestId('tracker-mode-native').click();
        await page.getByTestId('tracker-save').click();
        await expect(page.getByTestId('tracker-mode-summary')).toBeVisible();
        await screenshot(page, `header-${viewport.name}-${theme}`);
      });
    }
  });
}
