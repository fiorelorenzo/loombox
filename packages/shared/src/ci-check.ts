/**
 * Pure judgment over a GitHub check-run's own `conclusion` string: is it a
 * real failure worth surfacing (SPEC §7.14; issues #239/#243)? Lives in
 * `@loombox/shared` (not `@loombox/node`, which owns `CiCheckWatcher`'s own
 * copy of this exact vocabulary in `ci-check-watcher.ts` today, used both to
 * aggregate a session's overall `state` and to pick which check runs
 * `NodeDaemon.handleCiCheckFailure`'s auto-iterate hook feeds back to the
 * agent) so `@loombox/web`'s `RelayClient` can name which check run is
 * responsible for a `'ci_failure'` attention-inbox item using the exact
 * same conservative vocabulary, rather than inventing a second,
 * possibly-diverging guess in the browser.
 *
 * Deliberately conservative: a `conclusion` GitHub returns that ISN'T in
 * this set — including any future value this list doesn't yet know about —
 * is never treated as a failure, only reported as-is for a client to render
 * (mirrors `packages/protocol/src/v1/ci-check.ts`'s own "free string, not a
 * closed enum" rationale for `conclusion` itself).
 */
const FAILING_CI_CONCLUSIONS: Record<string, true> = {
  failure: true,
  timed_out: true,
  action_required: true,
  cancelled: true,
};

/** `true` for a GitHub check-run `conclusion` this codebase treats as a failure — see this module's own doc comment for the exact set and why it's conservative. `null` (still running) is never a failure. */
export function isFailingCiConclusion(conclusion: string | null): boolean {
  return conclusion !== null && FAILING_CI_CONCLUSIONS[conclusion] === true;
}
