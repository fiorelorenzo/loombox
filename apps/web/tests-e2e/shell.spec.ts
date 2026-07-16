import { expect, test } from '@playwright/test';

// Placeholder so the e2e harness has a real spec once browsers are
// available in CI. Skipped here since this box has no browser to run it
// against; real coverage lands with the PWA client epic.
test.skip('shell page shows the loombox heading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'loombox' })).toBeVisible();
});
