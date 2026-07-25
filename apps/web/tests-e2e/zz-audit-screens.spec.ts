// TEMPORARY UI-audit harness (not a real spec): drives the built PWA against
// the real e2e relay + fake node and dumps screenshots of every surface into
// `.audit/`. Delete before merging.
import { expect, sendPermissionRequest, sendSessionUpdate, test } from './fixtures';
import { announceSession, FakeNode, randomBase64 } from './harness/relay-harness';

const OUT = '.audit';

test.describe('ui audit', () => {
  test('capture', async ({ page, loombox }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.text());
    });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));

    await page.addInitScript(() => {
      localStorage.setItem('loombox:theme', 'dark');
    });
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    const node2 = new FakeNode(loombox.relay.url, {
      deviceId: 'audit-node-2',
      devicePublicKey: randomBase64(),
      authToken: loombox.token,
    });
    await node2.ready;
    await announceSession(node2, {
      amk: loombox.amk,
      accountId: loombox.accountId,
      sessionId: 'sess_audit_2',
      nodeId: 'macbook-pro',
      targetId: 'ssh:build-server',
      provider: 'codex',
      title: 'Fix the flaky auth test',
      projectPath: '/Users/lorenzo/Progetti/pitchbox',
    });
    await announceSession(node2, {
      amk: loombox.amk,
      accountId: loombox.accountId,
      sessionId: 'sess_audit_3',
      nodeId: 'macbook-pro',
      targetId: 'local',
      provider: 'claude',
      title: 'Refactor the relay routing table so reconnects stop replaying',
      projectPath: '/Users/lorenzo/Progetti/loombox',
    });

    const s = loombox.session;
    await sendSessionUpdate(loombox.node, s, { kind: 'turn_started', turnId: 'turn-1' });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'session_status',
      status: 'working',
      updatedAt: new Date().toISOString(),
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'user_message_chunk',
      turnId: 'turn-1',
      messageId: 'user-1',
      text: 'The relay replays session updates after a reconnect. Find out why and fix it.',
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'agent_thought_chunk',
      turnId: 'turn-1',
      messageId: 'thought-1',
      text: 'The dedupe key is probably per-connection rather than per-session. Checking routing.ts.',
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-1',
      text: 'Found it. The relay fans a `session_update` out to every subscribed client, but the dedupe set is keyed by sequence number alone, so a reconnect replays everything the client already saw.',
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'tool_call',
      id: 'tool-1',
      turnId: 'turn-1',
      title: 'Read packages/relay/src/routing.ts',
      toolKind: 'read',
      status: 'completed',
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'tool_call',
      id: 'tool-2',
      turnId: 'turn-1',
      title: 'Edit packages/relay/src/routing.ts',
      toolKind: 'edit',
      status: 'completed',
      diff: {
        path: 'packages/relay/src/routing.ts',
        oldText: 'const seen = new Set<number>();\nif (seen.has(seq)) return;\nseen.add(seq);',
        newText:
          'const seen = new Map<string, number>();\nif ((seen.get(sessionId) ?? -1) >= seq) return;\nseen.set(sessionId, seq);',
      },
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'tool_call',
      id: 'tool-4',
      turnId: 'turn-1',
      title: 'grep -rn "dedupe" packages/relay/src',
      toolKind: 'search',
      status: 'completed',
      content: 'packages/relay/src/routing.ts:41: // dedupe by seq',
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'plan_update',
      entries: [
        { content: 'Reproduce the replay against a fake node', status: 'completed', priority: 'high' },
        { content: 'Key the dedupe by (sessionId, seq)', status: 'in_progress', priority: 'high' },
        { content: 'Add a regression test in relay.test.ts', status: 'pending', priority: 'medium' },
      ],
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'usage_update',
      sessionId: s.sessionId,
      tokensUsed: 48_120,
      contextWindow: 200_000,
      costUsd: 0.42,
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'config_options',
      options: [
        {
          category: 'model',
          current: 'sonnet',
          choices: [
            { id: 'sonnet', name: 'Sonnet 4.5' },
            { id: 'haiku', name: 'Haiku 4.5' },
          ],
        },
        {
          category: 'mode',
          current: 'code',
          choices: [
            { id: 'code', name: 'Code' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        {
          category: 'thought_level',
          current: 'medium',
          choices: [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ],
        },
      ],
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/02-cockpit-dark.png` });

    await sendPermissionRequest(loombox.node, s, {
      requestId: 'perm-1',
      toolCall: {
        kind: 'tool_call',
        id: 'tool-3',
        title: 'Run `pnpm -r test`',
        toolKind: 'execute',
        status: 'pending',
        rawInput: { command: 'pnpm -r test' },
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await sendSessionUpdate(loombox.node, s, {
      kind: 'session_status',
      status: 'permission_required',
      updatedAt: new Date().toISOString(),
    });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/03-permission-dark.png` });

    async function shoot(name: string): Promise<void> {
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${name}.png` });
    }

    // Account menu (click the backdrop to close — Escape is now handled too).
    await page.getByTestId('account-menu-toggle').click();
    await shoot('05-account-menu');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toBeHidden();

    await page.getByTestId('rail-settings').click();
    await shoot('06-drawer-settings');
    await page.getByTestId('drawer-tab-targets').click();
    await shoot('07-drawer-targets');
    await page.getByTestId('drawer-tab-inbox').click();
    await shoot('08-drawer-inbox');
    if (await page.getByTestId('drawer-tab-files').isVisible()) {
      await page.getByTestId('drawer-tab-files').click();
      await shoot('09-drawer-files');
    }
    await page.getByTestId('drawer-close').click();

    await page.getByTestId('rail-command').click();
    await shoot('10-command-palette');
    await page.keyboard.press('Escape');

    await page.getByTestId('new-session-button').click();
    await shoot('11-new-session');
    await page.keyboard.press('Escape');

    await page.getByTestId('add-target-button').click();
    await shoot('12-add-target');
    await page.keyboard.press('Escape');

    // Light theme, Deck.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await shoot('13-deck-light');

    for (const style of ['loom', 'studio'] as const) {
      await page.evaluate((v) => document.documentElement.setAttribute('data-style', v), style);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await shoot(`14-${style}-dark`);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await shoot(`14-${style}-light`);
    }
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-style', 'deck');
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await shoot('15-mobile');
    await page.getByTestId('rail-sessions').click();
    await shoot('16-mobile-sessions');
    await page.getByTestId('rail-sessions').click();

    await page.setViewportSize({ width: 1024, height: 768 });
    await shoot('17-1024');

    await page.setViewportSize({ width: 1920, height: 1080 });
    await shoot('18-1920');

    node2.close();
  });
});
