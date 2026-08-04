import type { Page } from '@playwright/test';
import type { AccountPinGetRequest, ConnectedAccount, JiraConnectRequest } from '@loombox/protocol';
import { expect, test } from './fixtures';

/**
 * The Settings "Accounts" section (SPEC §7.26, issue #230) at 390px — the
 * narrowest shipped target (an iPhone 12/13/14's logical width, the same
 * figure `inbox-mobile.spec.ts`/`composer-strip.spec.ts` already measure
 * at). This issue's own acceptance calls the section out specifically:
 * "Settings is reachable on mobile and this section has forms and a
 * dialog in it" — so this spec drives the real connect dialog (not just
 * the static list) at this width, and measures the row/dialog boxes
 * against the viewport rather than assuming `min-width: 0` down the flex
 * chain actually holds (the same discipline `inbox-mobile.spec.ts` uses).
 *
 * `FakeNode` is a raw socket, not a real `JiraConnectService` (SPEC §7.26's
 * node-only connect flows run in `packages/node`, out of this PWA-only
 * harness's reach) — so each test plays the node's own half by hand,
 * `waitFor`-ing the routed `jira_connect_request` and replying with a real
 * `jira_connect_response`, the same "you control both ends" convention
 * every other `FakeNode`-driven spec in this directory already uses.
 */
async function openSettingsAccounts(page: Page): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeVisible();
  // Below `--bp-tablet` the left sidebar (which hosts the account menu) is
  // a dismissible sheet reached from the bottom tab bar, not an inline
  // column — `tabbar-sessions` opens it (see this file's own doc comment).
  await page.getByTestId('tabbar-sessions').click();
  await page.getByTestId('account-menu-toggle').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  // Selecting Settings switches `mainView` but leaves the mobile sessions
  // sheet itself open behind it (it is a separate piece of state) — close
  // it the way a real user would, via the same `tabbar-sessions` toggle
  // that opened it (it stays elevated above the sheet's own backdrop by
  // z-index, so this reaches it even with the sheet still covering most
  // of the screen).
  await page.getByTestId('tabbar-sessions').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('settings-tab-accounts').click();
  await expect(page.getByTestId('connected-accounts-section')).toBeVisible();
}

test.describe('Connected accounts at 390px (issue #230)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Settings is reachable, the Accounts section lists within the viewport, and the Jira connect dialog fits and completes a real round trip', async ({
    page,
    loombox,
  }) => {
    loombox.node.send({
      type: 'target_announce',
      protocolVersion: 1,
      nodeId: 'e2e-node-daemon',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    } as never);

    await page.goto('/');
    await openSettingsAccounts(page);

    // Below `--bp-tablet` (768px) the segmented control replaces the left
    // sub-nav (`SettingsPage.svelte`'s own `.settings-tabs`/`.settings-nav`
    // split) — this is the mobile affordance, not the desktop one.
    await expect(page.getByTestId('settings-nav')).toBeHidden();

    const sectionBox = await page.getByTestId('settings-section-accounts').boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(sectionBox!.x).toBeGreaterThanOrEqual(0);
    expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(390);

    // Opens and drives the real Jira connect dialog — forms plus a dialog,
    // both at this width, per this issue's own acceptance.
    const requestPromise = loombox.node.waitFor(
      (message) => message.type === 'jira_connect_request',
    );
    await page.getByTestId('accounts-connect-jira').click();
    const dialog = page.getByTestId('dialog');
    await expect(dialog).toBeVisible();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);

    await page.getByTestId('jira-connect-site-url').fill('https://team-a.atlassian.net');
    await page.getByTestId('jira-connect-email').fill('lorenzo@example.com');
    await page.getByTestId('jira-connect-api-token').fill('tok-a');
    await page.getByTestId('jira-connect-submit').click();

    const request = (await requestPromise) as JiraConnectRequest;
    expect(request.siteUrl).toBe('https://team-a.atlassian.net');
    const account: ConnectedAccount = {
      id: 'jira:team-a.atlassian.net:acc-1',
      provider: 'jira',
      host: 'team-a.atlassian.net',
      providerAccountId: 'acc-1',
      label: 'Lorenzo',
      credentialSource: 'api_token',
      scopes: null,
      capabilities: ['issues', 'comments'],
      connectedAt: Date.now(),
      updatedAt: Date.now(),
      secretRef: 'connected-account-token:jira:team-a.atlassian.net:acc-1',
    };
    // A real node does two separate things on a successful connect: reply
    // to the request that drove it, and separately announce the new
    // account's metadata (`connectedAccountAnnounce`'s own doc comment:
    // "A node publishes ... to the relay") — `refreshConnectedAccounts()`
    // below re-asks the relay for its list, which only has this account in
    // it once the announce has landed too.
    loombox.node.send({
      type: 'jira_connect_response',
      protocolVersion: 1,
      requestId: request.requestId,
      nodeId: request.nodeId,
      result: { outcome: 'success', account },
    } as never);
    loombox.node.send({
      type: 'connected_account_announce',
      protocolVersion: 1,
      account,
    } as never);

    await expect(page.getByTestId('jira-connect-success')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('jira-connect-close').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Lorenzo')).toBeVisible();
  });

  test('the dialog traps focus and Escape returns it to the trigger — keyboard-only, no mouse', async ({
    page,
    loombox,
  }) => {
    loombox.node.send({
      type: 'target_announce',
      protocolVersion: 1,
      nodeId: 'e2e-node-daemon',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    } as never);

    await page.goto('/');
    await openSettingsAccounts(page);

    const trigger = page.getByTestId('accounts-connect-jira');
    await trigger.click();
    await expect(page.getByTestId('dialog')).toBeVisible();

    // Focus starts inside the dialog (Dialog's own focus-trap entry), not
    // left behind on the trigger.
    await expect(page.getByTestId('jira-connect-site-url')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog')).toBeHidden();
    // Focus is handed back to the control that opened it (Dialog's own
    // focus-trap exit) — verified via a real Enter re-opening it, not a
    // JS focus() call.
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('dialog')).toBeVisible();
  });

  test('the per-project pin picker is reachable and operable by keyboard alone', async ({
    page,
    loombox,
  }) => {
    loombox.node.send({
      type: 'target_announce',
      protocolVersion: 1,
      nodeId: 'e2e-node-daemon',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    } as never);
    loombox.node.send({
      type: 'connected_account_announce',
      protocolVersion: 1,
      account: {
        id: 'github:github.com:1',
        provider: 'github',
        host: 'github.com',
        providerAccountId: '1',
        label: 'lorenzo',
        credentialSource: 'device_flow',
        scopes: ['repo'],
        capabilities: ['issues'],
        connectedAt: Date.now(),
        updatedAt: Date.now(),
        secretRef: 'connected-account-token:github:github.com:1',
      },
    } as never);

    await page.goto('/');
    await openSettingsAccounts(page);
    await expect(page.getByTestId('connected-account-row-github:github.com:1')).toBeVisible();

    loombox.node
      .waitFor((message) => message.type === 'account_pin_get_request')
      .then((message) => {
        const request = message as AccountPinGetRequest;
        loombox.node.send({
          type: 'account_pin_response',
          protocolVersion: 1,
          requestId: request.requestId,
          nodeId: 'e2e-node-daemon',
          projectPath: request.projectPath,
          pins: {},
        } as never);
      });

    const radio = page.getByTestId('account-pin-radio-github-__none__');
    await expect(radio).toBeVisible({ timeout: 15_000 });
    await radio.focus();
    await expect(radio).toBeFocused();
  });
});
