import { expect, test } from '@playwright/test';

/**
 * PWA app shell (issue #125): the one spec in this suite that needs no
 * relay/node backend at all — service-worker registration and manifest
 * installability are properties of the built static shell itself, present
 * before any sign-in. No `loombox` fixture here on purpose.
 */
test.describe('PWA app shell (issue #125)', () => {
  test('loads the app shell and renders the heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'loombox' })).toBeVisible();
  });

  test('ships an installable web manifest (name, icons, standalone display)', async ({ page }) => {
    await page.goto('/');

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBeTruthy();

    const manifestUrl = new URL(manifestHref as string, page.url()).toString();
    const manifestResponse = await page.request.get(manifestUrl);
    expect(manifestResponse.ok()).toBe(true);

    const manifest = (await manifestResponse.json()) as {
      name?: string;
      display?: string;
      start_url?: string;
      icons?: { src: string; sizes: string }[];
    };
    expect(manifest.name).toBe('loombox');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.icons?.length ?? 0).toBeGreaterThan(0);
  });

  test('registers and activates a service worker for the app shell', async ({ page }) => {
    await page.goto('/');

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            return registration?.active?.state ?? null;
          }),
        { timeout: 20_000, message: 'expected a service worker registration to reach "activated"' },
      )
      .toBe('activated');
  });
});
