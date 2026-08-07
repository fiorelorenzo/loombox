import type { InstallLayoutDriver } from './install-layout';
import {
  applyNodeSelfUpdate,
  evaluateNodeUpdateStatus,
  type NodeSelfUpdateOutcome,
  type NodeUpdateSource,
  type NodeUpdateStatus,
} from './self-update';

/** `NodeSelfUpdateMonitor`'s own snapshot — mirrors `@loombox/protocol`'s `NodeSelfUpdateSummaryV1` field-for-field; `NodeDaemon` sends it as-is. */
export interface NodeSelfUpdateSummary {
  status: NodeUpdateStatus;
  currentVersion: string;
  latestVersion: string | undefined;
  checkedAt: number;
}

export interface NodeSelfUpdateMonitorOptions {
  source: NodeUpdateSource;
  /** This node's own currently-running version — every check compares against this, exactly like `TargetUpdateMonitor`'s own `pinnedVersion`. */
  currentVersion: string;
  /** How often {@link NodeSelfUpdateMonitor.start} re-checks while running. Defaults to 6 hours — a new node release is a rare event, so this only needs to notice "eventually", not promptly; the real-time path is the check this class always runs immediately on `start()` (mirrors a fresh connect). */
  intervalMs?: number;
  /** Fired after every completed check (success or failure) — `NodeDaemon`'s hook to push `node_self_update_status` (issue #656). */
  onUpdate?: (summary: NodeSelfUpdateSummary) => void;
  /** Injectable clock for tests; defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * Periodically checks whether a newer `@loombox/node` version is
 * available (issue #656), and (mirrors `TargetUpdateMonitor`'s own
 * `updateTarget`) drives the "Update" one-tap action against it via
 * `applyNodeSelfUpdate`. `start()`/`stop()` own the polling interval
 * exactly like `CiCheckWatcher`'s own lifecycle — `NodeDaemon` constructs
 * one, starts it alongside its other pollers, and stops it in `close()`.
 *
 * `checkLatest()` failing (a real network/parse error, not merely
 * "nothing newer") never throws out of {@link checkNow} — it degrades the
 * status to `'unknown'`, the same "absence never reads as an answer"
 * contract `evaluateNodeUpdateStatus` itself keeps, so a transient GitHub
 * hiccup never gets rendered as "you are up to date" by mistake.
 */
export class NodeSelfUpdateMonitor {
  private readonly source: NodeUpdateSource;
  private readonly currentVersion: string;
  private readonly intervalMs: number;
  private readonly onUpdate: ((summary: NodeSelfUpdateSummary) => void) | undefined;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | undefined;
  private latest: NodeSelfUpdateSummary | undefined;

  constructor(options: NodeSelfUpdateMonitorOptions) {
    this.source = options.source;
    this.currentVersion = options.currentVersion;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.onUpdate = options.onUpdate;
    this.clock = options.clock ?? Date.now;
  }

  /** Runs an immediate check, then re-checks every `intervalMs` until {@link stop}. The interval timer is `unref()`d so a still-running monitor never keeps this node's process alive on its own. */
  start(): void {
    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one check now, records it, and fires `onUpdate` — safe to call as often as a caller likes (a fresh relay connect, an operator-triggered refresh), same convention as `TargetUpdateMonitor.handshake`. */
  async checkNow(): Promise<NodeSelfUpdateSummary> {
    let latestVersion: string | undefined;
    try {
      latestVersion = (await this.source.checkLatest())?.version;
    } catch {
      // A real fetch failure (network, malformed response) degrades to
      // 'unknown' below rather than throwing — see this class's own doc
      // comment.
      latestVersion = undefined;
    }
    const summary: NodeSelfUpdateSummary = {
      status: evaluateNodeUpdateStatus(this.currentVersion, latestVersion),
      currentVersion: this.currentVersion,
      latestVersion,
      checkedAt: this.clock(),
    };
    this.latest = summary;
    this.onUpdate?.(summary);
    return summary;
  }

  /** The last recorded check, or `undefined` before the first one completes. */
  statusFor(): NodeSelfUpdateSummary | undefined {
    return this.latest;
  }

  /**
   * The "Update" one-tap action: applies the version this monitor's last
   * check found, via `applyNodeSelfUpdate` — never an arbitrary caller-
   * supplied version, mirroring `@loombox/protocol`'s
   * `nodeSelfUpdateApplyRequest` having no `targetVersion` field of its
   * own for the exact same reason. Refuses up front (without ever calling
   * `source.fetch`) when the last check never completed, or found nothing
   * newer — "nothing updates without an explicit action" cuts both ways:
   * an explicit action with nothing to act on is a no-op, not a re-check.
   * Re-checks once the attempt settles either way, so `statusFor()`
   * reflects the outcome without the caller having to remember to ask
   * again.
   */
  async applyUpdate(options: {
    baseDir: string;
    driver: InstallLayoutDriver;
    publicKey?: Uint8Array;
    restart: () => void | Promise<void>;
    runVersionProbe?: (entryPath: string) => Promise<string>;
    probeTimeoutMs?: number;
  }): Promise<NodeSelfUpdateOutcome> {
    const targetVersion = this.latest?.latestVersion;
    if (this.latest?.status !== 'update_available' || !targetVersion) {
      return {
        ok: false,
        action: 'fetch_failed',
        fromVersion: this.currentVersion,
        message: 'no newer node version is currently known — nothing to update to',
      };
    }

    const outcome = await applyNodeSelfUpdate({
      baseDir: options.baseDir,
      driver: options.driver,
      source: this.source,
      currentVersion: this.currentVersion,
      targetVersion,
      publicKey: options.publicKey,
      restart: options.restart,
      runVersionProbe: options.runVersionProbe,
      probeTimeoutMs: options.probeTimeoutMs,
    });
    await this.checkNow();
    return outcome;
  }
}
