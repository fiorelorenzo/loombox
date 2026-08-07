import { compareBuildVersions } from '@loombox/protocol';

import type { RemoteTransport } from './remote-transport';
import {
  planSupervisorProvisioning,
  executeSupervisorProvisioning,
  readRemoteSupervisorVersion,
  resolveSupervisorBaseDir,
  type PlanSupervisorProvisioningOptions,
  type SupervisorProvisionResult,
} from './supervisor-provisioning';

/**
 * Detecting an out-of-date `ssh:` target and offering a one-tap update
 * (issue #88; SPEC §7.23 "Keeping targets current" / §10's protocol version
 * handshake pattern). This module adds no new remote-side mechanism: the
 * "handshake" is a read of the same `VERSION` marker issue #87's idempotent
 * provisioning already writes (`readRemoteSupervisorVersion`,
 * `supervisor-provisioning.ts`), and "update this target" is exactly issue
 * #87's plan-then-execute flow, just triggered from here. What this module
 * *does* add is the comparison/tracking layer on top: a `current` /
 * `behind` / `ahead` / `unknown` verdict per target, kept queryable so a
 * caller (a future status API/PWA affordance) can render "update this
 * target" without re-querying the remote on every render.
 */
export type TargetVersionStatus = 'current' | 'behind' | 'ahead' | 'unknown';

/**
 * Segment-by-segment dotted-numeric version comparison — re-exported from
 * `@loombox/protocol`'s `compareBuildVersions` (issue #657) rather than
 * kept as a second, independently-maintained copy of the same algorithm.
 * That package is a dependency-direction-safe home for it (both this
 * package and `@loombox/relay` already depend on `@loombox/protocol`, and
 * the relay's own compatibility-window floor check, issue #657, needed the
 * identical arithmetic). Behavior unchanged: see `compareBuildVersions`'s
 * own doc comment for the exact rules (numeric segments compared as
 * numbers, a whole-string fallback the moment either side has a
 * non-numeric segment).
 */
export const compareVersions = compareBuildVersions;

/** Issue #88's version-comparison logic: `undefined` (never handshaked, or nothing staged) is `'unknown'`, never guessed at as current or behind. */
export function compareTargetVersion(
  remoteVersion: string | undefined,
  pinnedVersion: string,
): TargetVersionStatus {
  if (remoteVersion === undefined) return 'unknown';
  const cmp = compareVersions(remoteVersion, pinnedVersion);
  if (cmp === 0) return 'current';
  return cmp < 0 ? 'behind' : 'ahead';
}

export interface TargetVersionHandshakeResult {
  targetId: string;
  remoteVersion: string | undefined;
  pinnedVersion: string;
  status: TargetVersionStatus;
  checkedAt: number;
}

export interface TargetUpdateMonitorOptions {
  /** This node's current pinned supervisor version — every handshake compares against this. */
  pinnedVersion: string;
  /** Injectable clock for tests; defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * Tracks each `ssh:` target's out-of-date status against one pinned version
 * (issue #88). `handshake()` is cheap (one remote read) and safe to call as
 * often as a caller likes — on every reconnect, on a periodic poll, or
 * on-demand before rendering a target's status; `statusFor`/`isOutdated`/
 * `listOutdated` are pure reads of the last handshake result, so a client
 * can render a one-tap "update this target" affordance without hitting the
 * remote itself.
 */
export class TargetUpdateMonitor {
  private readonly pinnedVersion: string;
  private readonly clock: () => number;
  private readonly results = new Map<string, TargetVersionHandshakeResult>();

  constructor(options: TargetUpdateMonitorOptions) {
    this.pinnedVersion = options.pinnedVersion;
    this.clock = options.clock ?? Date.now;
  }

  /** Reads `targetId`'s remote supervisor version and records the comparison against this monitor's pinned version. `baseDir` defaults to the standard `$HOME/.loombox/supervisor` resolution (see `supervisor-provisioning.ts`). */
  async handshake(
    targetId: string,
    transport: RemoteTransport,
    baseDir?: string,
  ): Promise<TargetVersionHandshakeResult> {
    const resolvedBaseDir = baseDir ?? (await resolveSupervisorBaseDir(transport));
    const remoteVersion = await readRemoteSupervisorVersion(transport, resolvedBaseDir);
    const status = compareTargetVersion(remoteVersion, this.pinnedVersion);
    const result: TargetVersionHandshakeResult = {
      targetId,
      remoteVersion,
      pinnedVersion: this.pinnedVersion,
      status,
      checkedAt: this.clock(),
    };
    this.results.set(targetId, result);
    return result;
  }

  /** The last recorded handshake result for `targetId`, or `undefined` if it has never been handshaked. */
  statusFor(targetId: string): TargetVersionHandshakeResult | undefined {
    return this.results.get(targetId);
  }

  /** `true` only once a handshake has recorded this target as strictly `'behind'` — never guesses `true` for `'unknown'`. */
  isOutdated(targetId: string): boolean {
    return this.results.get(targetId)?.status === 'behind';
  }

  /** Every target currently recorded as `'behind'`, most-recently-checked order not guaranteed — a caller renders this list as the "update available" set. */
  listOutdated(): TargetVersionHandshakeResult[] {
    return [...this.results.values()].filter((result) => result.status === 'behind');
  }

  /**
   * The "update this target" one-tap action (issue #88): re-runs issue
   * #87's idempotent plan-then-execute provisioning flow for `targetId`
   * against this monitor's pinned version, then immediately re-handshakes
   * so `statusFor`/`isOutdated` reflect the outcome without the caller
   * having to remember to re-check. `options` is exactly
   * `PlanSupervisorProvisioningOptions` minus `targetVersion` (this monitor
   * supplies that itself, so a caller can never accidentally update a
   * target to a version other than the one it's tracking outdatedness
   * against).
   */
  async updateTarget(
    targetId: string,
    transport: RemoteTransport,
    options: Omit<PlanSupervisorProvisioningOptions, 'targetVersion'>,
  ): Promise<SupervisorProvisionResult> {
    const plan = await planSupervisorProvisioning(transport, {
      ...options,
      targetVersion: this.pinnedVersion,
    });
    const result = await executeSupervisorProvisioning(transport, plan);
    await this.handshake(targetId, transport, plan.baseDir);
    return result;
  }
}
