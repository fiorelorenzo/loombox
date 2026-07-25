import { expect, test } from './fixtures';

/**
 * The project config surface (SPEC.md §7.7; issue #366): mounts the
 * MCP-server quick-add panel (#188) and the plugin/extension panel (#191),
 * both of which shipped fully built and unit-tested in #364 but were left
 * unmounted from `+page.svelte` to avoid a parallel-edit clash. This is the
 * browser-driven proof the surface is actually reachable from the app shell
 * for a real selected session, and that a quick-added preset produces a
 * real, visible config record rather than only working in an isolated
 * component test.
 *
 * Both tests take the `loombox` fixture even where they never name it
 * again: Playwright only sets a fixture up for a test that asks for it, and
 * this one is what stands the relay up and seeds the bearer token + AMK
 * before the first navigation. Taking only `page` lands on the signed-out
 * gate pointed at the PUBLIC relay — which is why this suite sat at
 * `describe.fixme` blaming the headless devbox.
 */
test.describe('Project config surface (issue #366)', () => {
  test('opens from the header, quick-adds an MCP preset, and shows the resulting server record', async ({
    page,
    loombox,
  }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('project-config-toggle')).toBeVisible();
    await page.getByTestId('project-config-toggle').click();

    const panel = page.getByTestId('project-config-panel-wrapper');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('mcp-config-panel')).toBeVisible();
    await expect(panel.getByTestId('plugin-config-panel')).toBeVisible();

    await panel.getByTestId('preset-add-filesystem').click();

    await expect(panel.getByTestId('mcp-server-filesystem')).toBeVisible();
  });

  test('adding a plugin is independent of the MCP-server list', async ({ page, loombox }) => {
    expect(loombox.session.sessionId).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('project-config-toggle').click();
    const panel = page.getByTestId('project-config-panel-wrapper');

    await panel.getByTestId('plugin-add-name').fill('commit-lint');
    await panel.getByTestId('plugin-add-source').fill('@loombox-plugins/commit-lint');
    await panel.getByTestId('plugin-add-submit').click();

    await expect(panel.getByTestId('plugin-commit-lint')).toBeVisible();
    await expect(panel.getByTestId('mcp-server-list')).toHaveCount(0);
  });
});
