import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failedSample, type ResourceSample } from './resource-sampler';
import { TargetHealthSampler } from './target-health-sampler';

function sample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    cpuPercent: 10,
    memPercent: 20,
    memUsedBytes: 1,
    memTotalBytes: 2,
    diskPercent: 5,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    healthy: true,
    sampledAt: 0,
    ...overrides,
  };
}

describe('TargetHealthSampler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sampleNow', () => {
    it('samples every registered probe and records its latest reading', async () => {
      const sampler = new TargetHealthSampler();
      sampler.setProbe('local', async () => sample({ cpuPercent: 11 }));
      sampler.setProbe('ssh:devbox', async () => sample({ cpuPercent: 22 }));

      await sampler.sampleNow();

      expect(sampler.latestFor('local')?.cpuPercent).toBe(11);
      expect(sampler.latestFor('ssh:devbox')?.cpuPercent).toBe(22);
    });

    it('returns undefined for a target with no probe registered yet', () => {
      const sampler = new TargetHealthSampler();
      expect(sampler.latestFor('unknown')).toBeUndefined();
    });

    it('records a failed sample for a probe that rejects, without affecting other targets (bounded: one bad target never blocks the rest)', async () => {
      const sampler = new TargetHealthSampler({ now: () => 999 });
      sampler.setProbe('bad', async () => {
        throw new Error('exec failed');
      });
      sampler.setProbe('good', async () => sample({ cpuPercent: 5 }));

      await sampler.sampleNow();

      expect(sampler.latestFor('bad')).toEqual(failedSample(999));
      expect(sampler.latestFor('good')?.cpuPercent).toBe(5);
    });

    it('records a failed sample when a probe exceeds the per-target timeout, without waiting for it (bounded)', async () => {
      vi.useFakeTimers();
      const sampler = new TargetHealthSampler({ timeoutMs: 100, now: () => 555 });
      sampler.setProbe(
        'wedged',
        () => new Promise<ResourceSample>(() => {}), // never resolves
      );
      sampler.setProbe('fine', async () => sample({ cpuPercent: 7 }));

      const pass = sampler.sampleNow();
      await vi.advanceTimersByTimeAsync(150);
      await pass;

      expect(sampler.latestFor('wedged')).toEqual(failedSample(555));
      expect(sampler.latestFor('fine')?.cpuPercent).toBe(7);
    });

    it('calls onSample with the full latest snapshot after each pass', async () => {
      const onSample = vi.fn();
      const sampler = new TargetHealthSampler({ onSample });
      sampler.setProbe('local', async () => sample());

      await sampler.sampleNow();

      expect(onSample).toHaveBeenCalledTimes(1);
      const snapshot = onSample.mock.calls[0][0] as Map<string, ResourceSample>;
      expect(snapshot.get('local')?.cpuPercent).toBe(10);
    });

    it('drops a removed probe from future passes without clearing its last known reading', async () => {
      const sampler = new TargetHealthSampler();
      sampler.setProbe('local', async () => sample());
      await sampler.sampleNow();
      expect(sampler.latestFor('local')).toBeDefined();

      sampler.removeProbe('local');
      await sampler.sampleNow();

      // No probe ran this pass, so the last known reading is untouched — a
      // caller (NodeDaemon) removes a probe when a target is torn down, not
      // when it merely stops responding (that's `healthy: false`'s job).
      expect(sampler.latestFor('local')).toBeDefined();
    });
  });

  describe('start/stop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('samples immediately on start, then again every intervalMs', async () => {
      const sampler = new TargetHealthSampler({ intervalMs: 1000 });
      let calls = 0;
      sampler.setProbe('local', async () => {
        calls += 1;
        return sample();
      });

      sampler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toBe(4);

      sampler.stop();
    });

    it('stop() halts future ticks', async () => {
      const sampler = new TargetHealthSampler({ intervalMs: 1000 });
      let calls = 0;
      sampler.setProbe('local', async () => {
        calls += 1;
        return sample();
      });

      sampler.start();
      await vi.advanceTimersByTimeAsync(0);
      sampler.stop();
      const callsAtStop = calls;

      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(callsAtStop);
    });

    it('stop() is a no-op when never started', () => {
      const sampler = new TargetHealthSampler();
      expect(() => sampler.stop()).not.toThrow();
    });
  });
});
