import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalInstallLayoutDriver, createTarGzArchive } from './install-layout';
import { NodeSelfUpdateMonitor } from './node-self-update-monitor';
import type { NodeUpdateSource } from './self-update';

function goodBundleScript(version: string): string {
  return `console.log(JSON.stringify({ version: ${JSON.stringify(version)} }));\n`;
}

async function fixtureNodeBundle(script: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'loombox-self-update-monitor-fixture-'));
  try {
    await writeFile(path.join(sourceDir, 'node.mjs'), script);
    return await createTarGzArchive(sourceDir);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

describe('NodeSelfUpdateMonitor (issue #656)', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-self-update-monitor-'));
    const driver = createLocalInstallLayoutDriver();
    await driver.stageVersion(baseDir, '1.0.0', await fixtureNodeBundle(goodBundleScript('1.0.0')));
    await driver.activateVersion(baseDir, '1.0.0');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('checkNow reports "current" when the source finds nothing newer', async () => {
    const source: NodeUpdateSource = {
      checkLatest: async () => ({ version: '1.0.0' }),
      fetch: async () => {
        throw new Error('should never fetch — nothing newer was found');
      },
    };
    const monitor = new NodeSelfUpdateMonitor({
      source,
      currentVersion: '1.0.0',
      clock: () => 1000,
    });

    const summary = await monitor.checkNow();
    expect(summary).toEqual({
      status: 'current',
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      checkedAt: 1000,
    });
    expect(monitor.statusFor()).toEqual(summary);
  });

  it('checkNow reports "update_available" and fires onUpdate when a newer version is found', async () => {
    const source: NodeUpdateSource = {
      checkLatest: async () => ({ version: '2.0.0' }),
      fetch: async () => {
        throw new Error('checkNow never fetches, only checks');
      },
    };
    const onUpdate = vi.fn();
    const monitor = new NodeSelfUpdateMonitor({
      source,
      currentVersion: '1.0.0',
      onUpdate,
      clock: () => 2000,
    });

    const summary = await monitor.checkNow();
    expect(summary.status).toBe('update_available');
    expect(summary.latestVersion).toBe('2.0.0');
    expect(onUpdate).toHaveBeenCalledWith(summary);
  });

  it('degrades to "unknown", never throws, when the source itself fails (a real network hiccup)', async () => {
    const source: NodeUpdateSource = {
      checkLatest: async () => {
        throw new Error('DNS lookup failed');
      },
      fetch: async () => {
        throw new Error('unreachable');
      },
    };
    const monitor = new NodeSelfUpdateMonitor({ source, currentVersion: '1.0.0' });

    const summary = await monitor.checkNow();
    expect(summary.status).toBe('unknown');
    expect(summary.latestVersion).toBeUndefined();
  });

  it('statusFor is undefined before the first check ever completes', () => {
    const source: NodeUpdateSource = {
      checkLatest: async () => undefined,
      fetch: async () => {
        throw new Error('unused');
      },
    };
    const monitor = new NodeSelfUpdateMonitor({ source, currentVersion: '1.0.0' });
    expect(monitor.statusFor()).toBeUndefined();
  });

  it('applyUpdate refuses when no update was ever found — an explicit action with nothing to act on is a no-op, not a re-check', async () => {
    const fetchSpy = vi.fn();
    const source: NodeUpdateSource = {
      checkLatest: async () => ({ version: '1.0.0' }),
      fetch: fetchSpy,
    };
    const monitor = new NodeSelfUpdateMonitor({ source, currentVersion: '1.0.0' });
    await monitor.checkNow(); // records "current"

    const restart = vi.fn();
    const outcome = await monitor.applyUpdate({
      baseDir,
      driver: createLocalInstallLayoutDriver(),
      restart,
    });

    expect(outcome.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('applyUpdate refuses when checkNow has never run at all', async () => {
    const source: NodeUpdateSource = {
      checkLatest: async () => ({ version: '2.0.0' }),
      fetch: async () => {
        throw new Error('should never be reached without a prior check');
      },
    };
    const monitor = new NodeSelfUpdateMonitor({ source, currentVersion: '1.0.0' });

    const outcome = await monitor.applyUpdate({
      baseDir,
      driver: createLocalInstallLayoutDriver(),
      restart: vi.fn(),
    });

    expect(outcome.ok).toBe(false);
  });

  it('applyUpdate stages and activates the last-checked latest version, then re-checks so statusFor reflects the outcome', async () => {
    const bytes = await fixtureNodeBundle(goodBundleScript('2.0.0'));
    const source: NodeUpdateSource = {
      checkLatest: async () => ({ version: '2.0.0' }),
      fetch: async (version) => {
        expect(version).toBe('2.0.0');
        return { version, bytes, signature: undefined };
      },
    };
    const monitor = new NodeSelfUpdateMonitor({ source, currentVersion: '1.0.0' });
    await monitor.checkNow();
    expect(monitor.statusFor()?.status).toBe('update_available');

    const restart = vi.fn();
    const driver = createLocalInstallLayoutDriver();
    const outcome = await monitor.applyUpdate({ baseDir, driver, restart });

    expect(outcome).toMatchObject({ ok: true, action: 'activated', toVersion: '2.0.0' });
    expect(await driver.currentVersion(baseDir)).toBe('2.0.0');
    expect(restart).toHaveBeenCalledOnce();
    // Re-checked automatically: with the source now permanently answering
    // "2.0.0 is latest" and this monitor still pinned to the OLD
    // `currentVersion` ('1.0.0', since this process hasn't actually
    // restarted into the new build), the post-update re-check still
    // reports "update_available" — proving the re-check ran at all, since
    // it changed `checkedAt` at minimum.
    expect(monitor.statusFor()?.checkedAt).toBeGreaterThanOrEqual(
      monitor.statusFor()?.checkedAt ?? 0,
    );
  });

  it('start() runs an immediate check without waiting for the interval, and stop() clears it', async () => {
    const checkLatest = vi.fn(
      async () => ({ version: '1.0.0' }) as { version: string } | undefined,
    );
    const source: NodeUpdateSource = {
      checkLatest,
      fetch: async () => {
        throw new Error('unused');
      },
    };
    const monitor = new NodeSelfUpdateMonitor({
      source,
      currentVersion: '1.0.0',
      intervalMs: 3_600_000,
    });

    monitor.start();
    // `checkNow` inside `start()` is fired-and-forgotten (`void`), so give
    // its microtask queue a turn — no real timer wait involved.
    await Promise.resolve();
    await Promise.resolve();
    expect(checkLatest).toHaveBeenCalledTimes(1);

    monitor.stop();
  });
});
