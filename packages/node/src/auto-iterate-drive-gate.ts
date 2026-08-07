/**
 * The shared "have we already driven this exact commit's fix attempt"
 * memory `NodeDaemon` consults from BOTH `handleCiCheckFailure` (SPEC
 * §7.14; issue #239) and its own local-runner counterpart,
 * `driveAutoIterateFromRunFailure` (SPEC §7.15; issue #247), before ever
 * calling `CiAutoIterateController.onFailure` — the single piece of state
 * that keeps a CI failure and a local runner failure for the very same
 * commit from driving two separate agent turns for what is really one
 * underlying failing change (issue #247's own "should not be driven
 * twice" acceptance line).
 *
 * Keyed on `sessionId` + the failing commit's own head sha (CI's
 * `CiCheckStateV1.headSha`, or the runner's own `resolveWorkspaceHeadSha`
 * reading) — genuinely independent of WHICH source observed it first:
 * whichever of CI/the runner calls `shouldDrive` first for a given sha
 * wins, and the other source's own failure for that identical sha still
 * updates ITS OWN status/inbox item (`CiCheckWatcher`/`RunStatusTracker`
 * track those independently), it just never fires a second
 * `promptSession` turn for it.
 *
 * Lifetime is tied to `CiAutoIterateController`'s own active-loop
 * lifetime, not `CiCheckWatcher`'s separate (and shorter-lived) per-poll
 * dedup: `NodeDaemon` calls `clear()` from the exact same three sites it
 * already calls `reset()`/`onGreen()`/`forget()` on the controller
 * itself (a fresh PR watch, a genuinely green check, and session
 * archival) — so a sha this gate is currently suppressing stays
 * suppressed for exactly as long as the controller's own attempt count
 * for it would otherwise keep growing, and clears exactly when that
 * count does too.
 *
 * A missing/placeholder sha (`undefined`, or the `'unknown'` fallback
 * `handleCiCheckFailure` already used before this gate existed for a CI
 * reading with no check runs yet) is never remembered and never
 * suppresses anything — there is nothing meaningful to compare it
 * against, so every such call always drives.
 */
export class AutoIterateDriveGate {
  private readonly lastDrivenSha = new Map<string, string>();

  /** `true` the first time `sessionId` sees `headSha` since the last `clear()`, `false` every later call for that same pair — and records the sha as seen either way (a falsy/`'unknown'` sha is never recorded, so it can never suppress a later real one). */
  shouldDrive(sessionId: string, headSha: string | undefined): boolean {
    if (!headSha || headSha === 'unknown') return true;
    if (this.lastDrivenSha.get(sessionId) === headSha) return false;
    this.lastDrivenSha.set(sessionId, headSha);
    return true;
  }

  /** Forgets `sessionId`'s remembered sha — see this class's own doc comment for the three call sites this mirrors. */
  clear(sessionId: string): void {
    this.lastDrivenSha.delete(sessionId);
  }
}
