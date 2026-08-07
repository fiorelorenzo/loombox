import type { TrackerConnectivityStateV1 } from '@loombox/protocol';
import type { TrackerBackend, TrackerBinding } from '@loombox/shared';
import { classifyTrackerConnectivityError } from './tracker-connectivity';

/**
 * Polls a live-mode project's `TrackerBackend` reachability (SPEC §7.10
 * "explicit connectivity-error state"; issue #219) — the project-scoped
 * sibling of `ci-check-watcher.ts`'s `CiCheckWatcher`: same fixed-interval,
 * per-key registry, one-pass-at-a-time shape, injected resolver instead of
 * a raw `fetchImpl`. Polled once per PROJECT, never once per session — a
 * project with three open sessions gets one API call per pass, not three;
 * `NodeDaemon` fans the single resulting reading out to every session on
 * that project itself (see `NodeDaemon.pushTrackerConnectivityStatus`'s
 * own doc comment for why delivery is session-scoped even though polling
 * is not).
 *
 * `resolveTarget`'s two-branch result is this watcher's ENTIRE
 * classification surface for the `'authFailed'` bucket that isn't a
 * remote 401/403: a resolution failure (`resolveTrackerBackend` returning
 * `ok: false` — no connected account, no pinned credential, a dangling
 * pin, ...) means there was no credential to even attempt a call with,
 * which is exactly the same "go fix this in Settings" story a remote
 * credential rejection tells, so it is folded into the identical
 * `'authFailed'` state rather than inventing a fourth wire value for it.
 */
export interface TrackerConnectivityWatcherOptions {
  /**
   * Resolves `projectPath`'s current live `TrackerBackend` + binding, or
   * why one couldn't be composed — recomputed fresh on every poll (never
   * cached across passes) so a credential disconnected mid-poll takes
   * effect on the very next one. Called only for a `projectPath` this
   * watcher is currently told to {@link watch} (never for a native-mode
   * project — `NodeDaemon` only watches a project whose saved
   * `TrackerMode.kind === 'live'`). Must never throw — mirrors
   * `resolveTrackerBackend`'s own contract.
   */
  resolveTarget: (projectPath: string) => Promise<TrackerConnectivityTarget>;
  /** How often to repoll every registered project, ms. Defaults to 60s, matching `CiCheckWatcher`'s own default — a live tracker's reachability changes far less often than a resource sample. */
  intervalMs?: number;
  now?: () => number;
  /** Called after every completed poll of a watched project, whatever the resulting state — mirrors `CiCheckWatcher.onUpdate`'s "every pass, not just on change" contract. `NodeDaemon` wires this to fan `tracker_connectivity_status` out to every session on that project. */
  onUpdate?: (projectPath: string, state: TrackerConnectivityStateV1) => void;
}

/** {@link TrackerConnectivityWatcherOptions.resolveTarget}'s result — see that field's own doc comment for the `ok: false` -> `'authFailed'` reasoning. */
export type TrackerConnectivityTarget =
  | {
      readonly ok: true;
      readonly provider: 'github' | 'jira';
      readonly backend: TrackerBackend;
      readonly binding: TrackerBinding;
    }
  | { readonly ok: false; readonly provider: 'github' | 'jira' };

export class TrackerConnectivityWatcher {
  private readonly projectPaths = new Set<string>();
  private readonly latest = new Map<string, TrackerConnectivityStateV1>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly resolveTarget: (projectPath: string) => Promise<TrackerConnectivityTarget>;
  private readonly onUpdate:
    ((projectPath: string, state: TrackerConnectivityStateV1) => void) | undefined;
  private timer?: ReturnType<typeof setInterval>;
  /** Guards against a slow pass overlapping the next tick, same convention as `CiCheckWatcher.inFlight`. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(options: TrackerConnectivityWatcherOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.resolveTarget = options.resolveTarget;
    this.onUpdate = options.onUpdate;
  }

  /** Registers (or re-registers) `projectPath` for polling. Polled from the next pass onward. */
  watch(projectPath: string): void {
    this.projectPaths.add(projectPath);
  }

  /** Stops polling `projectPath` and forgets its last reading — a project switched back to native mode mid-poll never resurfaces a stale reading after this returns (mirrors `CiCheckWatcher.unwatch`'s own guard). */
  unwatch(projectPath: string): void {
    this.projectPaths.delete(projectPath);
    this.latest.delete(projectPath);
  }

  latestFor(projectPath: string): TrackerConnectivityStateV1 | undefined {
    return this.latest.get(projectPath);
  }

  /** Runs one polling pass right now, chained after any pass already in flight so passes never overlap (mirrors `CiCheckWatcher.pollNow`). Resolves once every registered project has been polled. */
  pollNow(): Promise<void> {
    this.inFlight = this.inFlight.then(
      () => this.runPass(),
      () => this.runPass(),
    );
    return this.inFlight;
  }

  private async runPass(): Promise<void> {
    await Promise.all(
      Array.from(this.projectPaths).map((projectPath) => this.pollOne(projectPath)),
    );
  }

  private async pollOne(projectPath: string): Promise<void> {
    const state = await this.probe(projectPath);
    // Unwatched (e.g. the project reverted to native mode) while this poll
    // was in flight — never resurrect an entry in `latest`, and never fire
    // `onUpdate` for a project this watcher was just told to forget.
    if (!this.projectPaths.has(projectPath)) return;
    this.latest.set(projectPath, state);
    this.onUpdate?.(projectPath, state);
  }

  private async probe(projectPath: string): Promise<TrackerConnectivityStateV1> {
    const target = await this.resolveTarget(projectPath);
    if (!target.ok) {
      return { state: 'authFailed', provider: target.provider, updatedAt: this.now() };
    }
    try {
      await target.backend.list(target.binding, { limit: 1 });
      return { state: 'reachable', provider: target.provider, updatedAt: this.now() };
    } catch (error) {
      return {
        state: classifyTrackerConnectivityError(error),
        provider: target.provider,
        updatedAt: this.now(),
      };
    }
  }

  /** Runs an immediate pass, then one every `intervalMs` — mirrors `CiCheckWatcher.start`. */
  start(): void {
    this.pollNow().catch(() => {});
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.pollNow().catch(() => {});
    }, this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
