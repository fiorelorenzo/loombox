import { PROTOCOL_V1, type SpendReportRequest } from '@loombox/protocol';
import { expect, test } from './fixtures';
import { deriveNodeProjectKey, nodeSeal } from './harness/relay-harness';

/**
 * The aggregate spend-over-time view (SPEC §7.9; issue #249) at the
 * width it is actually promised to work at — the app's mobile floor,
 * same 390x844 figure `tracker-mobile.spec.ts`/`accounts-mobile.spec.ts`
 * already measure at. Lives inside the right sidebar's Config workbench
 * tab (a bottom sheet at this width, `cockpit-shell.spec.ts`'s own
 * `workbench-toggle` precedent), not a dedicated page, so this spec
 * drives the same sheet-open path every other Config-tab spec would.
 */
test.describe('Spend-over-time view at 390px (issue #249)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens inside the Config sheet, renders a known fixture into the exact expected total/per-provider breakdown, and never overflows the viewport', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    // The right sidebar is an off-canvas bottom sheet at this width
    // (cockpit-shell.spec.ts's own `workbench-toggle` precedent) —
    // opened, then switched to its Config sub-tab, exactly like a
    // person reaching MCP servers/secrets/plugins would.
    await page.getByTestId('workbench-toggle').click();
    await page.getByTestId('project-config-toggle').click();
    await expect(page.getByTestId('spend-report-panel')).toBeVisible();

    const request = (await loombox.node.waitFor(
      (message) => message.type === 'spend_report_request',
    )) as SpendReportRequest;
    expect(request.nodeId).toBe('e2e-node-daemon');
    expect(request.projectPath).toBe('/workspace/e2e-project');

    const projectPath = '/workspace/e2e-project';
    const key = await deriveNodeProjectKey(loombox.amk, loombox.accountId, projectPath);
    const rows = [
      { date: '2026-08-01', provider: 'claude', costUsd: 1.5 },
      { date: '2026-08-01', provider: 'codex', costUsd: 0.75 },
      { date: '2026-08-02', provider: 'claude', costUsd: 2.25 },
    ];
    const envelope = await nodeSeal(projectPath, { rows }, key);
    loombox.node.send({
      type: 'spend_report_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'e2e-node-daemon',
      projectPath,
      requestId: request.requestId,
      envelope,
    });

    // Exact expected totals from the known fixture (claude: 1.5 + 2.25 =
    // 3.75, codex: 0.75, grand total 4.50) — the same numbers
    // `@loombox/shared`'s own `spend-aggregation.test.ts` and
    // `SpendReportPanel.test.ts` prove in isolation, now proven end to
    // end through a real browser against a real (fake) node.
    const total = page.getByTestId('spend-report-total');
    await expect(total).toBeVisible();
    await expect(total).toContainText('$4.50');
    const providers = page.getByTestId('spend-report-providers');
    await expect(providers).toContainText('claude');
    await expect(providers).toContainText('$3.75');
    await expect(providers).toContainText('codex');
    await expect(providers).toContainText('$0.75');

    // No horizontal overflow at the mobile floor (issue #249's explicit
    // acceptance) — the panel's own border box, and its total/breakdown
    // rows, all stay inside the 390px viewport, measured, not guessed
    // (composer-strip.spec.ts's own discipline).
    for (const testId of ['spend-report-panel', 'spend-report-total', 'spend-report-providers']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }

    // Switching the period fires a fresh, differently-bounded request —
    // proven live, not just at initial load.
    await page.getByTestId('spend-report-period-trigger').click();
    await page.getByRole('option', { name: 'Last 7 days' }).click();
    const reload = (await loombox.node.waitFor((message) => {
      if (message.type !== 'spend_report_request') return false;
      return (message as SpendReportRequest).requestId !== request.requestId;
    })) as SpendReportRequest;
    expect(reload.sinceDate).toBeDefined();
  });

  test('a period with nothing recorded reads as an honest "no data" message, never a fabricated $0.00', async ({
    page,
    loombox,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('workbench-toggle').click();
    await page.getByTestId('project-config-toggle').click();
    await expect(page.getByTestId('spend-report-panel')).toBeVisible();

    const request = (await loombox.node.waitFor(
      (message) => message.type === 'spend_report_request',
    )) as SpendReportRequest;

    const projectPath = '/workspace/e2e-project';
    const key = await deriveNodeProjectKey(loombox.amk, loombox.accountId, projectPath);
    const envelope = await nodeSeal(projectPath, { rows: [] }, key);
    loombox.node.send({
      type: 'spend_report_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'e2e-node-daemon',
      projectPath,
      requestId: request.requestId,
      envelope,
    });

    await expect(page.getByTestId('spend-report-no-data')).toBeVisible();
    await expect(page.getByTestId('spend-report-no-data')).toContainText(
      'No spend recorded for this period.',
    );
    await expect(page.getByTestId('spend-report-total')).not.toBeVisible();
    // Scoped to this panel alone — `StatusBar`'s own live session cost
    // meter legitimately shows a real, unrelated `$0.00` elsewhere on
    // this same page (a genuinely-zero-so-far live session total, per
    // that meter's own convention), which a page-wide text search would
    // otherwise collide with.
    await expect(page.getByTestId('spend-report-panel').getByText('$0.00')).not.toBeVisible();
  });
});
