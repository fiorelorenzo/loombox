import { expect, test } from '@playwright/test';

/**
 * The signed-out gate's composition (`$lib/components/GateShell.svelte`). Like
 * `pwa-shell.spec.ts`, this needs no relay/node backend: the session lookup is
 * the only network call involved and this spec fulfils it itself, so no
 * `loombox` fixture here on purpose.
 *
 * These are layout properties, which is exactly why they live here rather than
 * in `routes/page.test.ts`: jsdom has no layout, so a `justify-content` or
 * `min-height` regression is invisible to the unit suite. Both assertions below
 * describe a real bug this shell fixed:
 *
 *  - The gate was never centred. `main` was a top-aligned padded column (its
 *    own comment claimed the pre-cockpit screens kept a "centered column
 *    layout"; the rule had no `justify-content`, no `align-items`, no
 *    `max-width`), so the panel sat under the header with two thirds of the
 *    window empty below it.
 *  - Sizing each state's panel to its own content made the composition jump
 *    when the session resolved: the checking panel measured 230px wide against
 *    the sign-in panel's 334px, and once widths were fixed a 46px vertical
 *    shift remained, because a shorter panel in a centred column sits lower.
 */
test.describe('signed-out gate composition', () => {
  test('holds the lockup and the panel still while the session resolves', async ({ page }) => {
    // Hold the session lookup so the "Checking session…" panel stays on screen
    // long enough to measure, then release it into the signed-out state.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/auth/get-session*', async (route) => {
      await held;
      // Better Auth answers a session-less request with a 200 and a `null`
      // body, so this lands on the sign-in gate rather than an error notice.
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });

    await page.goto('/');

    const lockup = page.getByTestId('brand-lockup');
    const panel = page.getByTestId('ui-card');
    await expect(page.getByText('Checking session…')).toBeVisible();
    const checkingLockup = await lockup.boundingBox();
    const checkingPanel = await panel.boundingBox();
    expect(checkingLockup).not.toBeNull();
    expect(checkingPanel).not.toBeNull();

    release();
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();

    // The lockup must not move at all, and the panel must keep its position and
    // width. Its height is free to change: the states carry different content,
    // and the panel grows downwards from a fixed top edge.
    expect(await lockup.boundingBox()).toEqual(checkingLockup);
    const signedOutPanel = await panel.boundingBox();
    expect({
      x: signedOutPanel?.x,
      y: signedOutPanel?.y,
      width: signedOutPanel?.width,
    }).toEqual({ x: checkingPanel?.x, y: checkingPanel?.y, width: checkingPanel?.width });
  });

  test('centres the panel in the viewport', async ({ page }) => {
    await page.route('**/api/auth/get-session*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
    );

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();

    const panel = await page.getByTestId('ui-card').boundingBox();
    const viewport = page.viewportSize();
    expect(panel).not.toBeNull();
    expect(viewport).not.toBeNull();

    const panelCentre = (panel?.x ?? 0) + (panel?.width ?? 0) / 2;
    // Sub-pixel tolerance only: this is "centred", not "roughly centred".
    expect(Math.abs(panelCentre - (viewport?.width ?? 0) / 2)).toBeLessThanOrEqual(1);
    // And it sits in the middle of the window rather than under a page header:
    // the old layout put the panel's top edge in the first fifth of the screen.
    expect(panel?.y ?? 0).toBeGreaterThan((viewport?.height ?? 0) * 0.25);
  });
});
