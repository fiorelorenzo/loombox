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

  test('still restores the session on a SECOND visit, once the worker controls the page', async ({
    page,
  }) => {
    // The regression this guards is a dead app, not a cosmetic one. On the
    // first visit the worker activates but does not claim the open page, so
    // everything works; on the next visit `navigator.serviceWorker.controller`
    // is set, and `+page.svelte`'s `onMount` posted the notification
    // preferences to it before touching auth. Those preferences are a Svelte
    // `$state` proxy, structured clone cannot clone a Proxy, and the resulting
    // `DataCloneError` aborted the rest of `onMount` — so `restoreSession()`
    // never ran and the app sat on "Checking session…" forever. Verified on
    // production before the fix: no `/api/auth/get-session` request was made at
    // all, and the in-page capture showed
    // `DataCloneError: ... #<Object> could not be cloned`.
    //
    // Every other spec in this suite passes either way, because none of them
    // loads the app twice in one browser context.
    await page.route('**/api/auth/get-session*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
    );

    await page.goto('/');
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            return registration?.active?.state ?? null;
          }),
        { timeout: 20_000, message: 'expected the service worker to activate on the first visit' },
      )
      .toBe('activated');

    await page.reload();
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {
        timeout: 20_000,
        message: 'expected the worker to control the page on the second visit',
      })
      .toBe(true);

    // The session lookup has to have happened for this to render at all.
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible({
      timeout: 15_000,
    });
  });
});
