import type { RunExitOutcomeV1 } from '@loombox/protocol';

/**
 * Pure judgment over a test/lint/build run's own terminal `outcome`: is it
 * a real failure worth surfacing (SPEC §7.14/§7.15; issue #247)? Lives in
 * `@loombox/shared`, the runner's own sibling of `ci-check.ts`'s
 * `isFailingCiConclusion`, so `@loombox/node` (`RunStatusTracker`'s own
 * aggregate `state`, and `NodeDaemon`'s auto-iterate hook) and
 * `@loombox/web` (`RelayClient`'s `'run_failure'` attention-inbox item)
 * name the exact same runs as failing, rather than each guessing
 * separately.
 *
 * Unlike `isFailingCiConclusion`'s deliberately narrow allowlist over an
 * OPEN, externally-defined vocabulary (GitHub's own check-run
 * conclusions), `RunExitOutcomeV1` is already a CLOSED, this-codebase-owned
 * enum (`'pass' | 'fail' | 'could_not_start'`, `@loombox/protocol`'s own
 * `test-runner.ts`) — so this is simply "not a pass", never a second,
 * possibly-diverging allowlist to keep in sync.
 */
export function isFailingRunOutcome(outcome: RunExitOutcomeV1): boolean {
  return outcome !== 'pass';
}
