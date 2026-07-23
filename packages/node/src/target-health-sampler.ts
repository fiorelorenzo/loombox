import { failedSample, type ResourceSample } from './resource-sampler';

export type TargetProbe = () => Promise<ResourceSample>;

export interface TargetHealthSamplerOptions {
  /** How often to resample every registered target, ms. Defaults to 30s — frequent enough for #269's "refreshed on a regular interval" without hammering an `ssh:` host's transport. */
  intervalMs?: number;
  /** Per-target sample timeout, ms — a wedged `ssh:` exec must not block sampling of every other target forever (issue #253's "bounded"). Defaults to 10s. */
  timeoutMs?: number;
  now?: () => number;
  /** Called with the full latest-per-target snapshot after every completed pass (start's immediate pass, and every interval tick thereafter). `NodeDaemon` wires this to push a `target_status` message. */
  onSample?: (samples: ReadonlyMap<string, ResourceSample>) => void;
}

/**
 * Runs every registered target's {@link TargetProbe} on a bounded interval
 * (issue #253's acceptance: "sampled at a regular interval") and keeps the
 * latest reading per target, for `NodeDaemon` to push out as `target_status`
 * and (later, #252) for concurrency-governance logic to read. "Bounded"
 * cuts two ways: a probe that rejects or exceeds {@link TargetHealthSamplerOptions.timeoutMs}
 * degrades to {@link failedSample} for that target only — one wedged `ssh:`
 * target can never stall or blank out every other target's reading, and a
 * new pass never overlaps a still-running one (each tick awaits the
 * previous pass via the same in-flight promise `start`'s `setInterval`
 * callback reuses).
 */
export class TargetHealthSampler {
  private readonly probes = new Map<string, TargetProbe>();
  private readonly latest = new Map<string, ResourceSample>();
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onSample?: (samples: ReadonlyMap<string, ResourceSample>) => void;
  private timer?: ReturnType<typeof setInterval>;
  /** Guards against a slow pass overlapping the next tick — `sampleNow` calls chain onto this rather than running concurrently. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(options: TargetHealthSamplerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.onSample = options.onSample;
  }

  /** Registers (or replaces) the probe for `targetId`. Sampled from the next pass onward — `local` typically registered once at construction, `ssh:` targets registered/removed as `NodeDaemon`'s target list changes. */
  setProbe(targetId: string, probe: TargetProbe): void {
    this.probes.set(targetId, probe);
  }

  /** Stops sampling `targetId` from the next pass onward. Deliberately leaves its last known reading in {@link latestFor} — a removed target (torn down, not just unreachable) simply stops refreshing rather than snapping to a misleading all-zero `failedSample`; the caller (`NodeDaemon`) is expected to also drop it from what it reports if it no longer exists at all. */
  removeProbe(targetId: string): void {
    this.probes.delete(targetId);
  }

  latestFor(targetId: string): ResourceSample | undefined {
    return this.latest.get(targetId);
  }

  /** Every target's latest reading, keyed by targetId. */
  snapshot(): ReadonlyMap<string, ResourceSample> {
    return this.latest;
  }

  /** Runs one sampling pass right now, chained after any pass already in flight so passes never overlap. Resolves once every registered probe has settled (successfully, rejected, or timed out) and {@link latest} reflects the results. */
  sampleNow(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.runPass());
    return this.inFlight;
  }

  private async runPass(): Promise<void> {
    const entries = Array.from(this.probes.entries());
    await Promise.allSettled(
      entries.map(async ([targetId, probe]) => {
        const result = await this.runWithTimeout(probe);
        this.latest.set(targetId, result);
      }),
    );
    this.onSample?.(this.latest);
  }

  private async runWithTimeout(probe: TargetProbe): Promise<ResourceSample> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ResourceSample>((resolve) => {
      timer = setTimeout(() => resolve(failedSample(this.now())), this.timeoutMs);
    });
    try {
      return await Promise.race([probe().catch(() => failedSample(this.now())), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs an immediate pass, then one every `intervalMs` — idempotent-ish (a second `start()` call before `stop()` replaces the timer without running a duplicate immediate pass's worth of overlap, since {@link sampleNow} always chains onto `inFlight`). */
  start(): void {
    this.stop();
    void this.sampleNow();
    this.timer = setInterval(() => {
      void this.sampleNow();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
